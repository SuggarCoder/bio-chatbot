import 'dotenv/config'

import { sql } from 'drizzle-orm'

import {
  closeDatabase,
  createDatabase,
  migrateDatabase,
  verifyCoreSchema,
} from './db.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const database = createDatabase(databaseUrl, 2)
try {
  const result = await database.execute<{ existing: string | null }>(sql`
    select tablename as existing
    from pg_catalog.pg_tables
    where schemaname = 'public'
    limit 1
  `)
  if (result.rows[0]?.existing) {
    throw new Error(
      `db:init requires an empty public schema; found table ${result.rows[0].existing}. Drop and recreate the old application database before initialization.`,
    )
  }
  const migrationState = await database.execute<{ existing: string | null }>(sql`
    select to_regclass('drizzle.__drizzle_migrations')::text as existing
  `)
  if (migrationState.rows[0]?.existing) {
    throw new Error(
      'db:init found migration metadata without application tables. Drop the stale drizzle schema before initialization.',
    )
  }
  await database.execute(sql`create extension if not exists vector`)
  await migrateDatabase(database)
  await verifyCoreSchema(database)
  console.log('Fresh database initialized successfully')
} finally {
  await closeDatabase(database)
}
