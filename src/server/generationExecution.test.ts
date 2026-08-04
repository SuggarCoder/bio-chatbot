import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GenerationCancellationError,
  GenerationExecutionContext,
} from './generationExecution.js'

test('an aborted generation never starts the next tool', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const context = new GenerationExecutionContext(
    crypto.randomUUID(),
    controller.signal,
    async () => controller.signal.aborted,
  )

  await context.runCancellable(async () => {
    calls.push('first')
    controller.abort()
  }).catch((error: unknown) => {
    assert.ok(error instanceof GenerationCancellationError)
  })

  await assert.rejects(
    () => context.runCancellable(async () => {
      calls.push('second')
    }),
    GenerationCancellationError,
  )
  assert.deepEqual(calls, ['first'])
})

test('a non-cancellable side effect can finish but stops the agent afterward', async () => {
  let cancelRequested = false
  const calls: string[] = []
  const context = new GenerationExecutionContext(
    crypto.randomUUID(),
    new AbortController().signal,
    async () => cancelRequested,
  )

  await assert.rejects(
    () => context.runNonCancellable(async () => {
      calls.push('side-effect-committed')
      cancelRequested = true
    }),
    GenerationCancellationError,
  )
  assert.deepEqual(calls, ['side-effect-committed'])
})

test('stream checkpoints throttle durable cancellation polling', async () => {
  let now = 10_000
  let polls = 0
  const context = new GenerationExecutionContext(
    crypto.randomUUID(),
    new AbortController().signal,
    async () => {
      polls += 1
      return false
    },
    1_000,
    () => now,
  )

  for (let index = 0; index < 100; index += 1) {
    await context.checkpoint()
  }
  assert.equal(polls, 1)

  now += 999
  await context.checkpoint()
  assert.equal(polls, 1)

  now += 1
  await context.checkpoint()
  assert.equal(polls, 2)

  await context.checkpoint(true)
  assert.equal(polls, 3)
})
