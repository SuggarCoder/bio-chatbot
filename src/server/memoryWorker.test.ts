import assert from 'node:assert/strict'
import test from 'node:test'

import { drizzle } from 'drizzle-orm/node-postgres'

import {
  buildUserMemoryInstructions,
  countUserMemoryTokens,
} from './conversationMemory.js'
import type { Database } from './db.js'
import * as schema from './db/schema.js'
import {
  missingSummarySections,
  normalizeSummary,
  parseConsolidatedMemories,
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

test('memory operations drop invalid entries and cap the turn', () => {
  const operations = parseMemoryOperations(JSON.stringify({
    operations: [
      { action: 'upsert', key: ' Lab_Name ', content: ' 结构生物学实验室 ' },
      { action: 'delete', key: 'old_project' },
      { action: 'upsert', key: '1bad', content: 'x' },
      { action: 'upsert', key: 'too_long', content: 'x'.repeat(201) },
      { action: 'rename', key: 'unknown_action', content: 'x' },
      ...Array.from({ length: 10 }, (_, index) => ({
        action: 'upsert', key: `extra_${index}`, content: 'x',
      })),
    ],
  }))
  assert.deepEqual(operations.slice(0, 2), [
    { action: 'upsert', key: 'lab_name', content: '结构生物学实验室' },
    { action: 'delete', key: 'old_project' },
  ])
  // Eight raw operations are considered; three of them are invalid.
  assert.equal(operations.length, 5)
})

test('consolidation keeps known sources and rejects unsafe results', () => {
  const known = ['lab_name', 'lab', 'favorite_tool']
  assert.deepEqual(
    parseConsolidatedMemories(JSON.stringify({
      memories: [
        { key: 'lab_name', content: '结构生物学实验室', sources: ['lab', 'ghost'] },
        { key: 'tools', content: '常用 PyMOL', sources: ['favorite_tool'] },
      ],
    }), known, 10),
    [
      { key: 'lab_name', content: '结构生物学实验室', sources: ['lab', 'lab_name'] },
      { key: 'tools', content: '常用 PyMOL', sources: ['favorite_tool'] },
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
})

test('memory injection keeps the newest entries within the token budget', async () => {
  const rows = [
    ['newest', 'a'.repeat(20)],
    ['middle', 'b'.repeat(20)],
    ['oldest', 'c'],
  ]
  const client = {
    async query(config: { text: string }) {
      if (config.text.includes('from "UserMemory"')) return { rows }
      throw new Error(`Unexpected query: ${config.text}`)
    },
  }
  const database = drizzle(client as never, { schema }) as unknown as Database
  const tokenCounter = new CharacterTokenCounter()
  const twoEntries = countUserMemoryTokens(tokenCounter, [
    { key: 'newest', content: 'a'.repeat(20) },
    { key: 'middle', content: 'b'.repeat(20) },
  ])

  const instructions = await buildUserMemoryInstructions(
    database,
    '00000000-0000-0000-0000-000000000001',
    { tokenBudget: twoEntries, maxItems: 10, tokenCounter },
  )

  assert.equal(tokenCounter.countText(instructions), twoEntries)
  assert.match(instructions, /- newest: a+\n- middle: b+$/)
  assert.doesNotMatch(instructions, /oldest/)
})
