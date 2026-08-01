import assert from 'node:assert/strict'
import test from 'node:test'

import { stableMarkdownPrefixLength } from './markdown'

test('commits a paragraph only after a following block boundary', () => {
  const source = '第一段。\n\n第二段仍在生成'
  const length = stableMarkdownPrefixLength(source)

  assert.equal(source.slice(0, length).trim(), '第一段。')
  assert.equal(source.slice(length).trim(), '第二段仍在生成')
})

test('keeps incomplete fenced code active and commits a closed fence', () => {
  assert.equal(stableMarkdownPrefixLength('```ts\nconst x = 1'), 0)
  assert.equal(
    stableMarkdownPrefixLength('```ts\nconst x = 1\n```\n'),
    '```ts\nconst x = 1\n```\n'.length,
  )
})

test('a GFM table remains one active block until another block arrives', () => {
  const table = '| A | B |\n| - | - |\n| 1 | 2 |\n\n'
  const source = `${table}后续段落`

  assert.equal(source.slice(0, stableMarkdownPrefixLength(source)), table)
})
