import assert from 'node:assert/strict'
import test from 'node:test'

import {
  highlightCodeWithShiki,
  normalizeCodeLanguage,
  plainHighlightedCode,
  splitCodeLines,
} from './codeHighlight'

test('normalizes supported language aliases and rejects unknown languages', () => {
  assert.equal(normalizeCodeLanguage(' py '), 'python')
  assert.equal(normalizeCodeLanguage('TSX{path=App.tsx}'), 'tsx')
  assert.equal(normalizeCodeLanguage('shell'), 'bash')
  assert.equal(normalizeCodeLanguage('unknown-runtime'), null)
})

test('splits all source line endings without interpreting literal backslash-n', () => {
  assert.deepEqual(splitCodeLines('one\r\ntwo\rthree\nfour'), [
    'one',
    'two',
    'three',
    'four',
  ])
  assert.deepEqual(splitCodeLines('print("\\n")'), ['print("\\n")'])
  assert.deepEqual(splitCodeLines('trailing\n'), ['trailing', ''])
})

test('plain fallback preserves indentation and empty lines exactly', () => {
  const source = 'def main():\n    print("ok")\n\nmain()'
  const result = plainHighlightedCode(source, 'python')

  assert.equal(result.highlighted, false)
  assert.deepEqual(
    result.lines.map((line) => line.map((token) => token.content).join('')),
    ['def main():', '    print("ok")', '', 'main()'],
  )
})

test('Shiki highlights a supported language while preserving every line', async () => {
  const source = 'def main():\n    print("ok")\n\nmain()'
  const result = await highlightCodeWithShiki(source, 'py')

  assert.equal(result.highlighted, true)
  assert.equal(result.language, 'python')
  assert.deepEqual(
    result.lines.map((line) => line.map((token) => token.content).join('')),
    ['def main():', '    print("ok")', '', 'main()'],
  )
  assert.ok(result.lines.flat().some((token) => token.color))
})

test('unknown languages safely remain plain text', async () => {
  const result = await highlightCodeWithShiki('<unsafe>', 'made-up-language')

  assert.equal(result.highlighted, false)
  assert.equal(result.language, null)
  assert.equal(result.lines[0]?.[0]?.content, '<unsafe>')
})
