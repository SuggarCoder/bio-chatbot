import 'dotenv/config'

import { applySchema, createDatabase } from './db.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const database = createDatabase(databaseUrl)

try {
  await applySchema(database)
  console.log('GPAS2 chatbot schema applied successfully')
} finally {
  await database.end()
}
