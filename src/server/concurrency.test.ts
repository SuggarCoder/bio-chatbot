import assert from 'node:assert/strict'
import test from 'node:test'
import { AdmissionQueue } from './admission.js'
import { withRedisDeadlines } from './cache.js'
import { GenerationExecutionContext, GenerationCancellationError } from './generationExecution.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('admission is FIFO and bounded, rejected work cannot leak permits', async () => {
  const queue = new AdmissionQueue(1, 2)
  let release!: () => void
  const first = queue.run(() => new Promise<void>(resolve => { release = resolve }))
  const order: number[] = []
  const second = queue.run(async () => { order.push(2); throw new Error('expected') })
  const third = queue.run(async () => { order.push(3) })
  await assert.rejects(queue.run(async () => {}), /./)
  const rejected = assert.rejects(second, /expected/)
  release()
  await Promise.all([first, rejected, third])
  await queue.run(async () => { order.push(4) })
  assert.deepEqual(order, [2, 3, 4])
})

test('Redis response deadline covers a command already sent but never answered', async () => {
  const client = withRedisDeadlines({ get: async () => new Promise<never>(() => {}) }, 20)
  await assert.rejects(client.get(), /response deadline exceeded/)
})

test('cancellation falls back to durable state when Redis response stalls', async () => {
  let databasePolls = 0
  const client = withRedisDeadlines({ exists: async () => new Promise<never>(() => {}) }, 20)
  const execution = new GenerationExecutionContext('g', new AbortController().signal, async () =>
    await client.exists().catch(() => false) || (databasePolls += 1, true))
  await assert.rejects(execution.checkpoint(true), GenerationCancellationError)
  assert.equal(databasePolls, 1)
})

test('abort interrupts an already-pending cancellation checkpoint', async () => {
  const controller = new AbortController()
  const execution = new GenerationExecutionContext('g', controller.signal, async () => new Promise<boolean>(() => {}))
  const checking = assert.rejects(execution.checkpoint(true), GenerationCancellationError)
  controller.abort()
  await checking
})
