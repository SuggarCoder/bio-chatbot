import { sql } from 'drizzle-orm'

import type { Database } from './db.js'
import { metrics } from './metrics.js'
import type { ObjectStore } from './storage/objectStore.js'

/**
 * How long operational rows are kept. User content (chats, messages,
 * memories, artifacts) is kept until the user deletes it; a deleted chat is
 * kept for a grace period, then purged with everything that hangs off it.
 */
export const RETENTION_POLICY = {
  outboxDays: 7,
  backgroundJobDays: 14,
  ingressDays: 7,
  businessOperationDays: 90,
  toolRunDays: 90,
  auditLogDays: 90,
  deletedChatDays: 30,
  /** Raw usage events are kept for the current month plus this many full months. */
  usageRawMonths: 3,
} as const

export type RetentionPolicy = { [K in keyof typeof RETENTION_POLICY]: number }

export type RetentionOptions = {
  policy?: Partial<RetentionPolicy>
  /** Rows per DELETE statement. */
  batchSize?: number
  /** Stop starting new batches after this long; the next run continues. */
  budgetMs?: number
  /** Blobs of purged artifacts are removed from here, best effort. */
  objectStore?: ObjectStore | null
  log?: Pick<Console, 'info' | 'warn'>
}

export type RetentionResult = Record<string, number>

type Rule = { table: string; condition: (cutoffDays: number) => ReturnType<typeof sql>; days: keyof RetentionPolicy }

// Each condition matches a partial or plain index from migration 0005.
const RULES: Rule[] = [
  {
    table: 'OutboxEvent',
    days: 'outboxDays',
    condition: (days) => sql`status in ('published', 'failed') and "updatedAt" < now() - make_interval(days => ${days})`,
  },
  {
    table: 'BackgroundJob',
    days: 'backgroundJobDays',
    condition: (days) => sql`"finishedAt" is not null and "finishedAt" < now() - make_interval(days => ${days})`,
  },
  {
    table: 'IngressRequest',
    days: 'ingressDays',
    condition: (days) => sql`status in ('succeeded', 'failed') and "updatedAt" < now() - make_interval(days => ${days})`,
  },
  {
    table: 'BusinessOperation',
    days: 'businessOperationDays',
    // 'uncertain' operations wait for a person to reconcile them.
    condition: (days) => sql`status in ('completed', 'failed') and "updatedAt" < now() - make_interval(days => ${days})`,
  },
  {
    table: 'ToolRun',
    days: 'toolRunDays',
    condition: (days) => sql`"startedAt" < now() - make_interval(days => ${days})`,
  },
  {
    table: 'AuditLog',
    days: 'auditLogDays',
    condition: (days) => sql`"createdAt" < now() - make_interval(days => ${days})`,
  },
]

/**
 * Deletes expired rows in small batches. Safe to run from several workers at
 * once: every batch skips rows another run has locked. Each run is bounded
 * by `budgetMs`; a backlog is worked off over consecutive runs.
 */
export async function runRetention(database: Database, options: RetentionOptions = {}): Promise<RetentionResult> {
  const policy: RetentionPolicy = { ...RETENTION_POLICY, ...options.policy }
  const batchSize = options.batchSize ?? 2_000
  const deadline = Date.now() + (options.budgetMs ?? 30_000)
  const log = options.log ?? console
  const result: RetentionResult = {}
  const count = (table: string, rows: number) => {
    if (rows <= 0) return
    result[table] = (result[table] ?? 0) + rows
    metrics.retentionDeleted.inc({ table }, rows)
  }

  for (const rule of RULES) {
    const table = sql.identifier(rule.table)
    const condition = rule.condition(policy[rule.days])
    while (Date.now() < deadline) {
      const deleted = await database.execute(sql`
        delete from ${table} where id in (
          select id from ${table} where ${condition}
          limit ${batchSize} for update skip locked
        )
      `)
      const rows = deleted.rowCount ?? 0
      count(rule.table, rows)
      if (rows < batchSize) break
    }
  }

  while (Date.now() < deadline) {
    const rows = await rollUpUsageBatch(database, policy.usageRawMonths, batchSize)
    count('UsageEvent', rows)
    if (rows < batchSize) break
  }

  while (Date.now() < deadline) {
    const purged = await purgeDeletedChatsBatch(database, policy.deletedChatDays, 20, options.objectStore ?? null, log)
    count('Chat', purged)
    if (purged < 20) break
  }

  if (Object.keys(result).length > 0) log.info('Retention removed expired rows', result)
  return result
}

/**
 * Moves raw usage events older than the retention window into UsageMonthly
 * and deletes them, in one statement so a crash cannot count them twice.
 */
async function rollUpUsageBatch(database: Database, rawMonths: number, batchSize: number): Promise<number> {
  const rolled = await database.execute<{ rows: number }>(sql`
    with doomed as (
      select id from "UsageEvent"
      where "createdAt" < date_trunc('month', now(), 'UTC') - make_interval(months => ${rawMonths})
      order by id
      limit ${batchSize}
      for update skip locked
    ), gone as (
      delete from "UsageEvent" usage using doomed
      where usage.id = doomed.id
      returning usage."userId", date_trunc('month', usage."createdAt", 'UTC') as month,
        usage.kind, usage."inputTokens", usage."outputTokens"
    ), totals as (
      insert into "UsageMonthly" ("userId", month, kind, events, "inputTokens", "outputTokens")
      select "userId", month, kind, count(*), sum("inputTokens")::bigint, sum("outputTokens")::bigint
      from gone
      group by "userId", month, kind
      on conflict ("userId", month, kind) do update set
        events = "UsageMonthly".events + excluded.events,
        "inputTokens" = "UsageMonthly"."inputTokens" + excluded."inputTokens",
        "outputTokens" = "UsageMonthly"."outputTokens" + excluded."outputTokens",
        "updatedAt" = now()
    )
    select count(*)::int as rows from gone
  `)
  return Number(rolled.rows[0]?.rows ?? 0)
}

/**
 * Hard-deletes chats soft-deleted more than `days` ago. Messages,
 * generations, summaries and chunks cascade; artifacts only lose their chat
 * link by foreign key, so they are deleted here explicitly and their blobs
 * removed once nothing references them.
 */
async function purgeDeletedChatsBatch(
  database: Database,
  days: number,
  limit: number,
  objectStore: ObjectStore | null,
  log: Pick<Console, 'warn'>,
): Promise<number> {
  const { chatIds, storageKeys } = await database.transaction(async (transaction) => {
    const doomed = await transaction.execute<{ id: string }>(sql`
      select id from "Chat"
      where "deletedAt" is not null and "deletedAt" < now() - make_interval(days => ${days})
      order by "deletedAt"
      limit ${limit}
      for update skip locked
    `)
    const chatIds = doomed.rows.map((row) => row.id)
    if (chatIds.length === 0) return { chatIds, storageKeys: [] as string[] }
    const ids = sql.join(chatIds.map((id) => sql`${id}::uuid`), sql`, `)
    const keys = await transaction.execute<{ key: string }>(sql`
      select artifact."storageKey" as key from "Artifact" artifact
      where artifact."chatId" in (${ids}) and artifact."storageKey" is not null
      union
      select version."storageKey" from "ArtifactVersion" version
      join "Artifact" artifact on artifact.id = version."artifactId"
      where artifact."chatId" in (${ids})
    `)
    await transaction.execute(sql`delete from "Artifact" where "chatId" in (${ids})`)
    await transaction.execute(sql`delete from "Chat" where id in (${ids})`)
    return { chatIds, storageKeys: keys.rows.map((row) => row.key) }
  })

  if (objectStore && storageKeys.length > 0) {
    // Only blobs no remaining row points at.
    const keys = sql.join(storageKeys.map((key) => sql`${key}`), sql`, `)
    const stillUsed = await database.execute<{ key: string }>(sql`
      select "storageKey" as key from "Artifact" where "storageKey" in (${keys})
      union
      select "storageKey" from "ArtifactVersion" where "storageKey" in (${keys})
    `)
    const used = new Set(stillUsed.rows.map((row) => row.key))
    const results = await Promise.allSettled(
      storageKeys.filter((key) => !used.has(key)).map((key) => objectStore.delete(key)),
    )
    const failed = results.filter((item) => item.status === 'rejected').length
    if (failed > 0) log.warn('Retention could not delete some artifact blobs', { failed })
  }
  return chatIds.length
}
