import assert from 'node:assert/strict'
import test from 'node:test'

import type { RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import { GenerationQueue } from './generationQueue.js'

class FakeRedis {
  evaluations: Array<{
    keys: string[]
    arguments: string[]
  }> = []
  publications: Array<{ channel: string; payload: string }> = []
  values = new Map<string, string>()

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number> {
    this.evaluations.push(options)
    return 1
  }

  async set(key: string, value: string): Promise<string> {
    this.values.set(key, value)
    return 'OK'
  }

  async publish(channel: string, payload: string): Promise<number> {
    this.publications.push({ channel, payload })
    return 1
  }
}

const config = {
  redisPrefix: 'test:v3:',
  globalGenerationConcurrency: 4,
  providerGenerationConcurrency: 3,
  modelGenerationConcurrency: 2,
  generationLockLeaseMs: 30_000,
} as unknown as AppConfig

test('queue keys and lease arguments are user scoped', async () => {
  const redis = new FakeRedis()
  const queue = new GenerationQueue(config, redis as unknown as RedisClient)
  const job = {
    userId: '11111111-1111-4111-8111-111111111111',
    generationId: '22222222-2222-4222-8222-222222222222',
    attempt: 0,
    schedulingScore: 1.25,
  }

  await queue.defer(job, 4)
  const deferred = redis.evaluations[0]
  assert.ok(deferred.keys.includes(`test:v3:queue:tenant:${job.userId}`))
  assert.ok(deferred.keys.some((key) => key.includes(job.generationId)))
  assert.equal(deferred.arguments.at(-1), '1.25')

  const token = `lease:${crypto.randomUUID()}`
  const queueLease = {
    userId: job.userId,
    generationId: job.generationId,
    conversationId: '33333333-3333-4333-8333-333333333333',
    provider: 'Qwen',
    model: 'Qwen-Max',
    workerId: queue.workerId,
    token,
  }
  const acquired = await queue.acquire(queueLease, 1)
  assert.equal(acquired, true)
  const lease = redis.evaluations[1]
  assert.ok(lease.keys.includes(`test:v3:tenant:${job.userId}:running`))
  assert.ok(lease.keys.includes(
    `test:v3:conversation:${job.userId}:33333333-3333-4333-8333-333333333333:lock`,
  ))
  assert.deepEqual(lease.arguments.slice(2, 6), ['4', '3', '2', '1'])
  assert.equal(lease.arguments[6], token)

  assert.equal(await queue.renew(queueLease), true)
  await queue.release(queueLease)
  assert.equal(redis.evaluations[2].arguments[1], token)
  assert.deepEqual(redis.evaluations[3].arguments, [token])
})

test('cancellation uses both a durable-enough key and global worker Pub/Sub', async () => {
  const redis = new FakeRedis()
  const queue = new GenerationQueue(config, redis as unknown as RedisClient)
  const userId = '11111111-1111-4111-8111-111111111111'
  const generationId = '22222222-2222-4222-8222-222222222222'

  await queue.requestCancellation(userId, generationId)

  assert.equal(
    redis.values.get(`test:v3:generation:${userId}:${generationId}:cancel`),
    '1',
  )
  assert.equal(redis.publications[0].channel, 'test:v3:worker:cancel')
  assert.deepEqual(JSON.parse(redis.publications[0].payload), {
    type: 'generation.cancel',
    userId,
    generationId,
  })
})
