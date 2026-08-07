import { ArtifactService } from './artifacts/service.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import {
  closeDatabase,
  createDatabase,
  verifyCoreSchema,
} from './db.js'
import { GenerationService } from './generation.js'
import { GenerationFinalizer } from './generationFinalizer.js'
import {
  claimGeneration,
  claimOutboxBatch,
  GenerationQueue,
  listQueuedGenerationJobs,
  listStaleGenerations,
  loadGenerationWorkItem,
  markOutboxFailed,
  markOutboxPublished,
  requeueStaleGeneration,
  type GenerationWorkItem,
  type QueueLease,
} from './generationQueue.js'
import { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'
import { normalizeExecutionSteps } from './executionTrace.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'

const config = readConfig()
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

await verifyCoreSchema(database)
await redis.connect()

const runtimes = new GenerationRuntimeRegistry(config, redis)
await runtimes.start()
const finalizer = new GenerationFinalizer(config, database, redis, runtimes)
const generations = new GenerationService(
  config,
  database,
  redis,
  runtimes,
  finalizer,
  artifactService,
)
const queue = new GenerationQueue(config, redis)
const active = new Set<Promise<void>>()
const heartbeatIntervalMs = 10_000
const outboxPollIntervalMs = 250
const reconcileIntervalMs = 15_000
let stopping = false
let schedulerWakePending = false
let schedulerWakeResolver: (() => void) | undefined

function wait(duration: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, duration)
    timer.unref()
  })
}

function wakeScheduler(): void {
  schedulerWakePending = true
  const resolve = schedulerWakeResolver
  schedulerWakeResolver = undefined
  resolve?.()
}

function waitForScheduler(duration: number): Promise<void> {
  if (schedulerWakePending) {
    schedulerWakePending = false
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      if (schedulerWakeResolver === finish) {
        schedulerWakeResolver = undefined
      }
      schedulerWakePending = false
      resolve()
    }
    const timer = setTimeout(finish, duration)
    timer.unref()
    schedulerWakeResolver = finish
  })
}

async function dispatchOutbox(): Promise<void> {
  const rows = await claimOutboxBatch(database)
  for (const row of rows) {
    try {
      await queue.enqueue({
        userId: row.userId,
        generationId: row.aggregateId,
        attempt: row.generationAttempt,
      }, row.schedulingWeight)
      await markOutboxPublished(database, row)
    } catch (error) {
      await markOutboxFailed(database, row, error).catch(() => undefined)
    }
  }
}

async function runGeneration(
  item: GenerationWorkItem,
  lease: QueueLease,
): Promise<void> {
  const renewTimer = setInterval(() => {
    void queue.renew(lease).then((renewed) => {
      if (!renewed) runtimes.abort(item.generationId, 'lease_lost')
    }).catch(() => {
      runtimes.abort(item.generationId, 'lease_lost')
    })
  }, config.generationLockRenewIntervalMs)
  renewTimer.unref()
  const timeout = setTimeout(() => {
    runtimes.abort(item.generationId, 'timeout')
  }, config.generationTimeoutMs)
  timeout.unref()

  try {
    await generations.execute(item)
  } finally {
    clearInterval(renewTimer)
    clearTimeout(timeout)
    await queue.release(lease).catch(() => undefined)
  }
}

async function scheduleOne(): Promise<boolean> {
  if (active.size >= config.globalGenerationConcurrency) return false
  const job = await queue.pop()
  if (!job) return false
  const item = await loadGenerationWorkItem(database, job)
  if (!item) return true
  const lease: QueueLease = {
    userId: item.user.id,
    generationId: item.generationId,
    conversationId: item.conversationId,
    provider: item.provider,
    model: item.model,
    workerId: queue.workerId,
    token: `${item.generationId}:${queue.workerId}:${crypto.randomUUID()}`,
  }
  const acquired = await queue.acquire(
    lease,
    item.user.generationConcurrencyLimit,
  )
  if (!acquired) {
    await queue.defer(job, item.user.schedulingWeight)
    return false
  }
  if (!await claimGeneration(database, item, queue.workerId)) {
    await queue.release(lease)
    return true
  }
  const running = runGeneration(item, lease)
    .catch((error) => {
      console.error('Generation execution failed', {
        generationId: item.generationId,
        error,
      })
    })
    .finally(() => {
      active.delete(running)
      wakeScheduler()
    })
  active.add(running)
  return true
}

function usageFromSnapshot(snapshot: Record<string, unknown> | null) {
  const usage = snapshot?.usage as Record<string, unknown> | undefined
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  return {
    inputTokens: number(usage?.inputTokens),
    outputTokens: number(usage?.outputTokens),
    cachedInputTokens: number(usage?.cachedInputTokens),
    reasoningTokens: number(usage?.reasoningTokens),
  }
}

async function reconcile(): Promise<void> {
  const queued = await listQueuedGenerationJobs(database)
  for (const job of queued) {
    await queue.enqueue(job, job.schedulingWeight)
  }

  const staleRows = await listStaleGenerations(database)
  for (const stale of staleRows) {
    if (await queue.hasLease(stale.userId, stale.generationId)) continue
    if (!stale.providerRequestStartedAt && stale.status !== 'cancelling') {
      await requeueStaleGeneration(database, stale)
      continue
    }
    const snapshot = await queue.readSnapshot(stale.userId, stale.generationId)
    await finalizer.finalize({
      generationId: stale.generationId,
      userId: stale.userId,
      desiredStatus: 'interrupted',
      content: typeof snapshot?.content === 'string' ? snapshot.content : '',
      providerRequestId: typeof snapshot?.providerRequestId === 'string'
        ? snapshot.providerRequestId
        : undefined,
      usage: usageFromSnapshot(snapshot),
      latencyMs: 0,
      timeToFirstTokenMs: null,
      finishReason: stale.status === 'cancelling' ? 'cancelled' : 'interrupted',
      errorCode: stale.status === 'cancelling'
        ? 'generation_cancelled'
        : 'generation_interrupted',
      errorMessage: stale.status === 'cancelling'
        ? 'Generation stopped'
        : 'Worker lease expired after the Provider request started',
      executionSteps: normalizeExecutionSteps(snapshot?.executionSteps),
    })
  }
}

async function mainLoop(): Promise<void> {
  let nextHeartbeatAt = 0
  let nextOutboxPollAt = 0
  let nextReconcileAt = 0

  while (!stopping) {
    if (Date.now() >= nextHeartbeatAt) {
      await queue.heartbeat()
      nextHeartbeatAt = Date.now() + heartbeatIntervalMs
    }
    if (Date.now() >= nextOutboxPollAt) {
      await dispatchOutbox()
      nextOutboxPollAt = Date.now() + outboxPollIntervalMs
    }
    if (Date.now() >= nextReconcileAt) {
      await reconcile()
      nextReconcileAt = Date.now() + reconcileIntervalMs
    }

    let scheduled = false
    do {
      scheduled = await scheduleOne()
    } while (scheduled && active.size < config.globalGenerationConcurrency)

    const nextPeriodicTaskAt = Math.min(
      nextHeartbeatAt,
      nextOutboxPollAt,
      nextReconcileAt,
    )
    await waitForScheduler(Math.max(0, nextPeriodicTaskAt - Date.now()))
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  wakeScheduler()
  console.info('Worker shutting down', { signal })
  runtimes.abortAll('shutdown')
  await Promise.race([
    Promise.allSettled([...active]),
    wait(15_000),
  ])
  await generations.shutdown()
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
  await mainLoop()
} catch (error) {
  console.error('Worker failed', error)
  await shutdown('fatal-error')
  process.exit(1)
}
