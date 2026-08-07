import 'dotenv/config'

import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from 'redis'

import type { RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import {
  GenerationQueue,
  type QueueLease,
} from './generationQueue.js'

const testRedisUrl = process.env.TEST_REDIS_URL?.trim()

function queueConfig(
  prefix: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    redisPrefix: prefix,
    globalGenerationConcurrency: 4,
    providerGenerationConcurrency: 4,
    modelGenerationConcurrency: 4,
    generationLockLeaseMs: 1_000,
    ...overrides,
  } as AppConfig
}

function queueLease(
  queue: GenerationQueue,
  values: {
    userId: string
    generationId: string
    conversationId: string
    provider?: string
    model?: string
  },
): QueueLease {
  return {
    ...values,
    provider: values.provider ?? 'provider',
    model: values.model ?? 'model',
    workerId: queue.workerId,
    token: `${values.generationId}:${queue.workerId}:${crypto.randomUUID()}`,
  }
}

test('GenerationQueue Lua scripts preserve queue and lease invariants', {
  skip: testRedisUrl ? false : 'TEST_REDIS_URL is not configured',
}, async (context) => {
  if (!testRedisUrl) return

  const redis = createClient({ url: testRedisUrl })
  redis.on('error', () => {
    // Test assertions and Redis operations surface actionable failures.
  })
  await redis.connect()

  const rootPrefix = `gpas2cb:test:queue:${crypto.randomUUID()}:`
  const client = redis as RedisClient

  try {
    await context.test('deduplicates concurrent enqueue operations', async () => {
      const prefix = `${rootPrefix}dedupe:`
      const queue = new GenerationQueue(queueConfig(prefix), client)
      const job = {
        userId: 'user-a',
        generationId: 'generation-a',
        attempt: 0,
      }

      await Promise.all(
        Array.from({ length: 100 }, () => queue.enqueue(job, 1)),
      )

      assert.equal(await redis.xLen(`${prefix}queue:tenant:${job.userId}`), 1)
      assert.equal(await redis.zCard(`${prefix}queue:ready-users`), 1)
      assert.deepEqual(await queue.pop(), {
        ...job,
        schedulingScore: 1,
      })
      assert.equal(await queue.pop(), null)
    })

    await context.test('applies weighted fairness across users', async () => {
      const prefix = `${rootPrefix}fairness:`
      const queue = new GenerationQueue(queueConfig(prefix), client)

      for (let index = 0; index < 40; index += 1) {
        await Promise.all([
          queue.enqueue({
            userId: 'user-a',
            generationId: `generation-a-${index}`,
            attempt: 0,
          }, 1),
          queue.enqueue({
            userId: 'user-b',
            generationId: `generation-b-${index}`,
            attempt: 0,
          }, 2),
        ])
      }

      const counts = { 'user-a': 0, 'user-b': 0 }
      for (let index = 0; index < 30; index += 1) {
        const job = await queue.pop()
        assert.ok(job)
        counts[job.userId as keyof typeof counts] += 1
      }

      assert.deepEqual(counts, { 'user-a': 10, 'user-b': 20 })
    })

    await context.test('defers with exactly one scheduling charge', async () => {
      const prefix = `${rootPrefix}defer:`
      const queue = new GenerationQueue(queueConfig(prefix), client)

      await queue.enqueue({
        userId: 'user-a',
        generationId: 'generation-a-1',
        attempt: 0,
      }, 1)
      await queue.enqueue({
        userId: 'user-a',
        generationId: 'generation-a-2',
        attempt: 0,
      }, 1)

      const job = await queue.pop()
      assert.ok(job)
      assert.equal(job.schedulingScore, 1)
      await queue.defer(job, 1)

      assert.equal(
        await redis.zScore(`${prefix}queue:ready-users`, 'user-a'),
        1,
      )
      assert.equal(await redis.xLen(`${prefix}queue:tenant:user-a`), 2)
    })

    await context.test('restores score after a concurrent re-enqueue', async () => {
      const prefix = `${rootPrefix}defer-race:`
      const queue = new GenerationQueue(queueConfig(prefix), client)
      const original = {
        userId: 'user-a',
        generationId: 'generation-a',
        attempt: 0,
      }

      await queue.enqueue(original, 1)
      const popped = await queue.pop()
      assert.ok(popped)
      await queue.enqueue(original, 1)
      await queue.defer(popped, 1)

      assert.equal(
        await redis.zScore(`${prefix}queue:ready-users`, original.userId),
        1,
      )
      assert.equal(
        await redis.xLen(`${prefix}queue:tenant:${original.userId}`),
        1,
      )
    })

    for (const scenario of [
      {
        name: 'global limit',
        config: { globalGenerationConcurrency: 1 },
        first: {
          userId: 'user-a',
          generationId: 'generation-a',
          conversationId: 'conversation-a',
          provider: 'provider-a',
          model: 'model-a',
        },
        second: {
          userId: 'user-b',
          generationId: 'generation-b',
          conversationId: 'conversation-b',
          provider: 'provider-b',
          model: 'model-b',
        },
        userLimit: 4,
      },
      {
        name: 'provider limit',
        config: { providerGenerationConcurrency: 1 },
        first: {
          userId: 'user-a',
          generationId: 'generation-a',
          conversationId: 'conversation-a',
          provider: 'shared-provider',
          model: 'model-a',
        },
        second: {
          userId: 'user-b',
          generationId: 'generation-b',
          conversationId: 'conversation-b',
          provider: 'shared-provider',
          model: 'model-b',
        },
        userLimit: 4,
      },
      {
        name: 'model limit',
        config: { modelGenerationConcurrency: 1 },
        first: {
          userId: 'user-a',
          generationId: 'generation-a',
          conversationId: 'conversation-a',
          provider: 'shared-provider',
          model: 'shared-model',
        },
        second: {
          userId: 'user-b',
          generationId: 'generation-b',
          conversationId: 'conversation-b',
          provider: 'shared-provider',
          model: 'shared-model',
        },
        userLimit: 4,
      },
      {
        name: 'user limit',
        config: {},
        first: {
          userId: 'shared-user',
          generationId: 'generation-a',
          conversationId: 'conversation-a',
        },
        second: {
          userId: 'shared-user',
          generationId: 'generation-b',
          conversationId: 'conversation-b',
        },
        userLimit: 1,
      },
      {
        name: 'conversation lock',
        config: {},
        first: {
          userId: 'shared-user',
          generationId: 'generation-a',
          conversationId: 'shared-conversation',
        },
        second: {
          userId: 'shared-user',
          generationId: 'generation-b',
          conversationId: 'shared-conversation',
        },
        userLimit: 4,
      },
    ] as const) {
      await context.test(`enforces ${scenario.name} atomically`, async () => {
        const prefix = `${rootPrefix}${scenario.name.replace(' ', '-')}:`
        const config = queueConfig(prefix, scenario.config)
        const firstQueue = new GenerationQueue(config, client)
        const secondQueue = new GenerationQueue(config, client)
        const firstLease = queueLease(firstQueue, scenario.first)
        const secondLease = queueLease(secondQueue, scenario.second)

        const acquired = await Promise.all([
          firstQueue.acquire(firstLease, scenario.userLimit),
          secondQueue.acquire(secondLease, scenario.userLimit),
        ])

        assert.equal(acquired.filter(Boolean).length, 1)
        if (acquired[0]) await firstQueue.release(firstLease)
        if (acquired[1]) await secondQueue.release(secondLease)
      })
    }

    await context.test('stale release cannot remove a newer lease', async () => {
      const prefix = `${rootPrefix}lease-ownership:`
      const config = queueConfig(prefix, { generationLockLeaseMs: 200 })
      const oldQueue = new GenerationQueue(config, client)
      const newQueue = new GenerationQueue(config, client)
      const values = {
        userId: 'user-a',
        generationId: 'generation-a',
        conversationId: 'conversation-a',
      }
      const oldLease = queueLease(oldQueue, values)
      const newLease = queueLease(newQueue, values)

      assert.equal(await oldQueue.acquire(oldLease, 1), true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(await newQueue.acquire(newLease, 1), true)

      await oldQueue.release(oldLease)

      assert.equal(await newQueue.renew(newLease), true)
      assert.equal(await redis.zCard(`${prefix}running:global`), 1)
      assert.equal(
        await redis.get(
          `${prefix}conversation:${values.userId}:${values.conversationId}:lock`,
        ),
        newLease.token,
      )
      assert.equal(
        await redis.get(
          `${prefix}generation:${values.userId}:${values.generationId}:lease`,
        ),
        newLease.token,
      )
    })
  } finally {
    const keys = await redis.keys(`${rootPrefix}*`)
    if (keys.length > 0) await redis.del(keys)
    await redis.close()
  }
})
