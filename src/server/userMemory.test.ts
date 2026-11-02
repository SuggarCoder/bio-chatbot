import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterTokenCounter } from './tokenBudget.js'
import {
  normalizeMemoryCategory,
  normalizeMemoryContent,
  normalizeMemoryKey,
  renderUserMemoryInstructions,
  selectMemoriesWithinBudget,
  type UserMemoryEntry,
} from './userMemory.js'

const at = new Date('2026-11-01T00:00:00Z')
const entry = (
  key: string,
  category: UserMemoryEntry['category'],
  content: string,
  source: UserMemoryEntry['source'] = 'auto',
  updatedAt = at,
): UserMemoryEntry => ({ key, category, content, source, updatedAt })

test('memory rendering is grouped by category and independent of input order', () => {
  const entries = [
    entry('zeta', 'preference', '偏好简洁回答'),
    entry('lab', 'identity', '在结构生物学实验室工作'),
    entry('alpha', 'preference', '常用 R'),
  ]
  const rendered = renderUserMemoryInstructions(entries)
  assert.equal(rendered, renderUserMemoryInstructions([...entries].reverse()))
  assert.match(rendered, /### 身份与背景\n- \(lab\) .+\n### 偏好与习惯\n- \(alpha\) 常用 R\n- \(zeta\) .+$/)
  assert.equal(renderUserMemoryInstructions([]), '')
})

test('budget selection drops auto entries in low-priority categories first', () => {
  const counter = new CharacterTokenCounter()
  const entries = [
    entry('other_fact', 'other', 'x'.repeat(40), 'auto', new Date('2026-12-01')),
    entry('user_pref', 'preference', 'y'.repeat(40), 'user', new Date('2025-01-01')),
    entry('identity', 'identity', 'z'.repeat(40)),
  ]
  const budget = counter.countText(renderUserMemoryInstructions([entries[1]!, entries[2]!]))
  const selected = selectMemoriesWithinBudget(counter, entries, budget).map((item) => item.key).sort()
  assert.deepEqual(selected, ['identity', 'user_pref'])
})

test('memory field normalization', () => {
  assert.equal(normalizeMemoryKey(' Lab_Name '), 'lab_name')
  assert.equal(normalizeMemoryKey('1bad'), null)
  assert.equal(normalizeMemoryContent('  第一行\n  第二行 '), '第一行 第二行')
  assert.equal(normalizeMemoryContent('x'.repeat(501)), null)
  assert.equal(normalizeMemoryCategory('work'), 'work')
  assert.equal(normalizeMemoryCategory('unknown'), 'other')
})
