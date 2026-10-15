import 'dotenv/config'

import { sql } from 'drizzle-orm'
import { createClient } from 'redis'

import { closeDatabase, createDatabase } from './db.js'

/**
 * Deletes every application table and this deployment's Redis keys so that
 * initDatabase can build the current baseline from scratch. All data is lost.
 * Runs only when RESET_DATABASE_CONFIRM equals the database name in
 * DATABASE_URL, and only while the API and Worker are stopped.
 * With RESET_DATABASE_CHECK_ONLY=true it changes nothing: it verifies the
 * confirmation, both connections and the right to drop the schemas, so the
 * deploy workflow can fail before it stops any service.
 */
const databaseUrl = process.env.DATABASE_URL?.trim()
const redisUrl = process.env.REDIS_URL?.trim()
const redisPrefix = process.env.REDIS_KEY_PREFIX?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (!redisUrl) throw new Error('REDIS_URL is required')
// An empty prefix would match every key on the server, including other apps'.
if (!redisPrefix) throw new Error('REDIS_KEY_PREFIX is required to scope the Redis cleanup')

const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''))
if (!databaseName) throw new Error('DATABASE_URL must name a database')
if (process.env.RESET_DATABASE_CONFIRM?.trim() !== databaseName) {
  throw new Error(`Refusing to reset: RESET_DATABASE_CONFIRM must equal the database name "${databaseName}"`)
}

const checkOnly = process.env.RESET_DATABASE_CHECK_ONLY === 'true'

const database = createDatabase(databaseUrl, 1)
try {
  if (checkOnly) {
    // Dropping a schema needs its owner's rights; on PostgreSQL 15+ the
    // database owner holds them for public through pg_database_owner.
    const blocked = await database.execute<{ schema: string }>(sql`
      select nspname as schema from pg_namespace
      where nspname in ('public', 'drizzle')
        and not pg_has_role(current_user, nspowner, 'MEMBER')
    `)
    if (blocked.rows.length > 0) {
      throw new Error(
        `The DATABASE_URL user cannot drop schema ${blocked.rows.map((row) => row.schema).join(', ')}; ` +
        `make it the owner of database "${databaseName}"`,
      )
    }
  } else await database.transaction(async (transaction) => {
    await transaction.execute(sql`drop schema if exists drizzle cascade`)
    // Drops every table, view, function and extension in public with it.
    await transaction.execute(sql`drop schema public cascade`)
    await transaction.execute(sql`create schema public`)
  })
  console.log(checkOnly
    ? `Database "${databaseName}" can be reset`
    : `Database "${databaseName}" emptied`)
} finally {
  await closeDatabase(database)
}

const redis = createClient({ url: redisUrl })
await redis.connect()
try {
  if (checkOnly) {
    await redis.ping()
    console.log('Redis is reachable')
  } else {
    const pattern = `${redisPrefix.replace(/[*?[\]\\]/g, '\\$&')}*`
    let removed = 0
    for await (const keys of redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
      if (keys.length > 0) removed += await redis.unlink(keys)
    }
    console.log(`Removed ${removed} Redis keys under "${redisPrefix}"`)
  }
} finally {
  await redis.close()
}
