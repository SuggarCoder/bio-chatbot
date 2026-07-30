import assert from 'node:assert/strict'
import test from 'node:test'

import { decideGenerationTerminalStatus } from './db.js'

test('cancel intent committed before finalization wins', () => {
  assert.equal(
    decideGenerationTerminalStatus(
      'streaming',
      new Date(),
      'completed',
    ),
    'cancelled',
  )
})

test('a terminal completion cannot be overwritten by late cancellation', () => {
  assert.equal(
    decideGenerationTerminalStatus(
      'completed',
      new Date(),
      'failed',
    ),
    'completed',
  )
})
