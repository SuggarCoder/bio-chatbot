import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'

import { dependencyUnavailable } from './app.js'
import { mockUserInfoResponse } from './auth.js'
import { BackgroundQueue } from './backgroundJobs.js'
import { applyMonthlyQuota, createRedisClient, readMonthlyQuota, redisKey, RedisUnavailableError } from './cache.js'
import type { AppConfig } from './config.js'
import { closeDatabase, createDatabase, migrateDatabase, syncUser } from './db.js'
import { users } from './db/schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL

test('dependency failures map to 503 categories', () => {
  assert.deepEqual(dependencyUnavailable(new RedisUnavailableError('down')), { dependency: 'redis', retryAfterSeconds: 5 })
  assert.equal(dependencyUnavailable(new Error('timeout exceeded when trying to connect'))?.dependency, 'database')
  assert.equal(dependencyUnavailable(Object.assign(new Error('canceling statement'), { code: '57014' }))?.dependency, 'database')
  assert.equal(dependencyUnavailable(new Error('wrapped', { cause: new RedisUnavailableError('x') }))?.dependency, 'redis')
  assert.equal(dependencyUnavailable(new Error('ordinary bug')), null)
})

test('syncing an unchanged profile does not rewrite the User row', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    const profile = { ...mockUserInfoResponse.data, userId: crypto.randomUUID() }
    const first = await syncUser(database, profile)
    const version = async () => (await database.execute<{ xmin: string }>(sql`select xmin::text from "User" where id = ${first.id}`)).rows[0]!.xmin
    const before = await version()
    const second = await syncUser(database, profile)
    assert.equal(second.id, first.id)
    assert.equal(await version(), before, 'unchanged profile: no new row version')
    await syncUser(database, { ...profile, realName: 'Changed Name' })
    assert.notEqual(await version(), before, 'changed profile is written')
    await database.delete(users).where(eq(users.id, first.id))
  } finally {
    await closeDatabase(database)
  }
})

test('hot periodic queries can use their partial indexes', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    await database.transaction(async (transaction) => {
      // Small test tables favour sequential scans; force the planner to show
      // whether an index exists for these predicates.
      await transaction.execute(sql`set local enable_seqscan = off`)
      const plan = async (query: ReturnType<typeof sql>) =>
        (await transaction.execute<{ 'QUERY PLAN': string }>(sql`explain ${query}`)).rows.map((row) => row['QUERY PLAN']).join('\n')
      const queries = [
        sql`select id from "Generation" where status = 'queued' order by "queuedAt" limit 500`,
        sql`select count(*) from "Generation" where "userId" = ${crypto.randomUUID()} and status in ('created', 'queued')`,
        sql`select id from "Generation" where "chatId" = ${crypto.randomUUID()} and status in ('created', 'queued', 'scheduled', 'running', 'cancelling')`,
        sql`select id from "Chat" where "userId" = ${crypto.randomUUID()} and "deletedAt" is null order by "updatedAt" desc, id desc limit 50`,
      ]
      for (const query of queries) {
        const text = await plan(query)
        // With sequential scans disabled, a missing index still shows up as
        // a (penalized) Seq Scan.
        assert.doesNotMatch(text, /Seq Scan/, text)
      }
    })
  } finally {
    await closeDatabase(database)
  }
})

test('background queue enqueue/pop are atomic and deduplicated', { skip: !redisUrl }, async () => {
  const config = { redisUrl, redisPrefix: `test:bgq:${crypto.randomUUID()}:`, backgroundTimeoutMs: 30_000 } as unknown as AppConfig
  const redis = createRedisClient(config)
  await redis.connect()
  try {
    const queue = new BackgroundQueue(config, redis)
    const job = { jobId: crypto.randomUUID(), userId: crypto.randomUUID(), attempt: 2 }
    await queue.enqueue(job)
    await queue.enqueue(job)
    assert.deepEqual(await queue.pop(), job)
    assert.equal(await queue.pop(), null, 'the duplicate enqueue was ignored')
    // Popping cleared the dedupe marker, so the same attempt can be re-enqueued.
    await queue.enqueue(job)
    assert.deepEqual(await queue.pop(), job)
    assert.equal(await redis.exists(redisKey(config, `queue:maintenance:dedupe:${job.jobId}:${job.attempt}`)), 0)
  } finally {
    await redis.close()
  }
})

test('a lost quota counter is rebuilt from PostgreSQL, not restarted from zero', { skip: !redisUrl || !databaseUrl }, async () => {
  const config = { redisUrl, redisPrefix: `test:quota:${crypto.randomUUID()}:` } as unknown as AppConfig
  const redis = createRedisClient(config)
  await redis.connect()
  const database = createDatabase(databaseUrl as string)
  try {
    const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    // No cached total (e.g. after a Redis restart): applying usage must not
    // create a counter that starts from zero.
    await applyMonthlyQuota(redis, config, user.id, crypto.randomUUID(), 500)
    const keys = await redis.keys(`${config.redisPrefix}quota:user:*`)
    assert.deepEqual(keys, [])
    assert.equal(await readMonthlyQuota(database, redis, config, user.id), 0, 'rebuilt from usage events')
    await applyMonthlyQuota(redis, config, user.id, crypto.randomUUID(), 500)
    assert.equal(await readMonthlyQuota(database, redis, config, user.id), 500, 'existing totals are incremented')
    await database.delete(users).where(eq(users.id, user.id))
  } finally {
    await closeDatabase(database)
    await redis.close()
  }
})
