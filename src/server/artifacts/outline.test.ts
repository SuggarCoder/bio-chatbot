import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractArtifactOutline,
  validateArtifactSyntax,
} from './outline.js'

test('markdown outline records exact UTF-8 byte ranges', () => {
  const content = [
    '# 概览',
    '首句包含中文。',
    '',
    '## Results',
    'A'.repeat(120),
  ].join('\n')
  const result = extractArtifactOutline(content, 'text/markdown', 8_192, 64)
  assert.ok(result.outline.includes('概览'))
  assert.ok(result.outline.includes('Results'))
  assert.ok(result.sections.length >= 2)
  for (const section of result.sections) {
    assert.ok(section.byteEnd > section.byteStart)
    assert.ok(section.byteEnd - section.byteStart <= 64)
    assert.doesNotThrow(() => Buffer.from(content, 'utf8')
      .subarray(section.byteStart, section.byteEnd)
      .toString('utf8'))
  }
})

test('markdown validation rejects an unclosed code fence', () => {
  assert.throws(
    () => validateArtifactSyntax('```ts\nconst value = 1', 'text/markdown'),
    /not closed/,
  )
})
