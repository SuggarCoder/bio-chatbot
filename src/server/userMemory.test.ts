import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterTokenCounter } from './tokenBudget.js'
import {
  normalizeMemoryCategory,
  normalizeMemoryContent,
  normalizeMemoryKey,
  renderUserMemoryInstructions,
  scoreText,
  searchTerms,
  selectMemoriesWithinBudget,
  snippetAround,
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

test('search terms keep Latin words and split CJK runs into bigrams', () => {
  assert.deepEqual(searchTerms('Kraken2 宏基因组'), ['kraken2', '宏基因组', '宏基', '基因', '因组'])
  assert.deepEqual(searchTerms('耐药，16S'), ['耐药', '16s'])
  // Single Latin characters and punctuation carry no signal.
  assert.deepEqual(searchTerms('a , 。'), [])
  assert.ok(searchTerms('一 二 三 四 五 六 七 八 九 十 甲 乙 丙 丁 戊 己 庚 辛').length <= 16)
})

test('scoring prefers longer matched terms and snippets centre on the first match', () => {
  const terms = searchTerms('宏基因组 耐药')
  assert.ok(scoreText('我们讨论了宏基因组和耐药基因', terms) > scoreText('基因', terms))
  assert.equal(scoreText('完全无关', terms), 0)
  const text = `${'前文'.repeat(100)}宏基因组分析结果${'后文'.repeat(100)}`
  const snippet = snippetAround(text, terms, 10)
  assert.match(snippet, /^….*宏基因组.*…$/)
})

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
