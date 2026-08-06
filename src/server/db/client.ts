import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import path from 'node:path'
import pg from 'pg'

import * as schema from './schema.js'
import {
  chats,
  generations,
  messages,
  outboxEvents,
  usageEvents,
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
  })

  return drizzle(pool, { schema })
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.$client.end()
}

export async function migrateDatabase(
  database: Database,
  migrationsFolder = path.resolve(process.cwd(), 'drizzle'),
): Promise<void> {
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
      database.select({ id: users.id }).from(users).limit(1),
      database.select({ id: chats.id }).from(chats).limit(1),
      database.select({ id: messages.id }).from(messages).limit(1),
      database.select({ id: generations.id }).from(generations).limit(1),
      database.select({ id: outboxEvents.id }).from(outboxEvents).limit(1),
      database.select({ id: usageEvents.id }).from(usageEvents).limit(1),
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
