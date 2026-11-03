import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'

import { dependencyUnavailable } from './app.js'
import { mockUserInfoResponse } from './auth.js'
import { BackgroundQueue } from './backgroundJobs.js'
import { GenerationQueue } from './generationQueue.js'
import { applyMonthlyQuota, createRedisClient, readMonthlyQuota, redisKey, RedisUnavailableError } from './cache.js'
import type { AppConfig } from './config.js'
import { closeDatabase, createChat, createDatabase, createGenerationStart, deleteChat, migrateDatabase, syncUser } from './db.js'
import { runRetention } from './retention.js'
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

test('retention purges expired rows, rolls up usage and hard-deletes old deleted chats', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    const keep = await createChat(database, user.id, 'keep')
    const doomed = await createChat(database, user.id, 'doomed')
    for (const chat of [keep, doomed]) {
      await createGenerationStart(database, {
        userId: user.id,
        chatId: chat.id,
        clientMessageId: crypto.randomUUID(),
        content: 'hello',
        generationId: crypto.randomUUID(),
        streamId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        provider: 'qwen',
        model: 'test',
      })
    }
    await deleteChat(database, user.id, doomed.id)
    await database.execute(sql`update "Chat" set "deletedAt" = now() - interval '31 days' where id = ${doomed.id}`)

    // Usage: two old events in the same month, one recent.
    const old = sql`date_trunc('month', now(), 'UTC') - interval '5 months' + interval '3 days'`
    await database.execute(sql`
      insert into "UsageEvent" ("userId", kind, "inputTokens", "outputTokens", "createdAt") values
        (${user.id}, 'chat', 100, 10, ${old}),
        (${user.id}, 'chat', 200, 20, ${old}),
        (${user.id}, 'chat', 5, 5, now())
    `)
    await database.execute(sql`
      insert into "AuditLog" ("actorUserId", action, "createdAt") values
        (${user.id}, 'retention.test.old', now() - interval '100 days'),
        (${user.id}, 'retention.test.new', now())
    `)

    const result = await runRetention(database, { batchSize: 1 })
    assert.ok((result.Chat ?? 0) >= 1, JSON.stringify(result))
    assert.ok((result.UsageEvent ?? 0) >= 2, JSON.stringify(result))

    const chats = await database.execute<{ id: string }>(sql`select id from "Chat" where "userId" = ${user.id}`)
    assert.deepEqual(chats.rows.map((row) => row.id), [keep.id], 'old deleted chat purged, live chat kept')
    const orphans = await database.execute<{ n: number }>(sql`
      select (select count(*) from "Message" where "chatId" = ${doomed.id})::int
           + (select count(*) from "Generation" where "chatId" = ${doomed.id})::int as n
    `)
    assert.equal(orphans.rows[0]!.n, 0, 'messages and generations cascade')

    const raw = await database.execute<{ n: number }>(sql`select count(*)::int as n from "UsageEvent" where "userId" = ${user.id}`)
    assert.equal(raw.rows[0]!.n, 1, 'only the recent usage event stays raw')
    const monthly = await database.execute<{ events: string; input: string; output: string }>(sql`
      select events::text, "inputTokens"::text as input, "outputTokens"::text as output from "UsageMonthly" where "userId" = ${user.id}
    `)
    assert.deepEqual(monthly.rows, [{ events: '2', input: '300', output: '30' }])

    const audit = await database.execute<{ action: string }>(sql`select action from "AuditLog" where "actorUserId" = ${user.id} and action like 'retention.test.%'`)
    assert.deepEqual(audit.rows.map((row) => row.action), ['retention.test.new'])

    // Idempotent: a second run changes nothing for this user.
    await runRetention(database)
    const again = await database.execute<{ events: string }>(sql`select events::text from "UsageMonthly" where "userId" = ${user.id}`)
    assert.deepEqual(again.rows, [{ events: '2' }])
    await database.delete(users).where(eq(users.id, user.id))
  } finally {
    await closeDatabase(database)
  }
})

test('draining a user\'s generation queue leaves no per-user keys behind', { skip: !redisUrl }, async () => {
  const config = { redisUrl, redisPrefix: `test:genq:${crypto.randomUUID()}:` } as unknown as AppConfig
  const redis = createRedisClient(config)
  await redis.connect()
  try {
    const queue = new GenerationQueue(config, redis)
    const userId = crypto.randomUUID()
    await queue.enqueue({ generationId: crypto.randomUUID(), userId, attempt: 0 }, 1)
    await queue.enqueue({ generationId: crypto.randomUUID(), userId, attempt: 0 }, 1)
    assert.ok(await queue.pop())
    assert.equal(await redis.exists(redisKey(config, `queue:tenant:${userId}`)), 1, 'kept while entries remain')
    assert.ok(await queue.pop())
    assert.equal(await redis.exists(redisKey(config, `queue:tenant:${userId}`)), 0)
    assert.equal(Number(await redis.hExists(redisKey(config, 'queue:user-weights'), userId)), 0)
    assert.equal(await queue.pop(), null)
  } finally {
    await redis.close()
  }
})
