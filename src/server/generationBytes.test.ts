import assert from 'node:assert/strict'
import test from 'node:test'

import { GenerationByteBudget, GenerationByteLimitError, utf8Bytes } from './generationBytes.js'

test('the byte budget accounts per kind and stops past the cap', () => {
  const budget = new GenerationByteBudget(100)
  budget.charge('input', 40)
  budget.charge('output', utf8Bytes('数据')) // 6 bytes
  budget.charge('tool', 50)
  assert.equal(budget.totalBytes, 96)
  assert.throws(() => budget.charge('artifact', 5), GenerationByteLimitError)
  assert.deepEqual(budget.report(), {
    inputBytes: 40,
    outputBytes: 6,
    toolBytes: 50,
    artifactBytes: 5,
    totalBytes: 101,
    capBytes: 100,
    limited: true,
  })
})
