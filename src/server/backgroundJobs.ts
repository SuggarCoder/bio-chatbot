import { and, eq, inArray, lte, notExists, or, sql } from 'drizzle-orm'

import { redisKey, type RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import type { Database } from './db/client.js'
import {
  backgroundJobs,
  artifacts,
  artifactVersions,
  outboxEvents,
  usageEvents,
} from './db/schema.js'

export type BackgroundJobType = 'chat.summary' | 'user.memory' | 'artifact.index'
export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0]
type DatabaseExecutor = Database | DatabaseTransaction

export type BackgroundQueueJob = {
  jobId: string
  userId: string
  attempt: number
}

export type BackgroundWorkItem = BackgroundQueueJob & {
  type: BackgroundJobType
  chatId: string | null
  artifactVersionId: string | null
  payload: Record<string, unknown>
}

export async function enqueueBackgroundJob(
  database: DatabaseExecutor,
  input: {
    userId: string
    type: BackgroundJobType
    dedupeKey: string
    chatId?: string
    artifactVersionId?: string
    payload?: Record<string, unknown>
  },
): Promise<string | null> {
  const [job] = await database
    .insert(backgroundJobs)
    .values({
      userId: input.userId,
      type: input.type,
      dedupeKey: input.dedupeKey,
      chatId: input.chatId,
      artifactVersionId: input.artifactVersionId,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: backgroundJobs.dedupeKey })
    .returning({ id: backgroundJobs.id })
  if (!job) return null

  await database.insert(outboxEvents).values({
    userId: input.userId,
    type: 'background.created',
    aggregateId: job.id,
    payload: {
      jobId: job.id,
      type: input.type,
    },
  })
  return job.id
}

export async function enqueuePendingArtifactIndexJobs(
  database: Database,
): Promise<number> {
  const rows = await database
    .select({
      id: artifactVersions.id,
      userId: artifactVersions.userId,
      artifactId: artifactVersions.artifactId,
      version: artifactVersions.version,
      chatId: artifacts.chatId,
    })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(
      inArray(artifactVersions.outlineStatus, ['pending', 'failed']),
      notExists(
        database
          .select({ id: backgroundJobs.id })
          .from(backgroundJobs)
          .where(and(
            eq(backgroundJobs.artifactVersionId, artifactVersions.id),
            inArray(backgroundJobs.status, ['created', 'queued', 'running']),
          )),
      ),
    ))
    .orderBy(artifactVersions.createdAt)
    .limit(100)
  let inserted = 0
  for (const row of rows) {
    const jobId = await enqueueBackgroundJob(database, {
      userId: row.userId,
      type: 'artifact.index',
      dedupeKey: `artifact.index.backfill:${row.artifactId}:${row.version}`,
      ...(row.chatId ? { chatId: row.chatId } : {}),
      artifactVersionId: row.id,
      payload: { artifactId: row.artifactId, version: row.version },
    })
    if (jobId) inserted += 1
  }
  return inserted
}

export class BackgroundQueue {
  readonly workerId = `maintenance-${crypto.randomUUID()}`

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisClient,
  ) {}

  private streamKey(): string {
    return redisKey(this.config, 'queue:maintenance')
  }

  private dedupeKey(job: BackgroundQueueJob): string {
    return redisKey(
      this.config,
      `queue:maintenance:dedupe:${job.jobId}:${job.attempt}`,
    )
  }

  private leaseKey(jobId: string): string {
    return redisKey(this.config, `maintenance:${jobId}:lease`)
  }

  async enqueue(job: BackgroundQueueJob): Promise<void> {
    const inserted = await this.redis.set(this.dedupeKey(job), '1', {
      NX: true,
      EX: 86_400,
    })
    if (!inserted) return
    await this.redis.xAdd(this.streamKey(), '*', {
      jobId: job.jobId,
      userId: job.userId,
      attempt: String(job.attempt),
    })
  }

  async pop(): Promise<BackgroundQueueJob | null> {
    const rows = await this.redis.xRange(this.streamKey(), '-', '+', { COUNT: 1 })
    const row = rows[0]
    if (!row) return null
    await this.redis.xDel(this.streamKey(), row.id)
    const job = {
      jobId: String(row.message.jobId ?? ''),
      userId: String(row.message.userId ?? ''),
      attempt: Number(row.message.attempt ?? 0),
    }
    if (!job.jobId || !job.userId || !Number.isSafeInteger(job.attempt)) {
      return null
    }
    await this.redis.del(this.dedupeKey(job))
    return job
  }

  async acquire(jobId: string): Promise<string | null> {
    const token = `${this.workerId}:${crypto.randomUUID()}`
    const acquired = await this.redis.set(this.leaseKey(jobId), token, {
      NX: true,
      PX: Math.max(this.config.backgroundTimeoutMs, 30_000),
    })
    return acquired ? token : null
  }

  async release(jobId: string, token: string): Promise<void> {
    const key = this.leaseKey(jobId)
    if (await this.redis.get(key) === token) await this.redis.del(key)
  }
}

type BackgroundOutboxRow = {
  id: string
  userId: string
  aggregateId: string
  attempts: number
  jobAttempt: number
}

export async function claimBackgroundOutboxBatch(
  database: Database,
): Promise<BackgroundOutboxRow[]> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        id: outboxEvents.id,
        userId: outboxEvents.userId,
        aggregateId: outboxEvents.aggregateId,
        attempts: outboxEvents.attempts,
        jobAttempt: backgroundJobs.attempt,
      })
      .from(outboxEvents)
      .innerJoin(backgroundJobs, eq(backgroundJobs.id, outboxEvents.aggregateId))
      .where(and(
        eq(outboxEvents.type, 'background.created'),
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

export async function markBackgroundOutboxPublished(
  database: Database,
  row: BackgroundOutboxRow,
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
      .update(backgroundJobs)
      .set({ status: 'queued', updatedAt: sql`now()` })
      .where(and(
        eq(backgroundJobs.id, row.aggregateId),
        eq(backgroundJobs.status, 'created'),
      ))
  })
}

export async function markBackgroundOutboxFailed(
  database: Database,
  row: BackgroundOutboxRow,
  error: unknown,
): Promise<void> {
  const permanentlyFailed = row.attempts + 1 >= 20
  const message = error instanceof Error ? error.message : String(error)
  await database.transaction(async (transaction) => {
    await transaction
      .update(outboxEvents)
      .set({
        status: permanentlyFailed ? 'failed' : 'pending',
        availableAt: sql`now() + make_interval(secs => least(300, power(2, ${row.attempts + 1})::int))`,
        lastError: message,
        updatedAt: sql`now()`,
      })
      .where(eq(outboxEvents.id, row.id))
    if (permanentlyFailed) {
      await transaction
        .update(backgroundJobs)
        .set({
          status: 'failed',
          error: message,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(backgroundJobs.id, row.aggregateId))
    }
  })
}

export async function listQueuedBackgroundJobs(
  database: Database,
): Promise<BackgroundQueueJob[]> {
  const rows = await database
    .select({
      jobId: backgroundJobs.id,
      userId: backgroundJobs.userId,
      attempt: backgroundJobs.attempt,
    })
    .from(backgroundJobs)
    .where(or(
      and(
        inArray(backgroundJobs.status, ['created', 'queued']),
        lte(backgroundJobs.availableAt, sql`now()`),
      ),
      and(
        eq(backgroundJobs.status, 'running'),
        lte(backgroundJobs.startedAt, sql`now() - interval '5 minutes'`),
      ),
    ))
    .orderBy(backgroundJobs.createdAt)
    .limit(100)
  return rows
}

export async function claimBackgroundJob(
  database: Database,
  job: BackgroundQueueJob,
  workerId: string,
): Promise<BackgroundWorkItem | null> {
  const [row] = await database
    .update(backgroundJobs)
    .set({
      status: 'running',
      workerId,
      startedAt: sql`now()`,
      attempt: sql`${backgroundJobs.attempt} + 1`,
      error: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(backgroundJobs.id, job.jobId),
      eq(backgroundJobs.userId, job.userId),
      inArray(backgroundJobs.status, ['created', 'queued', 'running']),
      lte(backgroundJobs.availableAt, sql`now()`),
    ))
    .returning({
      jobId: backgroundJobs.id,
      userId: backgroundJobs.userId,
      type: backgroundJobs.type,
      chatId: backgroundJobs.chatId,
      artifactVersionId: backgroundJobs.artifactVersionId,
      payload: backgroundJobs.payload,
      attempt: backgroundJobs.attempt,
    })
  return row
    ? { ...row, type: row.type as BackgroundJobType }
    : null
}

export async function completeBackgroundJob(
  database: Database,
  job: BackgroundWorkItem,
  usage?: { kind: 'summary' | 'memory'; inputTokens: number; outputTokens: number },
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .update(backgroundJobs)
      .set({
        status: 'completed',
        workerId: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(backgroundJobs.id, job.jobId))
    if (usage) {
      await transaction
        .insert(usageEvents)
        .values({
          userId: job.userId,
          backgroundJobId: job.jobId,
          kind: usage.kind,
          inputTokens: BigInt(usage.inputTokens),
          outputTokens: BigInt(usage.outputTokens),
        })
        .onConflictDoNothing({
          target: usageEvents.backgroundJobId,
          where: sql`${usageEvents.backgroundJobId} is not null`,
        })
    }
  })
}

export async function failBackgroundJob(
  database: Database,
  job: BackgroundWorkItem,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error)
  const retry = job.attempt < 5
  await database
    .update(backgroundJobs)
    .set({
      status: retry ? 'queued' : 'failed',
      workerId: null,
      availableAt: retry
        ? sql`now() + make_interval(secs => least(300, power(2, ${job.attempt})::int))`
        : sql`now()`,
      finishedAt: retry ? null : sql`now()`,
      error: message,
      updatedAt: sql`now()`,
    })
    .where(eq(backgroundJobs.id, job.jobId))
  return retry
}
