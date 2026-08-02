import { buildApp } from './app.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import {
  closeDatabase,
  createDatabase,
  verifyCoreSchema,
} from './db.js'
import { GenerationService } from './generation.js'
import { GenerationFinalizer } from './generationFinalizer.js'
import { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'
import { ArtifactService } from './artifacts/service.js'

const config = readConfig()
const database = createDatabase(config.databaseUrl)
const redis = createRedisClient(config)
const objectStore = config.objectStorage.enabled
  ? new SeaweedS3ObjectStore(config.objectStorage)
  : null
if (config.artifactProtocolEnabled && !objectStore) {
  throw new Error(
    'ARTIFACT_PROTOCOL_ENABLED requires OBJECT_STORAGE_ENABLED=true',
  )
}
const artifactService = objectStore
  ? new ArtifactService(database, objectStore)
  : null

await verifyCoreSchema(database)

try {
  await redis.connect()
} catch (error) {
  console.error('Redis is unavailable; generation endpoints will return 503', error)
}

const runtimes = new GenerationRuntimeRegistry(config, redis)
await runtimes.start()
const finalizer = new GenerationFinalizer(
  config,
  database,
  redis,
  runtimes,
)
const generations = new GenerationService(
  config,
  database,
  redis,
  runtimes,
  finalizer,
  artifactService,
)
const app = await buildApp({
  config,
  database,
  redis,
  generations,
  objectStore,
  artifactService,
})
app.log.info(
  {
    nodeEnv: config.nodeEnv,
    authMode: config.gpas2AuthMode,
    objectStorageEnabled: config.objectStorage.enabled,
    artifactProtocolEnabled: config.artifactProtocolEnabled,
  },
  'Authentication mode configured',
)
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  app.log.info({ signal }, 'Shutting down')
  await generations.shutdown()

  await app.close()
  await runtimes.close()
  await Promise.allSettled([
    closeDatabase(database),
    redis.isOpen ? redis.close() : Promise.resolve(),
  ])
  objectStore?.close()
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
