import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cachedHighlight,
  highlightCodeWithShiki,
  normalizeCodeLanguage,
  plainHighlightedCode,
  rememberHighlight,
  reuseUnchangedLines,
  splitCodeLines,
} from './codeHighlight'

test('a re-highlight keeps the line arrays of unchanged lines', async () => {
  const before = await highlightCodeWithShiki('def a():\n    return 1\nx = ', 'python')
  const after = await highlightCodeWithShiki('def a():\n    return 1\nx = 42\ny = 1', 'python')
  const lines = reuseUnchangedLines(before.lines, after.lines)
  assert.equal(lines.length, 4)
  assert.equal(lines[0], before.lines[0])
  assert.equal(lines[1], before.lines[1])
  assert.notEqual(lines[2], before.lines[2])
  assert.equal(lines[3], after.lines[3])
  assert.deepEqual(lines, after.lines)
})

test('finished highlights are cached by language and exact source', async () => {
  const source = 'SELECT 1;\n-- cached'
  assert.equal(cachedHighlight(source, 'sql'), undefined)
  const result = await highlightCodeWithShiki(source, 'sql')
  rememberHighlight(result, 'sql')
  assert.equal(cachedHighlight(source, 'sql'), result)
  assert.equal(cachedHighlight(source, 'python'), undefined)
  assert.equal(cachedHighlight(`${source} `, 'sql'), undefined)
  rememberHighlight(plainHighlightedCode('plain', 'text'), 'text')
  assert.equal(cachedHighlight('plain', 'text'), undefined, 'plain fallbacks are not cached')
})

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
