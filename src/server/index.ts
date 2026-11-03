import { readTerminalEvent } from './terminalEvent.js'
import { buildApp } from './app.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import {
  closeDatabase,
  createDatabase,
  waitForDatabase,
} from './db.js'
import { GenerationService } from './generation.js'
import { GenerationFinalizer } from './generationFinalizer.js'
import { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'
import { ArtifactService } from './artifacts/service.js'
import { GenerationStreamHub } from './streamStore.js'
import { createCapabilityRuntime } from './capabilities/runtime.js'
import { QwenTokenCounter } from './tokenBudget.js'
import { initMetrics, registerCollectedGauge, startMetricsServer } from './metrics.js'

const config = readConfig()
initMetrics('api')
const database = createDatabase(config.databaseUrl, config.pgPoolMax)
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

await waitForDatabase(database, { log: (message) => console.warn(message) })

try {
  await redis.connect()
} catch (error) {
  console.error('Redis is unavailable; generation endpoints will return 503', error)
}

const runtimes = new GenerationRuntimeRegistry(config, redis)
const finalizer = new GenerationFinalizer(
  config,
  database,
  redis,
  runtimes,
)
// Generations run (and count tokens) only in the worker; the API never
// loads the tokenizer. It is still created lazily if ever needed.
const tokenCounter = new QwenTokenCounter(config)
const capabilityRuntime = createCapabilityRuntime(config)
const generations = new GenerationService(
  config,
  database,
  redis,
  runtimes,
  finalizer,
  artifactService,
  tokenCounter,
)
const streamHub = new GenerationStreamHub(config, redis, (userId, generationId) => readTerminalEvent(database, userId, generationId))
if (redis.isReady) await streamHub.start()
else redis.once('ready', () => { void streamHub.start().catch(error => console.error('Stream subscription unavailable; polling remains active', error)) })
const app = await buildApp({
  capabilityRuntime,
  config,
  database,
  redis,
  generations,
  streamHub,
  objectStore,
  artifactService,
})
registerCollectedGauge('chatbot_sse_subscribers', 'Open SSE subscriptions in this API process.', () => streamHub.subscriberCount())
// Liveness only: the process is up and its event loop answers. Readiness
// (dependencies) is GET /ai-chatbot/api/health on the main port.
const metricsServer = await startMetricsServer(config.metricsPort, async () => ({ ok: !shuttingDown }))
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

  await streamHub.close()
  await app.close()
  await runtimes.close()
  await Promise.allSettled([
    closeDatabase(database),
    redis.isOpen ? redis.close() : Promise.resolve(),
  ])
  objectStore?.close()
  metricsServer?.close()
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
