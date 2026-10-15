import assert from 'node:assert/strict'
import test from 'node:test'

import { drizzle } from 'drizzle-orm/node-postgres'

import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import * as schema from '../db/schema.js'
import { CharacterTokenCounter } from '../tokenBudget.js'
import {
  ARTIFACT_PATCH_MIN_BYTES,
  assembleArtifactContext,
  type SelectArtifactSections,
} from './context.js'
import { parseSectionSelection } from './sectionSelector.js'
import type { ArtifactService } from './service.js'

const artifactId = '00000000-0000-4000-8000-0000000000a1'

function database(content: string, type = 'text/markdown'): Database {
  const client = {
    async query(config: { text: string }) {
      if (config.text.includes('from "Artifact"')) {
        // id, logicalId, title, type, currentVersion, byteLength, updatedAt
        return { rows: [[artifactId, 'report', '分析报告', type, 3, String(Buffer.byteLength(content)), new Date()]] }
      }
      throw new Error(`Unexpected query: ${config.text}`)
    },
  }
  return drizzle(client as never, { schema }) as unknown as Database
}

const service = (content: string | null) => ({
  readVersionContent: async () => content,
}) as unknown as ArtifactService

const config = (overrides: Partial<AppConfig> = {}) => ({
  artifactPatchEnabled: true,
  artifactProtocolTokenBudget: 8_192,
  artifactFullContentTokenBudget: 60_000,
  artifactOutlineTokenBudget: 4_000,
  artifactFragmentTokenBudget: 20_000,
  ...overrides,
}) as AppConfig

/** Markdown with `count` sections of about `size` characters each. */
function markdown(count: number, size: number): string {
  return Array.from({ length: count }, (_, index) =>
    `# 第${index + 1}节\n${`内容${index + 1} `.repeat(Math.ceil(size / 4)).slice(0, size)}\n`).join('')
}

async function assemble(content: string | null, options: {
  config?: Partial<AppConfig>
  selectSections?: SelectArtifactSections
  tokenBudget?: number
  bytes?: string
} = {}) {
  return assembleArtifactContext(database(options.bytes ?? content ?? ''), {
    config: config(options.config),
    artifactService: service(content),
    tokenCounter: new CharacterTokenCounter(),
    selectSections: options.selectSections ?? (async () => { throw new Error('not expected') }),
    userId: '00000000-0000-4000-8000-000000000001',
    chatId: '00000000-0000-4000-8000-000000000002',
    prompt: '修改报告',
    artifactId,
    tokenBudget: options.tokenBudget ?? 200_000,
  })
}

test('a small Artifact is attached whole and may be replaced', async () => {
  const content = markdown(2, 100)
  const result = await assemble(content)
  assert.equal(result.selectedArtifact?.status, 'full_content_attached')
  assert.equal(result.selectedArtifact?.edit, 'replace')
  assert.equal(result.selectedArtifact?.content, content)
  assert.match(result.instructions, /edit="replace"/)
  assert.match(result.instructions, /Current complete content \(JSON string; decode it before producing a replacement\)/)
})

test('a mid-size Artifact is attached whole but edited by patch, or read-only without patching', async () => {
  const content = markdown(12, 3_000)
  assert.ok(Buffer.byteLength(content) >= ARTIFACT_PATCH_MIN_BYTES)
  const patched = await assemble(content)
  assert.equal(patched.selectedArtifact?.status, 'full_content_attached')
  assert.equal(patched.selectedArtifact?.edit, 'patch')
  assert.match(patched.instructions, /edit="patch"[\s\S]*Edit this item only with the large Artifact patch protocol/)

  const readOnly = await assemble(content, { config: { artifactPatchEnabled: false } })
  assert.equal(readOnly.selectedArtifact?.edit, 'none')
  assert.match(readOnly.instructions, /edit="none"[\s\S]*read-only: do not edit this item/)
})

test('a large Artifact gets its outline and the sections the model picks, in document order', async () => {
  const content = markdown(30, 3_000)
  const requests: Parameters<SelectArtifactSections>[0][] = []
  const result = await assemble(content, {
    config: { artifactFullContentTokenBudget: 10_000 },
    selectSections: async (request) => {
      requests.push(request)
      return [7, 2, 999, 2]
    },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].maxSections, 8)
  assert.equal(requests[0].sections.length, 30)
  assert.equal(requests[0].sections[7].headingPath, '第8节')
  assert.equal(result.selectedArtifact?.status, 'outline_fragments_attached')
  assert.equal(result.selectedArtifact?.edit, 'patch')
  assert.equal(result.selectedArtifact?.content, null)
  const fragments = [...result.instructions.matchAll(/Fragment \[\d+-\d+\] "([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(fragments, ['第3节', '第8节'])
  assert.match(result.instructions, /Structural outline \(only the fragments below are attached\):\n\[0-/)
})

test('a failed section choice falls back to the start of the document within the fragment budget', async () => {
  const content = markdown(30, 3_000)
  const result = await assemble(content, {
    config: { artifactFullContentTokenBudget: 10_000, artifactFragmentTokenBudget: 7_000 },
    selectSections: async () => { throw new Error('model unavailable') },
  })
  const fragments = [...result.instructions.matchAll(/Fragment \[\d+-\d+\] "([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(fragments, ['第1节', '第2节'])
})

test('an Artifact that cannot fit the instruction budget is offered as metadata only', async () => {
  const content = markdown(4, 3_000)
  const result = await assemble(content, { tokenBudget: 8_000 })
  assert.equal(result.selectedArtifact?.status, 'metadata_only')
  assert.equal(result.selectedArtifact?.edit, 'none')
  assert.doesNotMatch(result.instructions, /内容1/)
})

test('unreadable content is offered as metadata only', async () => {
  const result = await assemble(null, { bytes: markdown(1, 10) })
  assert.equal(result.selectedArtifact?.status, 'metadata_only')
  assert.equal(result.selectedArtifact?.edit, 'none')
})

test('section selection keeps known, distinct integer ordinals in the model order', () => {
  const known = new Set([0, 1, 2, 3])
  assert.deepEqual(parseSectionSelection('```json\n{"sections":[3,1,3,9,"2",1.5,0]}\n```', known), [3, 1, 0])
  assert.throws(() => parseSectionSelection('{"chosen":[1]}', known), /no sections array/)
})
