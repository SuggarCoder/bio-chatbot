import assert from 'node:assert/strict'
import test from 'node:test'

import { BackgroundQueue } from './backgroundJobs.js'
import { createRedisClient } from './cache.js'
import type { AppConfig } from './config.js'

const redisUrl = process.env.TEST_REDIS_URL?.trim()

test('releasing a background lease never deletes a lease another worker took over', { skip: !redisUrl }, async () => {
  const config = {
    redisUrl,
    redisPrefix: `test:background:${crypto.randomUUID()}:`,
    backgroundTimeoutMs: 30_000,
  } as unknown as AppConfig
  const redis = createRedisClient(config)
  await redis.connect()
  try {
    const first = new BackgroundQueue(config, redis)
    const second = new BackgroundQueue(config, redis)
    const token = await first.acquire('job-1')
    assert.ok(token)
    assert.equal(await second.acquire('job-1'), null, 'held')

    // The first lease expires and the second worker takes the job over.
    await redis.del(`${config.redisPrefix}maintenance:job-1:lease`)
    const takeover = await second.acquire('job-1')
    assert.ok(takeover)
    await first.release('job-1', token!)
    assert.equal(await redis.get(`${config.redisPrefix}maintenance:job-1:lease`), takeover)

    await second.release('job-1', takeover!)
    assert.equal(await redis.get(`${config.redisPrefix}maintenance:job-1:lease`), null)
  } finally {
    await redis.close()
  }
})
