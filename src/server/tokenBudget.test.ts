import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterTokenCounter, fitInputBudget } from './tokenBudget.js'

test('character counter applies deterministic chat overhead', async () => {
  const counter = new CharacterTokenCounter()
  await counter.initialize()
  assert.equal(counter.countText('生命 science'), 10)
  assert.equal(counter.countMessages([
    { role: 'user', content: 'abc' },
    { role: 'assistant', content: 'de' },
  ]), 16)
  assert.equal(counter.countMessages(
    [{ role: 'user', content: 'abc' }],
    'rules',
  ), 19)
})

const budget = {
  qwenMaxInputTokens: 30, qwenContextWindowTokens: 40, qwenMaxOutputTokens: 10,
  chatHistoryTokenBudget: 30, chatSummaryTokenBudget: 0, instructionsTokenBudget: 12,
}

test('plain chat with empty instructions evicts old turns to the exact token budget', async () => {
  const counter = new CharacterTokenCounter()
  const result = await fitInputBudget(counter, [
    { role: 'user', content: 'x'.repeat(40) },
    { role: 'assistant', content: 'y'.repeat(30) },
    { role: 'user', content: 'new question' },
  ], '', budget)
  assert.deepEqual(result, [{ role: 'user', content: 'new question' }])
  assert.ok(counter.countMessages(result) <= 30)
})

test('single oversized latest user message is never silently discarded', async () => {
  await assert.rejects(fitInputBudget(new CharacterTokenCounter(), [
    { role: 'user', content: 'x'.repeat(40) },
  ], '', budget), /LATEST_MESSAGE_TOKEN_BUDGET_EXCEEDED/)
})

test('instructions and output reserve are enforced even with memory features disabled', async () => {
  await assert.rejects(fitInputBudget(new CharacterTokenCounter(), [
    { role: 'user', content: 'hello' },
  ], 'x'.repeat(13), budget), /INSTRUCTIONS_TOKEN_BUDGET/)
  await assert.rejects(fitInputBudget(new CharacterTokenCounter(), [
    { role: 'user', content: 'hello' },
  ], '', { ...budget, qwenMaxOutputTokens: 35 }), /LATEST_MESSAGE_TOKEN_BUDGET/)
})
