import { createHash, randomUUID } from 'node:crypto'

import type { ArtifactMimeType } from './protocol.js'
import type { CompletedArtifactDraft } from './service.js'
import { validateArtifactSyntax } from './outline.js'

export type ArtifactPatchErrorCode =
  | 'PATCH_INVALID_FORMAT'
  | 'PATCH_WRONG_ARTIFACT'
  | 'PATCH_SEARCH_NOT_FOUND'
  | 'PATCH_SEARCH_NOT_UNIQUE'
  | 'PATCH_HUNKS_OVERLAP'
  | 'PATCH_SYNTAX_INVALID'

export class ArtifactPatchError extends Error {
  constructor(
    readonly code: ArtifactPatchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactPatchError'
  }
}

type PatchHunk = {
  search: string
  replacement: string
}

export function parseArtifactPatch(
  output: string,
  expectedLogicalId: string,
): PatchHunk[] {
  if (Buffer.byteLength(output, 'utf8') > 64 * 1024) {
    throw new ArtifactPatchError(
      'PATCH_INVALID_FORMAT',
      'Patch response exceeds 64 KiB.',
    )
  }
  const envelope = /^\s*<artifact_edit\s+id="([a-z0-9][a-z0-9._-]{0,63})">\s*([\s\S]*?)\s*<\/artifact_edit>\s*$/u.exec(
    output,
  )
  if (!envelope) {
    throw new ArtifactPatchError(
      'PATCH_INVALID_FORMAT',
      'Expected exactly one artifact_edit block.',
    )
  }
  if (envelope[1] !== expectedLogicalId) {
    throw new ArtifactPatchError(
      'PATCH_WRONG_ARTIFACT',
      `Patch targets ${envelope[1]}, expected ${expectedLogicalId}.`,
    )
  }

  const body = envelope[2]
  const hunkPattern = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g
  const hunks: PatchHunk[] = []
  let cursor = 0
  for (const match of body.matchAll(hunkPattern)) {
    if (body.slice(cursor, match.index).trim()) {
      throw new ArtifactPatchError(
        'PATCH_INVALID_FORMAT',
        'Unexpected text outside patch hunks.',
      )
    }
    const search = match[1]
    const lineCount = search.split(/\r?\n/).length
    if (lineCount < 10 || lineCount > 30) {
      throw new ArtifactPatchError(
        'PATCH_INVALID_FORMAT',
        'Each SEARCH excerpt must contain 10-30 lines.',
      )
    }
    hunks.push({ search, replacement: match[2] })
    cursor = (match.index ?? 0) + match[0].length
  }
  if (body.slice(cursor).trim() || hunks.length === 0 || hunks.length > 8) {
    throw new ArtifactPatchError(
      'PATCH_INVALID_FORMAT',
      'Patch must contain between one and eight valid hunks.',
    )
  }
  return hunks
}

export function applyArtifactPatch(
  content: string,
  hunks: PatchHunk[],
  mimeType: ArtifactMimeType,
): string {
  const located = hunks.map((hunk) => {
    const start = content.indexOf(hunk.search)
    if (start < 0) {
      throw new ArtifactPatchError(
        'PATCH_SEARCH_NOT_FOUND',
        'A SEARCH excerpt does not occur in the current version.',
      )
    }
    if (content.indexOf(hunk.search, start + 1) >= 0) {
      throw new ArtifactPatchError(
        'PATCH_SEARCH_NOT_UNIQUE',
        'A SEARCH excerpt occurs more than once in the current version.',
      )
    }
    return {
      ...hunk,
      start,
      end: start + hunk.search.length,
    }
  }).sort((left, right) => left.start - right.start)

  for (let index = 1; index < located.length; index += 1) {
    if (located[index].start < located[index - 1].end) {
      throw new ArtifactPatchError(
        'PATCH_HUNKS_OVERLAP',
        'Patch hunks overlap.',
      )
    }
  }

  let patched = content
  for (const hunk of [...located].reverse()) {
    patched = `${patched.slice(0, hunk.start)}${hunk.replacement}${patched.slice(hunk.end)}`
  }
  try {
    validateArtifactSyntax(patched, mimeType)
  } catch (error) {
    throw new ArtifactPatchError(
      'PATCH_SYNTAX_INVALID',
      error instanceof Error ? error.message : 'Patched Artifact is invalid.',
    )
  }
  return patched
}

export function createPatchedArtifactDraft(input: {
  output: string
  logicalId: string
  title: string
  type: ArtifactMimeType
  baseVersion: number
  content: string
}): CompletedArtifactDraft {
  const hunks = parseArtifactPatch(input.output, input.logicalId)
  const content = applyArtifactPatch(input.content, hunks, input.type)
  return {
    streamArtifactId: randomUUID(),
    metadata: {
      v: '1',
      id: input.logicalId,
      op: 'replace',
      type: input.type,
      title: input.title,
      base_version: input.baseVersion,
    },
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}
