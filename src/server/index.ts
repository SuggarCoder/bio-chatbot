import { buildApp } from './app.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import { createDatabase, verifyCoreSchema } from './db.js'
import { GenerationService } from './generation.js'

const config = readConfig()
const database = createDatabase(config.databaseUrl)
const redis = createRedisClient(config)

await verifyCoreSchema(database)

try {
  await redis.connect()
} catch (error) {
  console.error('Redis is unavailable; generation endpoints will return 503', error)
}

const generations = new GenerationService(
  config,
  database,
  redis,
)
const app = await buildApp({
  config,
  database,
  redis,
  generations,
})
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  app.log.info({ signal }, 'Shutting down')
  generations.abortAll()

  await app.close()
  await Promise.allSettled([
    database.end(),
    redis.isOpen ? redis.close() : Promise.resolve(),
  ])
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0))
})

try {
  await app.listen({
    host: config.host,
    port: config.port,
  })
} catch (error) {
  app.log.error(error)
  await shutdown('startup-error')
  process.exit(1)
}
