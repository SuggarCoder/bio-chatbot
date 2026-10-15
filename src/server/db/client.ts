import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'

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
  users,
} from './schema.js'

const { Pool } = pg

export type Database = NodePgDatabase<typeof schema> & {
  $client: InstanceType<typeof Pool>
}

export function createDatabase(databaseUrl: string, maxConnections = 4): Database {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 10_000,
  })

  return drizzle(pool, { schema })
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
