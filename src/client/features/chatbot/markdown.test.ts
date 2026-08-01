import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseStreamingMarkdownTail,
  stableMarkdownPrefixLength,
} from './markdown'

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

test('recognizes a fenced code block before its closing fence arrives', () => {
  assert.deepEqual(
    parseStreamingMarkdownTail('```ts\nconst answer = 42'),
    {
      kind: 'code',
      code: 'const answer = 42',
      language: 'ts',
      remainder: '',
      closed: false,
    },
  )
})

test('hides a closing fence and preserves text that follows it', () => {
  assert.deepEqual(
    parseStreamingMarkdownTail('```python\nprint("ok")\n```\nDone'),
    {
      kind: 'code',
      code: 'print("ok")',
      language: 'python',
      remainder: 'Done',
      closed: true,
    },
  )
})

test('requires a matching fence character and sufficient fence length', () => {
  const source = '````js\nconsole.log("ok")\n```'

  assert.deepEqual(parseStreamingMarkdownTail(source), {
    kind: 'code',
    code: 'console.log("ok")\n```',
    language: 'js',
    remainder: '',
    closed: false,
  })
})
