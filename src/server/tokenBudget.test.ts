import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterTokenCounter } from './tokenBudget.js'

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
