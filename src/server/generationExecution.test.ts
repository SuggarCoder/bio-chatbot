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
