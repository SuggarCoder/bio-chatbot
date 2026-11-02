import assert from 'node:assert/strict'
import test from 'node:test'

import { drizzle } from 'drizzle-orm/node-postgres'

import {
  buildUserMemoryInstructions,
  countUserMemoryTokens,
  type UserMemoryEntry,
} from './userMemory.js'
import type { Database } from './db.js'
import * as schema from './db/schema.js'
import {
  missingSummarySections,
  normalizeSummary,
  parseConsolidatedMemories,
  parseExtraction,
  parseMemoryOperations,
} from './memoryWorker.js'
import { CharacterTokenCounter } from './tokenBudget.js'

const fullSummary = [
  '## 用户目标', 'a',
  '## 已做决定', 'b',
  '## 关键实体与数字', 'c',
  '## Artifact 演进', 'd',
  '## 待办事项', 'e',
].join('\n')

test('summary sections are required and tolerate fences and spacing', () => {
  assert.deepEqual(missingSummarySections(normalizeSummary(`\`\`\`markdown\n${fullSummary}\n\`\`\``)), [])
  assert.deepEqual(
    missingSummarySections(fullSummary.replace('## Artifact 演进', '##Artifact演进：')),
    [],
  )
  assert.deepEqual(
    missingSummarySections(fullSummary.replace('## 待办事项\ne', '')),
    ['待办事项'],
  )
})

test('memory operations drop invalid entries, default the category and cap the batch', () => {
  const operations = parseMemoryOperations(JSON.stringify({
    operations: [
      { action: 'upsert', key: ' Lab_Name ', category: 'identity', content: ' 结构生物学实验室 ' },
      { action: 'delete', key: 'old_project' },
      { action: 'upsert', key: 'tool_pref', category: 'nonsense', content: '常用 PyMOL' },
      { action: 'upsert', key: '1bad', content: 'x' },
      { action: 'upsert', key: 'too_long', content: 'x'.repeat(501) },
      { action: 'rename', key: 'unknown_action', content: 'x' },
      ...Array.from({ length: 20 }, (_, index) => ({
        action: 'upsert', key: `extra_${index}`, content: 'x',
      })),
    ],
  }))
  assert.deepEqual(operations.slice(0, 3), [
    { action: 'upsert', key: 'lab_name', category: 'identity', content: '结构生物学实验室' },
    { action: 'delete', key: 'old_project' },
    { action: 'upsert', key: 'tool_pref', category: 'other', content: '常用 PyMOL' },
  ])
  // Twelve raw operations are considered; three of them are invalid.
  assert.equal(operations.length, 9)
})

test('consolidation keeps known sources and rejects unsafe results', () => {
  const known = ['lab_name', 'lab', 'favorite_tool']
  assert.deepEqual(
    parseConsolidatedMemories(JSON.stringify({
      memories: [
        { key: 'lab_name', category: 'identity', content: '结构生物学实验室', sources: ['lab', 'ghost'] },
        { key: 'tools', category: 'preference', content: '常用 PyMOL', sources: ['favorite_tool'] },
      ],
    }), known, 10),
    [
      { key: 'lab_name', category: 'identity', content: '结构生物学实验室', sources: ['lab', 'lab_name'] },
      { key: 'tools', category: 'preference', content: '常用 PyMOL', sources: ['favorite_tool'] },
    ],
  )
  assert.throws(
    () => parseConsolidatedMemories('{"memories":[]}', known, 10),
    /dropped every memory/,
  )
  assert.throws(
    () => parseConsolidatedMemories(JSON.stringify({
      memories: [{ key: 'a', content: 'x' }, { key: 'a', content: 'y' }],
    }), known, 10),
    /repeats key/,
  )
  assert.throws(
    () => parseConsolidatedMemories(JSON.stringify({
      memories: [{ key: 'a', content: '' }],
    }), known, 10),
    /invalid memory/,
  )
  assert.throws(
    () => parseConsolidatedMemories(JSON.stringify({
      memories: [{ key: 'a', content: 'x' }, { key: 'b', content: 'y' }],
    }), known, 1),
    /more than 1/,
  )
  assert.throws(
    () => parseConsolidatedMemories(JSON.stringify({
      memories: [{ key: 'note_user', content: 'x' }],
    }), known, 10, ['note_user']),
    /overwrites user entry/,
  )
})

test('memory injection keeps user entries first within the budget and renders in a stable order', async () => {
  const now = new Date('2026-11-01T00:00:00Z')
  const older = new Date('2026-01-01T00:00:00Z')
  // Columns in select order: id, key, category, content, source, sourceChatId,
  // lastSeenAt, reinforcedCount, expiresAt, createdAt, updatedAt.
  const row = (key: string, category: string, content: string, source: string, updatedAt: Date) =>
    [crypto.randomUUID(), key, category, content, source, null, updatedAt, 1, null, older, updatedAt]
  const rows = [
    row('newest_auto', 'other', 'a'.repeat(30), 'auto', now),
    row('pinned', 'work', 'b'.repeat(10), 'user', older),
    row('identity_fact', 'identity', 'c'.repeat(10), 'auto', older),
  ]
  const client = {
    async query(config: { text: string }) {
      // The digest query filters on category = 'episode'; there are none here.
      if (config.text.includes('from "UserMemory"')) {
        return { rows: config.text.includes('"category" = $') ? [] : rows }
      }
      throw new Error(`Unexpected query: ${config.text}`)
    },
  }
  const database = drizzle(client as never, { schema }) as unknown as Database
  const tokenCounter = new CharacterTokenCounter()
  const entry = (key: string, category: UserMemoryEntry['category'], content: string, source: UserMemoryEntry['source']) =>
    ({ key, category, content, source, updatedAt: now, lastSeenAt: now })
  const twoEntries = countUserMemoryTokens(tokenCounter, [
    entry('pinned', 'work', 'b'.repeat(10), 'user'),
    entry('identity_fact', 'identity', 'c'.repeat(10), 'auto'),
  ])

  const instructions = await buildUserMemoryInstructions(
    database,
    '00000000-0000-0000-0000-000000000001',
    { tokenBudget: twoEntries, maxItems: 10, tokenCounter },
  )

  assert.equal(tokenCounter.countText(instructions), twoEntries)
  // Category order, not recency: identity before work.
  assert.match(instructions, /### 身份与背景\n- \(identity_fact\) c+\n### 工作与长期项目\n- \(pinned\) b+$/)
  assert.doesNotMatch(instructions, /newest_auto/)
})

test('extraction parses touch operations and the chat digest, and keeps digests out of operations', () => {
  const result = parseExtraction(JSON.stringify({
    operations: [
      { action: 'touch', key: 'sample_batch' },
      { action: 'upsert', key: 'episode_abc', category: 'other', content: 'x' },
      { action: 'upsert', key: 'fake_digest', category: 'episode', content: 'x' },
      { action: 'upsert', key: 'paper', category: 'current', content: '用户在准备一篇真菌组学论文' },
    ],
    episode: '  讨论了 tetM 和 sul1 的丰度解读，\n结论是需要 qPCR 验证。 ',
  }))
  assert.deepEqual(result.operations, [
    { action: 'touch', key: 'sample_batch' },
    { action: 'upsert', key: 'paper', category: 'current', content: '用户在准备一篇真菌组学论文' },
  ])
  assert.equal(result.episode, '讨论了 tetM 和 sul1 的丰度解读， 结论是需要 qPCR 验证。')
  assert.equal(parseExtraction('{"operations":[],"episode":null}').episode, null)
  assert.equal(parseExtraction('{"operations":[]}').episode, null)
  assert.equal(parseExtraction(JSON.stringify({ operations: [], episode: 'x'.repeat(400) })).episode?.length, 300)
})
