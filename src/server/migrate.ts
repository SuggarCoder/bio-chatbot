import 'dotenv/config'

import {
  closeDatabase,
  createDatabase,
  migrateDatabase,
} from './db.js'
import { LegacyMigrationHistoryError } from './db/client.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const database = createDatabase(databaseUrl)

try {
  await migrateDatabase(database)
  console.log('Database migrations applied successfully')
} catch (error) {
  if (!(error instanceof LegacyMigrationHistoryError)) throw error
  // A workflow command: GitHub Actions shows it as an error annotation.
  console.error(`::error title=Database needs a rebuild::${error.message}`)
  process.exitCode = 1
} finally {
  await closeDatabase(database)
}
