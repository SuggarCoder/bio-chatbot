import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceCachedChatContext,
  consumeGenerationRateLimit,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'

const config = {
  redisPrefix: 'test:',
  chatRateLimitPerMinute: 10,
} as AppConfig

test('generation rate limit evaluates user and IP windows atomically', async () => {
  const calls: Array<{
    keys: string[]
    arguments: string[]
  }> = []
  const redis = {
    isReady: true,
    eval: async (_script: string, options: {
      keys: string[]
      arguments: string[]
    }) => {
      calls.push(options)
      return [0, 1_500, 0, 3]
    },
  } as unknown as RedisClient

  const result = await consumeGenerationRateLimit(
    redis,
    config,
    'user-1',
    '127.0.0.1',
  )

  assert.deepEqual(result, {
    allowed: false,
    retryAfterMs: 1_500,
    remainingUser: 0,
    remainingIp: 3,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.keys, [
    'test:rl:user:user-1:generation',
    'test:rl:ip:127.0.0.1:generation',
  ])
  assert.equal(calls[0]?.arguments[1], '60000')
  assert.equal(calls[0]?.arguments[2], '10')
  assert.equal(calls[0]?.arguments[3], '50')
})

test('chat context CAS uses one stable per-chat key', async () => {
  let keys: string[] = []
  const redis = {
    isReady: true,
    eval: async (_script: string, options: { keys: string[] }) => {
      keys = options.keys
      return 1
    },
  } as unknown as RedisClient

  const advanced = await advanceCachedChatContext(redis, config, 4, {
    chatId: 'chat-1',
    revision: 5,
    lastSeq: 8,
    messages: [{ role: 'user', content: 'next' }],
  })

  assert.equal(advanced, true)
  assert.deepEqual(keys, ['test:chat:ctx:chat-1'])
})
