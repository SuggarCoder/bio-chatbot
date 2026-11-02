import assert from 'node:assert/strict'
import test from 'node:test'

import {
  episodeKey,
  MEMORY_POLICY,
  memoryExpiresAt,
  memoryTier,
} from './memoryPolicy.js'
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
): UserMemoryEntry => ({ key, category, content, source, updatedAt, lastSeenAt: updatedAt })

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

test('tiers: profile memories never expire, recent focus and digests age out', () => {
  assert.equal(memoryTier('identity'), 'profile')
  assert.equal(memoryTier('work'), 'profile')
  assert.equal(memoryTier('preference'), 'profile')
  assert.equal(memoryTier('current'), 'recent')
  assert.equal(memoryTier('episode'), 'episode')
  const seen = new Date('2026-11-01T00:00:00Z')
  assert.equal(memoryExpiresAt('identity', seen), null)
  assert.equal(memoryExpiresAt('preference', seen), null)
  assert.equal(
    memoryExpiresAt('current', seen)?.toISOString(),
    new Date(seen.getTime() + MEMORY_POLICY.recentTtlDays * 86_400_000).toISOString(),
  )
  assert.equal(
    memoryExpiresAt('episode', seen)?.toISOString(),
    new Date(seen.getTime() + MEMORY_POLICY.episodeTtlDays * 86_400_000).toISOString(),
  )
  assert.equal(episodeKey('0f8fad5b-d9cb-469f-a165-70867728950e'), 'episode_0f8fad5bd9cb469fa1657086')
})

test('conversation digests render last, dated and newest first, without keys', () => {
  const rendered = renderUserMemoryInstructions([
    entry('episode_old', 'episode', '讨论了样本 QC', 'auto', new Date('2026-10-20T08:00:00Z')),
    entry('lab', 'identity', '在结构生物学实验室工作'),
    entry('episode_new', 'episode', '讨论了耐药基因解读', 'auto', new Date('2026-10-30T08:00:00Z')),
    entry('paper', 'current', '在准备真菌组学论文'),
  ])
  assert.match(
    rendered,
    /### 身份与背景\n- \(lab\) .+\n### 近期关注\n- \(paper\) .+\n### 近期对话\n- 2026-10-30：讨论了耐药基因解读\n- 2026-10-20：讨论了样本 QC$/,
  )
  assert.doesNotMatch(rendered, /episode_/)
})

test('budget selection keeps the profile before recent focus and digests', () => {
  const counter = new CharacterTokenCounter()
  const entries = [
    entry('digest', 'episode', 'd'.repeat(40), 'auto', new Date('2026-12-01')),
    entry('focus', 'current', 'f'.repeat(40), 'auto', new Date('2026-12-01')),
    entry('lab', 'identity', 'z'.repeat(40)),
  ]
  const budget = counter.countText(renderUserMemoryInstructions([entries[1]!, entries[2]!]))
  assert.deepEqual(
    selectMemoriesWithinBudget(counter, entries, budget).map((item) => item.key).sort(),
    ['focus', 'lab'],
  )
})
