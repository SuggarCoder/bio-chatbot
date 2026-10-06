import assert from 'node:assert/strict'
import test from 'node:test'

import type { RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'

test('runtime cancellation is generation-scoped and idempotent', () => {
  const registry = new GenerationRuntimeRegistry(
    {} as AppConfig,
    {} as RedisClient,
  )
  const first = new AbortController()
  const second = new AbortController()
  const runtime = (
    generationId: string,
    controller: AbortController,
  ) => ({
    generationId,
    streamId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    chatId: crypto.randomUUID(),
    controller,
    partialOutput: '',
    executionSteps: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
  })
  const firstId = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  registry.register(runtime(firstId, first))
  registry.register(runtime(secondId, second))

  assert.equal(registry.abort(firstId), true)
  assert.equal(registry.abort(firstId), true)
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  assert.equal(registry.abort(crypto.randomUUID()), false)
})

test('100 running generations share one durable cancellation query even without Pub/Sub', async () => {
  let queries = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID())
  const database = { select: () => ({ from: () => ({ where: async () => {
    queries++; await barrier
    return ids.map((id, i) => ({ id, status: 'running', cancelled: i === 0 ? new Date() : null }))
  } }) }) } as unknown as import('./db.js').Database
  const registry = new GenerationRuntimeRegistry({} as AppConfig, {} as RedisClient, database)
  for (const id of ids) registry.register({ generationId: id, streamId: id, userId: id, chatId: id,
    controller: new AbortController(), partialOutput: '', executionSteps: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
  })
  const first = registry.pollCancellations()
  await registry.pollCancellations()
  const newcomer = { ...registry.get(ids[1])!, generationId: crypto.randomUUID(), controller: new AbortController() }
  registry.register(newcomer)
  release(); await first
  assert.equal(newcomer.controller.signal.aborted, false)
  assert.equal(queries, 1)
  assert.equal(registry.get(ids[0])?.controller.signal.aborted, true)
  assert.equal(registry.get(ids[1])?.controller.signal.aborted, false)
  await registry.close()
})
