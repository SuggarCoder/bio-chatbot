import { and, eq, inArray, lte, sql } from 'drizzle-orm'

import type { AppConfig } from './config.js'
import type { CurrentUser } from './domain.js'
import type { Database } from './db.js'
import {
  generations,
  messages,
  outboxEvents,
  users,
} from './db/schema.js'
import { redisKey, type RedisClient } from './cache.js'

export type GenerationQueueJob = {
  userId: string
  generationId: string
  attempt: number
}

export type GenerationWorkItem = {
  generationId: string
  streamId: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  supersedesGenerationId: string | null
  provider: string
  model: string
  attempt: number
  content: string
  artifactId?: string
  replacesMessageId?: string
  contextMaxSeq?: number
  user: CurrentUser
}

export type QueueLease = {
  userId: string
  generationId: string
  conversationId: string
  provider: string
  model: string
  workerId: string
}

export type OutboxRow = {
  id: string
  userId: string
  aggregateId: string
  attempts: number
  generationAttempt: number
  schedulingWeight: number
}

const enqueueScript = `
if redis.call('SET', KEYS[3], '1', 'EX', 86400, 'NX') == false then
  return 0
end
redis.call('XADD', KEYS[4], '*',
  'generationId', ARGV[1],
  'userId', ARGV[2],
  'attempt', ARGV[3])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[4])
if redis.call('ZSCORE', KEYS[1], ARGV[2]) == false then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local score = 0
  if first[2] then score = tonumber(first[2]) end
  redis.call('ZADD', KEYS[1], score, ARGV[2])
end
redis.call('PUBLISH', ARGV[5], ARGV[2])
return 1
`

const popScript = `
local selected = redis.call('ZRANGE', KEYS[1], 0, 0)
if not selected[1] then return nil end
local userId = selected[1]
local queueKey = ARGV[1] .. userId
local entries = redis.call('XRANGE', queueKey, '-', '+', 'COUNT', 1)
if not entries[1] then
  redis.call('ZREM', KEYS[1], userId)
  return nil
end
local entryId = entries[1][1]
local fields = entries[1][2]
local generationId = nil
local attempt = '0'
for index = 1, #fields, 2 do
  if fields[index] == 'generationId' then generationId = fields[index + 1] end
  if fields[index] == 'attempt' then attempt = fields[index + 1] end
end
if not generationId then
  redis.call('XDEL', queueKey, entryId)
  return nil
end
redis.call('XDEL', queueKey, entryId)
redis.call('DEL', ARGV[2] .. userId .. ':' .. generationId .. ':' .. attempt)
local weight = tonumber(redis.call('HGET', KEYS[2], userId) or '1')
local score = tonumber(redis.call('ZSCORE', KEYS[1], userId) or '0')
if redis.call('XLEN', queueKey) == 0 then
  redis.call('ZREM', KEYS[1], userId)
else
  redis.call('ZADD', KEYS[1], score + (1 / math.max(weight, 1)), userId)
end
return {userId, generationId, attempt}
`

const acquireScript = `
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
for index = 1, 4 do
  redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', now)
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) then return 0 end
if redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[6]) then return 0 end
if redis.call('SET', KEYS[5], ARGV[7], 'NX', 'PX', ARGV[9]) == false then return 0 end
redis.call('ZADD', KEYS[1], expires, ARGV[7])
redis.call('ZADD', KEYS[2], expires, ARGV[7])
redis.call('ZADD', KEYS[3], expires, ARGV[7])
redis.call('ZADD', KEYS[4], expires, ARGV[7])
redis.call('SET', KEYS[6], ARGV[8], 'PX', ARGV[9])
return 1
`

const renewScript = `
if redis.call('GET', KEYS[5]) ~= ARGV[2] then return 0 end
if redis.call('GET', KEYS[6]) ~= ARGV[3] then return 0 end
for index = 1, 4 do
  redis.call('ZADD', KEYS[index], ARGV[1], ARGV[2])
end
redis.call('PEXPIRE', KEYS[5], ARGV[4])
redis.call('PEXPIRE', KEYS[6], ARGV[4])
return 1
`

const releaseScript = `
for index = 1, 4 do redis.call('ZREM', KEYS[index], ARGV[1]) end
if redis.call('GET', KEYS[5]) == ARGV[1] then redis.call('DEL', KEYS[5]) end
if redis.call('GET', KEYS[6]) == ARGV[2] then redis.call('DEL', KEYS[6]) end
return 1
`

function modelKeyPart(value: string): string {
  return encodeURIComponent(value.toLowerCase())
}

export class GenerationQueue {
  readonly workerId = `worker-${crypto.randomUUID()}`

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisClient,
  ) {}

  private readyKey(): string {
    return redisKey(this.config, 'queue:ready-users')
  }

  private weightsKey(): string {
    return redisKey(this.config, 'queue:user-weights')
  }

  private queueKey(userId: string): string {
    return redisKey(this.config, `queue:tenant:${userId}`)
  }

  private dedupeKey(job: GenerationQueueJob): string {
    return redisKey(
      this.config,
      `queue:dedupe:${job.userId}:${job.generationId}:${job.attempt}`,
    )
  }

  async enqueue(job: GenerationQueueJob, schedulingWeight: number): Promise<void> {
    await this.redis.eval(enqueueScript, {
      keys: [
        this.readyKey(),
        this.weightsKey(),
        this.dedupeKey(job),
        this.queueKey(job.userId),
      ],
      arguments: [
        job.generationId,
        job.userId,
        String(job.attempt),
        String(schedulingWeight),
        redisKey(this.config, 'queue:wakeup'),
      ],
    })
  }

  async defer(job: GenerationQueueJob, schedulingWeight: number): Promise<void> {
    await this.enqueue(job, schedulingWeight)
    await this.redis.zIncrBy(
      this.readyKey(),
      1 / Math.max(1, schedulingWeight),
      job.userId,
    )
  }

  async pop(): Promise<GenerationQueueJob | null> {
    const result = await this.redis.eval(popScript, {
      keys: [this.readyKey(), this.weightsKey()],
      arguments: [
        redisKey(this.config, 'queue:tenant:'),
        redisKey(this.config, 'queue:dedupe:'),
      ],
    })
    if (!Array.isArray(result) || result.length < 3) return null
    return {
      userId: String(result[0]),
      generationId: String(result[1]),
      attempt: Number(result[2]),
    }
  }

  private leaseKeys(lease: QueueLease): string[] {
    return [
      redisKey(this.config, 'running:global'),
      redisKey(this.config, `running:provider:${modelKeyPart(lease.provider)}`),
      redisKey(
        this.config,
        `running:model:${modelKeyPart(lease.provider)}:${modelKeyPart(lease.model)}`,
      ),
      redisKey(this.config, `tenant:${lease.userId}:running`),
      redisKey(
        this.config,
        `conversation:${lease.userId}:${lease.conversationId}:lock`,
      ),
      redisKey(
        this.config,
        `generation:${lease.userId}:${lease.generationId}:lease`,
      ),
    ]
  }

  async acquire(lease: QueueLease, userLimit: number): Promise<boolean> {
    const now = Date.now()
    const result = await this.redis.eval(acquireScript, {
      keys: this.leaseKeys(lease),
      arguments: [
        String(now),
        String(now + this.config.generationLockLeaseMs),
        String(this.config.globalGenerationConcurrency),
        String(this.config.providerGenerationConcurrency),
        String(this.config.modelGenerationConcurrency),
        String(userLimit),
        lease.generationId,
        lease.workerId,
        String(this.config.generationLockLeaseMs),
      ],
    })
    return Number(result) === 1
  }

  async renew(lease: QueueLease): Promise<boolean> {
    const result = await this.redis.eval(renewScript, {
      keys: this.leaseKeys(lease),
      arguments: [
        String(Date.now() + this.config.generationLockLeaseMs),
        lease.generationId,
        lease.workerId,
        String(this.config.generationLockLeaseMs),
      ],
    })
    return Number(result) === 1
  }

  async release(lease: QueueLease): Promise<void> {
    await this.redis.eval(releaseScript, {
      keys: this.leaseKeys(lease),
      arguments: [lease.generationId, lease.workerId],
    })
  }

  async requestCancellation(userId: string, generationId: string): Promise<void> {
    const key = redisKey(
      this.config,
      `generation:${userId}:${generationId}:cancel`,
    )
    await Promise.all([
      this.redis.set(key, '1', { EX: 60 * 60 }),
      this.redis.publish(redisKey(this.config, 'worker:cancel'), JSON.stringify({
        type: 'generation.cancel',
        userId,
        generationId,
      })),
    ])
  }

  async cancellationRequested(userId: string, generationId: string): Promise<boolean> {
    return await this.redis.exists(redisKey(
      this.config,
      `generation:${userId}:${generationId}:cancel`,
    )) > 0
  }

  async saveSnapshot(
    userId: string,
    generationId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await this.redis.set(
      redisKey(this.config, `generation:${userId}:${generationId}:snapshot`),
      JSON.stringify(snapshot),
      { EX: 60 * 60 },
    )
  }

  async readSnapshot(
    userId: string,
    generationId: string,
  ): Promise<Record<string, unknown> | null> {
    const value = await this.redis.get(redisKey(
      this.config,
      `generation:${userId}:${generationId}:snapshot`,
    ))
    if (!value) return null
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async hasLease(userId: string, generationId: string): Promise<boolean> {
    return await this.redis.exists(redisKey(
      this.config,
      `generation:${userId}:${generationId}:lease`,
    )) > 0
  }

  async heartbeat(): Promise<void> {
    const value = new Date().toISOString()
    await Promise.all([
      this.redis.set(
        redisKey(this.config, `worker:${this.workerId}:heartbeat`),
        value,
        { EX: 30 },
      ),
      this.redis.set(
        redisKey(this.config, 'worker:heartbeat'),
        value,
        { EX: 30 },
      ),
    ])
  }
}

export async function claimOutboxBatch(database: Database): Promise<OutboxRow[]> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        id: outboxEvents.id,
        userId: outboxEvents.userId,
        aggregateId: outboxEvents.aggregateId,
        attempts: outboxEvents.attempts,
        generationAttempt: generations.attempt,
        schedulingWeight: users.schedulingWeight,
      })
      .from(outboxEvents)
      .innerJoin(users, eq(users.id, outboxEvents.userId))
      .innerJoin(generations, eq(generations.id, outboxEvents.aggregateId))
      .where(and(
        eq(outboxEvents.status, 'pending'),
        lte(outboxEvents.availableAt, sql`now()`),
      ))
      .orderBy(outboxEvents.createdAt)
      .limit(25)
      .for('update', { skipLocked: true })

    if (rows.length > 0) {
      await transaction
        .update(outboxEvents)
        .set({
          attempts: sql`${outboxEvents.attempts} + 1`,
          availableAt: sql`now() + interval '30 seconds'`,
          updatedAt: sql`now()`,
        })
        .where(inArray(outboxEvents.id, rows.map((row) => row.id)))
    }
    return rows
  })
}

export async function markOutboxPublished(
  database: Database,
  row: OutboxRow,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .update(outboxEvents)
      .set({
        status: 'published',
        publishedAt: sql`now()`,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(outboxEvents.id, row.id))
    await transaction
      .update(generations)
      .set({
        status: 'queued',
        queuedAt: sql`coalesce(${generations.queuedAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(generations.id, row.aggregateId),
        eq(generations.status, 'created'),
      ))
  })
}

export async function markOutboxFailed(
  database: Database,
  row: OutboxRow,
  error: unknown,
): Promise<void> {
  const permanentlyFailed = row.attempts + 1 >= 20
  const errorMessage = error instanceof Error ? error.message : String(error)
  await database.transaction(async (transaction) => {
    await transaction
      .update(outboxEvents)
      .set({
        status: permanentlyFailed ? 'failed' : 'pending',
        availableAt: sql`now() + make_interval(secs => least(300, power(2, ${row.attempts + 1})::int))`,
        lastError: errorMessage,
        updatedAt: sql`now()`,
      })
      .where(eq(outboxEvents.id, row.id))
    if (!permanentlyFailed) return
    const [generation] = await transaction
      .update(generations)
      .set({
        status: 'failed',
        errorCode: 'queue_publish_failed',
        errorMessage,
        finishReason: 'failed',
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(generations.id, row.aggregateId),
        eq(generations.status, 'created'),
      ))
      .returning({ assistantMessageId: generations.assistantMessageId })
    if (generation) {
      await transaction
        .update(messages)
        .set({ status: 'failed', updatedAt: sql`now()` })
        .where(eq(messages.id, generation.assistantMessageId))
    }
  })
}

export async function loadGenerationWorkItem(
  database: Database,
  job: GenerationQueueJob,
): Promise<GenerationWorkItem | null> {
  const [row] = await database
    .select({
      generationId: generations.id,
      streamId: generations.streamId,
      conversationId: generations.chatId,
      userMessageId: generations.userMessageId,
      assistantMessageId: generations.assistantMessageId,
      supersedesGenerationId: generations.supersedesGenerationId,
      provider: generations.provider,
      model: generations.model,
      attempt: generations.attempt,
      metadata: generations.metadata,
      content: messages.content,
      userId: users.id,
      externalUserId: users.externalUserId,
      externalTeamId: users.externalTeamId,
      realName: users.realName,
      userName: users.userName,
      jobTitle: users.jobTitle,
      researchField: users.researchField,
      email: users.email,
      name: users.name,
      image: users.image,
      gpas2Role: users.gpas2Role,
      serviceTier: users.serviceTier,
      schedulingWeight: users.schedulingWeight,
      generationConcurrencyLimit: users.generationConcurrencyLimit,
      maxQueuedGenerations: users.maxQueuedGenerations,
    })
    .from(generations)
    .innerJoin(users, eq(users.id, generations.userId))
    .innerJoin(messages, eq(messages.id, generations.userMessageId))
    .where(and(
      eq(generations.id, job.generationId),
      eq(generations.userId, job.userId),
      eq(generations.status, 'queued'),
    ))
    .limit(1)
  if (!row) return null
  const metadata = row.metadata as Record<string, unknown>
  return {
    generationId: row.generationId,
    streamId: row.streamId,
    conversationId: row.conversationId,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    supersedesGenerationId: row.supersedesGenerationId,
    provider: row.provider,
    model: row.model,
    attempt: row.attempt,
    content: row.content ?? '',
    artifactId: typeof metadata.artifactId === 'string'
      ? metadata.artifactId
      : undefined,
    replacesMessageId: typeof metadata.replacesMessageId === 'string'
      ? metadata.replacesMessageId
      : undefined,
    contextMaxSeq: typeof metadata.contextMaxSeq === 'number'
      ? metadata.contextMaxSeq
      : undefined,
    user: {
      id: row.userId,
      externalUserId: row.externalUserId,
      externalTeamId: row.externalTeamId,
      realName: row.realName,
      userName: row.userName,
      jobTitle: row.jobTitle,
      researchField: row.researchField,
      email: row.email,
      name: row.name,
      image: row.image,
      gpas2Role: row.gpas2Role,
      serviceTier: row.serviceTier as CurrentUser['serviceTier'],
      schedulingWeight: row.schedulingWeight,
      generationConcurrencyLimit: row.generationConcurrencyLimit,
      maxQueuedGenerations: row.maxQueuedGenerations,
    },
  }
}

export async function claimGeneration(
  database: Database,
  item: GenerationWorkItem,
  workerId: string,
): Promise<boolean> {
  const rows = await database
    .update(generations)
    .set({
      status: 'scheduled',
      workerId,
      attempt: sql`${generations.attempt} + 1`,
      scheduledAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(generations.id, item.generationId),
      eq(generations.userId, item.user.id),
      eq(generations.status, 'queued'),
    ))
    .returning({ id: generations.id })
  return rows.length > 0
}

export async function listQueuedGenerationJobs(
  database: Database,
): Promise<Array<GenerationQueueJob & { schedulingWeight: number }>> {
  return database
    .select({
      userId: generations.userId,
      generationId: generations.id,
      attempt: generations.attempt,
      schedulingWeight: users.schedulingWeight,
    })
    .from(generations)
    .innerJoin(users, eq(users.id, generations.userId))
    .where(eq(generations.status, 'queued'))
    .orderBy(generations.queuedAt)
    .limit(500)
}

export type StaleGeneration = {
  generationId: string
  userId: string
  status: string
  providerRequestStartedAt: Date | null
  attempt: number
  schedulingWeight: number
}

export async function listStaleGenerations(
  database: Database,
): Promise<StaleGeneration[]> {
  return database
    .select({
      generationId: generations.id,
      userId: generations.userId,
      status: generations.status,
      providerRequestStartedAt: generations.providerRequestStartedAt,
      attempt: generations.attempt,
      schedulingWeight: users.schedulingWeight,
    })
    .from(generations)
    .innerJoin(users, eq(users.id, generations.userId))
    .where(and(
      inArray(generations.status, ['scheduled', 'running', 'cancelling']),
      lte(generations.updatedAt, sql`now() - interval '45 seconds'`),
    ))
    .limit(100)
}

export async function requeueStaleGeneration(
  database: Database,
  stale: StaleGeneration,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction
      .update(generations)
      .set({
        status: 'created',
        workerId: null,
        scheduledAt: null,
        startedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(generations.id, stale.generationId),
        eq(generations.userId, stale.userId),
        inArray(generations.status, ['scheduled', 'running']),
        sql`${generations.providerRequestStartedAt} is null`,
      ))
      .returning({ assistantMessageId: generations.assistantMessageId })
    if (!row) return false
    await transaction
      .update(messages)
      .set({ status: 'pending', updatedAt: sql`now()` })
      .where(eq(messages.id, row.assistantMessageId))
    await transaction.insert(outboxEvents).values({
      userId: stale.userId,
      type: 'generation.requeued',
      aggregateId: stale.generationId,
      payload: {
        generationId: stale.generationId,
        userId: stale.userId,
        attempt: stale.attempt,
      },
    })
    return true
  })
}
