import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type BudgetMessage,
  CharacterTokenCounter,
  conversationFramingTokens,
  estimateConversationTokens,
  fitInputBudget,
  messageCostTokens,
} from './tokenBudget.js'

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

/**
 * Like the Qwen3 template: a final assistant turn gets 4 extra tokens, so a
 * conversation is not exactly the sum of its messages. Counts every call.
 */
class QuirkyCounter extends CharacterTokenCounter {
  messageCalls = 0
  countedChars = 0
  override countMessages(messages: BudgetMessage[], instructions?: string): number {
    this.messageCalls += 1
    this.countedChars += messages.reduce((total, message) => total + message.content.length, instructions?.length ?? 0)
    const base = super.countMessages(messages, instructions)
    return messages.at(-1)?.role === 'assistant' ? base + 4 : base
  }
}

function conversation(turns: number, seed: number): BudgetMessage[] {
  let state = seed
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  const messages: BudgetMessage[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: 'user', content: 'u'.repeat(1 + Math.floor(random() * 200)) })
    if (turn < turns - 1 || random() < 0.5) {
      messages.push({ role: 'assistant', content: 'a'.repeat(1 + Math.floor(random() * 400)) })
    }
  }
  return messages
}

const fitConfig = {
  qwenMaxInputTokens: 1_000_000,
  qwenContextWindowTokens: 1_000_000,
  qwenMaxOutputTokens: 1_000,
  chatSummaryTokenBudget: 0,
  instructionsTokenBudget: 10_000,
}

test('fitInputBudget picks the earliest turn that fits exactly, even when the template is not additive', async () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const counter = new QuirkyCounter()
    const messages = conversation(2 + (seed % 30), seed)
    const instructions = seed % 3 === 0 ? '' : 'i'.repeat(seed * 3)
    const historyBudget = 300 + (seed * 37) % 3_000
    const config = { ...fitConfig, chatHistoryTokenBudget: historyBudget }
    const budget = historyBudget + counter.countText(instructions)
    const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
    const reference = starts.find((start) => counter.countMessages(messages.slice(start), instructions) <= budget)
    if (reference === undefined) {
      await assert.rejects(fitInputBudget(counter, messages, instructions, config), /LATEST_MESSAGE_TOKEN_BUDGET_EXCEEDED/)
      continue
    }
    const selected = await fitInputBudget(counter, messages, instructions, config)
    assert.equal(messages.length - selected.length, reference, `seed ${seed}`)
    assert.ok(counter.countMessages(selected, instructions) <= budget)
  }
})

test('fitInputBudget counts each message about once, not once per probe', async () => {
  const counter = new QuirkyCounter()
  const messages = conversation(400, 7)
  const instructions = 'i'.repeat(20_000)
  await fitInputBudget(counter, messages, instructions, { ...fitConfig, instructionsTokenBudget: 30_000, chatHistoryTokenBudget: 40_000 })
  const totalChars = messages.reduce((total, message) => total + message.content.length, 0) + instructions.length
  // One pass of cost lookups plus one exact count: about 2x the input, not log(n)x.
  assert.ok(counter.countedChars <= totalChars * 2.5, `${counter.countedChars} chars counted for ${totalChars}`)
})

test('the conversation estimate matches an additive template exactly', () => {
  const counter = new CharacterTokenCounter()
  const messages = conversation(50, 3)
  assert.equal(estimateConversationTokens(counter, messages, 'sys'), counter.countMessages(messages, 'sys'))
  assert.equal(conversationFramingTokens(counter), 3)
  assert.equal(messageCostTokens(counter, { role: 'user', content: 'hello' }), 9)
})
