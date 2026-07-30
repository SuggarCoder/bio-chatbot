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
