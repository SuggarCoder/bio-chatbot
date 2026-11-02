import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChunkContent,
  fuseRankings,
  scoreText,
  searchTerms,
  snippetAround,
} from './chatSearch.js'

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
  assert.match(snippetAround(text, terms, 10), /^….*宏基因组.*…$/)
})

test('reciprocal rank fusion rewards items both rankings agree on', () => {
  const scores = fuseRankings([['a', 'b', 'c'], ['c', 'a']], (item) => item)
  const order = [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id)
  assert.deepEqual(order, ['a', 'c', 'b'])
  assert.equal(scores.get('b'), 1 / 62)
})

test('chunk content labels both sides of a turn and clips long text', () => {
  assert.equal(buildChunkContent('问题', '回答'), '用户：问题\n助手：回答')
  assert.equal(buildChunkContent('', '只有回答'), '助手：只有回答')
  const long = buildChunkContent('q'.repeat(2_000), 'a'.repeat(3_000))
  assert.ok(long.length < 4_100)
  assert.match(long, /q…\n助手：a+…$/)
})
