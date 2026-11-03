import 'dotenv/config'

import { parseArgs } from 'node:util'
import { eq, isNull, and, or } from 'drizzle-orm'

import { closeDatabase, createDatabase } from './db.js'
import { users } from './db/schema.js'
import { grantResetVouchers } from './tokenQuota.js'

/**
 * Admin: issues Reset 卷 to one user. Each voucher lets the user reset their
 * weekly and monthly token quota once.
 *
 *   npm run quota:grant-reset -- --user <externalUserId|email|userName> --count 2 [--note "..."]
 */
const usage = 'Usage: npm run quota:grant-reset -- --user <externalUserId|email|userName> --count <n> [--note <text>]'

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    count: { type: 'string', default: '1' },
    note: { type: 'string' },
  },
})

const identifier = values.user?.trim()
const count = Number(values.count)
if (!identifier) throw new Error(`--user is required\n${usage}`)
if (!Number.isInteger(count) || count < 1 || count > 1_000) {
  throw new Error(`--count must be an integer between 1 and 1000\n${usage}`)
}

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const database = createDatabase(databaseUrl, 1)
try {
  const matches = await database
    .select({
      id: users.id,
      externalUserId: users.externalUserId,
      userName: users.userName,
      realName: users.realName,
      email: users.email,
    })
    .from(users)
    .where(and(
      isNull(users.deletedAt),
      or(
        eq(users.externalUserId, identifier),
        eq(users.email, identifier),
        eq(users.userName, identifier),
      ),
    ))
    .limit(5)

  if (matches.length === 0) {
    throw new Error(`No user matches "${identifier}"`)
  }
  if (matches.length > 1) {
    const listed = matches.map((user) => `  ${user.externalUserId}  ${user.userName ?? ''}  ${user.email ?? ''}`).join('\n')
    throw new Error(`"${identifier}" matches several users; pass an externalUserId:\n${listed}`)
  }

  const [user] = matches
  const balance = await grantResetVouchers(database, user.id, count, values.note)
  const label = user.realName || user.userName || user.email || user.externalUserId
  console.log(`Granted ${count} Reset 卷 to ${label} (${user.externalUserId}); balance is now ${balance}.`)
} finally {
  await closeDatabase(database)
}
