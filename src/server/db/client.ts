import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'

import { metrics, registerPoolMetrics } from '../metrics.js'
import * as schema from './schema.js'
import {
  businessOperations,
  ingressRequests,
  chats,
  chatSummaries,
  backgroundJobs,
  generations,
  messages,
  outboxEvents,
  usageEvents,
  userMemories,
  messageChunks,
  users,
} from './schema.js'

const { Pool } = pg

export type Database = NodePgDatabase<typeof schema> & {
  $client: InstanceType<typeof Pool>
}

export type DatabaseOptions = {
  /** Server-side limit per statement; migrations pass 0 (no limit). */
  statementTimeoutMs?: number
}

export function createDatabase(
  databaseUrl: string,
  maxConnections = 4,
  options: DatabaseOptions = {},
): Database {
  const statementTimeout = options.statementTimeoutMs ?? 5_000
  const pool = new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeout,
    // A query whose server went silent (network partition) must not hold a
    // connection forever; the server-side statement_timeout cannot fire then.
    query_timeout: statementTimeout > 0 ? statementTimeout + 2_000 : undefined,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 10_000,
    // Detect dead peers on idle connections instead of failing on next use.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  })
  // pg-pool emits 'error' when the server closes an IDLE connection (restart,
  // failover, pg_terminate_backend, idle timeouts). Without a listener Node
  // treats it as unhandled and exits the process. The pool already discards
  // that client; the next query opens a new connection.
  pool.on('error', (error) => {
    metrics.dbPoolErrors.inc()
    console.warn('PostgreSQL idle connection error; it was discarded', { error: error.message })
  })
  registerPoolMetrics(pool, { max: maxConnections })

  return drizzle(pool, { schema })
}

/**
 * Waits for PostgreSQL to accept connections and have the expected schema.
 * A process started while the database restarts waits instead of exiting
 * into a restart loop; a missing schema still fails at once.
 */
export async function waitForDatabase(
  database: Database,
  options: { maxWaitMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const deadline = Date.now() + (options.maxWaitMs ?? 5 * 60_000)
  for (let attempt = 1; ; attempt += 1) {
    try {
      await verifyCoreSchema(database)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('Database schema is missing') || Date.now() >= deadline) throw error
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
      options.log?.(`PostgreSQL not ready (${message}); retrying in ${delay} ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.$client.end()
}

/** The database was built from migrations replaced by the current baseline. */
export class LegacyMigrationHistoryError extends Error {
  constructor() {
    super(
      'This database was built from migrations older than drizzle/0000_baseline.sql ' +
      '(the 2026-10 squash) and cannot be upgraded; nothing was changed. Rebuild it, ' +
      'which deletes all data: GitHub Actions > Deploy AI Chatbot > Run workflow, with ' +
      'reset_database set to the database name in DATABASE_URL.',
    )
    this.name = 'LegacyMigrationHistoryError'
  }
}

export async function migrateDatabase(
  database: Database,
  migrationsFolder = path.resolve(process.cwd(), 'drizzle'),
): Promise<void> {
  // Every migration applied after the squash is at or after the baseline, so
  // an older last migration means the pre-squash history.
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ when: number }> }
  const baselineAt = Math.min(...journal.entries.map((entry) => entry.when))
  const history = await database.execute<{ table: string | null }>(sql`
    select to_regclass('drizzle.__drizzle_migrations')::text as "table"
  `)
  if (history.rows[0]?.table) {
    const applied = await database.execute<{ last: string | null }>(sql`
      select max(created_at)::text as last from drizzle.__drizzle_migrations
    `)
    const last = applied.rows[0]?.last
    if (last !== null && last !== undefined && Number(last) < baselineAt) {
      throw new LegacyMigrationHistoryError()
    }
  }
  await migrate(database, {
    migrationsFolder,
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  })
}

export async function checkDatabase(database: Database): Promise<void> {
  await database.execute(sql`select 1`)
}

export async function verifyCoreSchema(database: Database): Promise<void> {
  try {
    await Promise.all([
      database.select({ id: ingressRequests.id }).from(ingressRequests).limit(1),
      database.select({ id: businessOperations.id }).from(businessOperations).limit(1),
      database.select({ id: users.id }).from(users).limit(1),
      database.select({ id: chats.id }).from(chats).limit(1),
      database.select({ id: messages.id }).from(messages).limit(1),
      database.select({ id: generations.id }).from(generations).limit(1),
      database.select({ id: outboxEvents.id }).from(outboxEvents).limit(1),
      database.select({ id: usageEvents.id }).from(usageEvents).limit(1),
      database.select({ chatId: chatSummaries.chatId }).from(chatSummaries).limit(1),
      database.select({ id: backgroundJobs.id }).from(backgroundJobs).limit(1),
      database.select({ userId: userMemories.userId }).from(userMemories).limit(1),
      database.select({ id: messageChunks.id }).from(messageChunks).limit(1),
    ])
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'cause' in error &&
      typeof error.cause === 'object' &&
      error.cause !== null &&
      'code' in error.cause &&
      ['42P01', '42703'].includes(String(error.cause.code))
    ) {
      throw new Error(
        'Database schema is missing or outdated. Run `npm run db:init` for a fresh database or `npm run db:migrate` for later forward migrations.',
        { cause: error },
      )
    }

    throw error
  }
}
