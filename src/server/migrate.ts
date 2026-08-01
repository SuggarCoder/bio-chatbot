import 'dotenv/config'

import {
  closeDatabase,
  createDatabase,
  migrateDatabase,
} from './db.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const database = createDatabase(databaseUrl)

try {
  await migrateDatabase(database)
  console.log('Database migrations applied successfully')
} finally {
  await closeDatabase(database)
}
