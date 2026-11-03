import { ArtifactService } from './artifacts/service.js'
import {
  BackgroundQueue,
  claimBackgroundJob,
  claimBackgroundOutboxBatch,
  completeBackgroundJob,
  failBackgroundJob,
  listQueuedBackgroundJobs,
  markBackgroundOutboxFailed,
  markBackgroundOutboxPublished,
  type BackgroundWorkItem,
} from './backgroundJobs.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import {
  closeDatabase,
  createDatabase,
  waitForDatabase,
} from './db.js'
import { initMetrics, metrics, startMetricsServer } from './metrics.js'
import { GenerationService } from './generation.js'
import { GenerationFinalizer } from './generationFinalizer.js'
import { MemoryProcessor } from './memoryWorker.js'
import { indexChatTurn } from './chatSearch.js'
import { createEmbedder } from './embeddings.js'
import { purgeExpiredMemories } from './memoryPolicy.js'
import type { GenerationMemoryReport } from './generationBytes.js'
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
import { runRetention } from './retention.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'
import { QwenTokenCounter } from './tokenBudget.js'
import { AgentToolbox } from './agent/tools.js'
import { createGpasCapabilities } from './capabilities/gpas.js'
import { GpasService } from './gpas.js'
import { createGpasTools } from './gpas/tools/index.js'

const config = readConfig()
initMetrics('worker')
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

// Dependencies that are restarting are waited for, not treated as fatal:
// exiting here would only put the container into a restart loop.
await waitForDatabase(database, { log: (message) => console.warn(message) })
for (let attempt = 1; ; attempt += 1) {
  try {
    await redis.connect()
    break
  } catch (error) {
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
    console.warn(`Redis not ready (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

const runtimes = new GenerationRuntimeRegistry(config, redis, database)
await runtimes.start()
const finalizer = new GenerationFinalizer(config, database, redis, runtimes)
const tokenCounter = new QwenTokenCounter(config)
// Every provider request is token-budgeted, including plain chat.
await tokenCounter.initialize()
// Agent tools share the GPAS specs used by the API's capability catalog.
const gpasService = new GpasService(config)
const agentToolbox = new AgentToolbox(
  config,
  createGpasTools(gpasService),
  gpasService.client,
  createGpasCapabilities(gpasService).descriptions(),
)
const generations = new GenerationService(
  config,
  database,
  redis,
  runtimes,
  finalizer,
  artifactService,
  tokenCounter,
  agentToolbox,
)
const queue = new GenerationQueue(config, redis)
const backgroundQueue = new BackgroundQueue(config, redis)
const memoryProcessor = new MemoryProcessor(config, database, tokenCounter, redis)
const embedder = createEmbedder(config)

async function indexJob(job: BackgroundWorkItem, signal: AbortSignal) {
  const assistantMessageId = typeof job.payload.assistantMessageId === 'string' ? job.payload.assistantMessageId : ''
  if (!job.chatId || !assistantMessageId) return undefined
  const indexed = await indexChatTurn(database, embedder, {
    userId: job.userId,
    chatId: job.chatId,
    assistantMessageId,
    userMessageId: typeof job.payload.userMessageId === 'string' ? job.payload.userMessageId : undefined,
  }, signal)
  return indexed ? { kind: 'embedding' as const, inputTokens: indexed.tokens, outputTokens: 0 } : undefined
}
const active = new Set<Promise<void>>()
const backgroundActive = new Set<Promise<void>>()
/** Aborts the model calls of running background jobs (deadline or shutdown). */
const backgroundControllers = new Set<AbortController>()
/** Settles when mainLoop has returned; shutdown waits for it before draining. */
let mainLoopDone: Promise<void> = Promise.resolve()
const heartbeatIntervalMs = 10_000
const outboxPollIntervalMs = 250
const reconcileIntervalMs = 15_000
// Aged-out memories are already ignored by reads; this only frees the rows.
const memoryPurgeIntervalMs = 10 * 60_000
let stopping = false
/** When the scheduling loop last finished an iteration (liveness). */
let lastLoopIterationAt = Date.now()
/** Steps that are currently failing, for the health report. */
const failingSteps = new Map<string, { failures: number; retryAt: number; error: string }>()
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
  const backgroundRows = await claimBackgroundOutboxBatch(database)
  for (const row of backgroundRows) {
    try {
      await backgroundQueue.enqueue({
        jobId: row.aggregateId,
        userId: row.userId,
        attempt: row.jobAttempt,
      })
      await markBackgroundOutboxPublished(database, row)
    } catch (error) {
      await markBackgroundOutboxFailed(database, row, error).catch(() => undefined)
    }
  }
}

async function scheduleBackgroundOne(): Promise<boolean> {
  if (stopping || backgroundActive.size >= config.backgroundConcurrency) return false
  const queued = await backgroundQueue.pop()
  if (!queued) return false
  if (stopping) {
    // Popped while shutdown began: hand it back for another worker.
    await backgroundQueue.enqueue(queued)
    return false
  }
  const token = await backgroundQueue.acquire(queued.jobId)
  if (!token) {
    await backgroundQueue.enqueue(queued)
    return false
  }
  let job: Awaited<ReturnType<typeof claimBackgroundJob>>
  try {
    job = await claimBackgroundJob(
      database,
      queued,
      backgroundQueue.workerId,
    )
  } catch (error) {
    await backgroundQueue.release(queued.jobId, token).catch(() => undefined)
    throw error
  }
  if (!job) {
    await backgroundQueue.release(queued.jobId, token)
    return true
  }
  // The job must end before its lease (backgroundTimeoutMs) can expire and
  // let another worker run it again.
  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort(new Error('Background job exceeded BACKGROUND_TIMEOUT_MS'))
  }, config.backgroundTimeoutMs)
  deadline.unref()
  backgroundControllers.add(controller)
  const stopJobTimer = metrics.backgroundJobDuration.startTimer({ type: job.type })
  let outcome = 'completed'
  const running = (async () => {
    try {
      if (
        (job.type === 'chat.summary' && !config.contextMemoryEnabled) ||
        (job.type === 'user.memory' && !config.userMemoryEnabled) ||
        (job.type === 'chat.index' && !config.chatSearchEnabled)
      ) {
        await completeBackgroundJob(database, job)
        return
      }
      const usage = job.type === 'chat.index'
        ? await indexJob(job, controller.signal)
        : await memoryProcessor.process(job, controller.signal)
      await completeBackgroundJob(database, job, usage)
    } catch (error) {
      outcome = controller.signal.aborted ? 'timed_out' : 'failed'
      await failBackgroundJob(database, job, error)
    } finally {
      stopJobTimer()
      metrics.backgroundJobs.inc({ type: job.type, outcome })
      clearTimeout(deadline)
      backgroundControllers.delete(controller)
      await backgroundQueue.release(queued.jobId, token).catch(() => undefined)
    }
  })().catch((error) => {
    // Recording the failure failed too (e.g. PostgreSQL is down). The job
    // stays 'running' and reconcile retries it; the worker must not crash.
    console.error('Background job could not be recorded', { jobId: job.jobId, error })
  }).finally(() => {
    backgroundActive.delete(running)
    wakeScheduler()
  })
  backgroundActive.add(running)
  return true
}

/** Leases are taken for 30 s; renewal failures are tolerated for 20 s of it. */
const LEASE_SAFE_MS = 20_000

async function runGeneration(
  item: GenerationWorkItem,
  lease: QueueLease,
): Promise<void> {
  let renewing = false
  let lastRenewedAt = Date.now()
  const renewTimer = setInterval(() => {
    if (renewing) return
    renewing = true
    void queue.renew(lease).then((renewed) => {
      // The lease belongs to someone else now: stop at once.
      if (!renewed) runtimes.abort(item.generationId, 'lease_lost')
      else lastRenewedAt = Date.now()
    }).catch(() => {
      // Redis did not answer. A short blip is tolerated; once the lease may
      // have expired (another worker could take the job), stop.
      if (Date.now() - lastRenewedAt >= LEASE_SAFE_MS) runtimes.abort(item.generationId, 'lease_lost')
    }).finally(() => { renewing = false })
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
  if (stopping || active.size >= config.globalGenerationConcurrency) return false
  const job = await queue.pop()
  if (!job) return false
  const item = await loadGenerationWorkItem(database, job)
  if (!item) return true
  if (stopping) {
    // Popped while shutdown began: hand it back for another worker.
    await queue.defer(job, item.user.schedulingWeight)
    return false
  }
  const lease: QueueLease = {
    userId: item.user.id,
    generationId: item.generationId,
    conversationId: item.conversationId,
    provider: item.provider,
    model: item.model,
    workerId: queue.workerId,
    token: `${item.generationId}:${queue.workerId}:${crypto.randomUUID()}`,
  }
  const acquired = await queue.tryAcquire(
    lease,
    item.user.generationConcurrencyLimit,
  )
  if (acquired !== 'acquired') {
    await queue.defer(job, item.user.schedulingWeight)
    // Shared slots are full for everyone: stop scanning until a generation
    // finishes (wakeScheduler) or the next periodic tick, instead of popping,
    // loading and deferring up to 16 jobs per tick against PostgreSQL.
    return acquired === 'tenant_blocked'
  }
  let claimed: boolean
  try {
    claimed = !stopping && await claimGeneration(database, item, queue.workerId)
  } catch (error) {
    await queue.release(lease).catch(() => undefined)
    throw error
  }
  if (!claimed) {
    await queue.release(lease)
    await queue.defer(job, item.user.schedulingWeight)
    return !stopping
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

/** The byte accounting the run last saved, if it looks like one. */
function memoryFromSnapshot(snapshot: Record<string, unknown> | null): GenerationMemoryReport | undefined {
  const memory = snapshot?.memory as Partial<GenerationMemoryReport> | undefined
  return memory && typeof memory.totalBytes === 'number' && typeof memory.capBytes === 'number'
    ? memory as GenerationMemoryReport
    : undefined
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
  metrics.queuedGenerations.set(queued.length)
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
      memory: memoryFromSnapshot(snapshot),
    })
  }
  const background = await listQueuedBackgroundJobs(database)
  for (const job of background) await backgroundQueue.enqueue(job)
}

/**
 * Runs one loop step. A failing step (PostgreSQL or Redis down, a timeout,
 * a deadlock) is logged, counted and retried with backoff; it never ends the
 * loop, so in-flight generations keep running through a dependency blip.
 */
async function runStep(name: string, step: () => Promise<unknown>): Promise<void> {
  const failing = failingSteps.get(name)
  if (failing && failing.retryAt > Date.now()) return
  try {
    await step()
    if (failing) {
      console.info('Worker loop step recovered', { step: name, failures: failing.failures })
      failingSteps.delete(name)
    }
  } catch (error) {
    const failures = (failing?.failures ?? 0) + 1
    const message = error instanceof Error ? error.message : String(error)
    failingSteps.set(name, {
      failures,
      retryAt: Date.now() + Math.min(30_000, 250 * 2 ** Math.min(failures, 7)),
      error: message,
    })
    metrics.workerLoopErrors.inc({ step: name })
    if (failures === 1 || failures % 20 === 0) {
      console.warn('Worker loop step failed; retrying with backoff', { step: name, failures, error: message })
    }
  }
}

let retentionRun: Promise<void> | null = null

async function mainLoop(): Promise<void> {
  let nextHeartbeatAt = 0
  let nextOutboxPollAt = 0
  let nextReconcileAt = 0
  let nextMemoryPurgeAt = 0
  // First run a few minutes after start so a crash-looping worker does not
  // keep running it.
  let nextRetentionAt = Date.now() + 5 * 60_000

  while (!stopping) {
    if (Date.now() >= nextHeartbeatAt) {
      nextHeartbeatAt = Date.now() + heartbeatIntervalMs
      await runStep('heartbeat', () => queue.heartbeat())
    }
    if (Date.now() >= nextOutboxPollAt) {
      nextOutboxPollAt = Date.now() + outboxPollIntervalMs
      await runStep('outbox', dispatchOutbox)
    }
    if (Date.now() >= nextReconcileAt) {
      nextReconcileAt = Date.now() + reconcileIntervalMs
      await runStep('reconcile', reconcile)
    }
    if (Date.now() >= nextMemoryPurgeAt) {
      nextMemoryPurgeAt = Date.now() + memoryPurgeIntervalMs
      await runStep('memory-purge', async () => {
        const purged = await purgeExpiredMemories(database)
        if (purged > 0) console.info('Purged aged-out memories', { purged })
      })
    }

    if (Date.now() >= nextRetentionAt && !retentionRun) {
      nextRetentionAt = Date.now() + 60 * 60_000
      // Runs beside the loop (bounded to 30 s of work) so scheduling and
      // heartbeats are not delayed; a failure is retried next hour.
      retentionRun = runStep('retention', () => runRetention(database, { objectStore }))
        .finally(() => { retentionRun = null })
    }

    // Keep looking past blocked tenants, but bound scans when all are blocked.
    await runStep('schedule-generations', async () => {
      for (let scanned = 0; scanned < 16 && !stopping && active.size < config.globalGenerationConcurrency; scanned += 1) {
        if (!await scheduleOne()) break
      }
    })

    await runStep('schedule-background', async () => {
      let backgroundScheduled = false
      do {
        backgroundScheduled = await scheduleBackgroundOne()
      } while (
        backgroundScheduled &&
        !stopping &&
        backgroundActive.size < config.backgroundConcurrency
      )
    })

    lastLoopIterationAt = Date.now()
    if (failingSteps.size === 0) metrics.workerLoopLastSuccess.setToCurrentTime()
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
  // Let the loop finish its current step, so nothing it was starting is
  // missed by the drain below.
  await Promise.race([mainLoopDone, wait(5_000)])

  // Drain: no new work is taken, running generations and jobs may finish
  // (a rolling deploy then interrupts nobody). Leases keep renewing and the
  // heartbeat keeps going meanwhile. Docker's stop_grace_period must exceed
  // this drain plus the abort below.
  const drainMs = config.workerDrainTimeoutMs
  const inFlight = [...active, ...backgroundActive, ...(retentionRun ? [retentionRun] : [])]
  if (drainMs > 0 && inFlight.length > 0) {
    console.info('Worker draining', { generations: active.size, backgroundJobs: backgroundActive.size, timeoutMs: drainMs })
    const heartbeat = setInterval(() => { void queue.heartbeat().catch(() => undefined) }, heartbeatIntervalMs)
    const startedAt = Date.now()
    await Promise.race([Promise.allSettled(inFlight), wait(drainMs)])
    clearInterval(heartbeat)
    console.info('Worker drain finished', {
      elapsedMs: Date.now() - startedAt,
      interrupted: active.size + backgroundActive.size,
    })
  }

  runtimes.abortAll('shutdown')
  for (const controller of backgroundControllers) {
    controller.abort(new Error('Worker shutting down'))
  }
  await Promise.race([
    Promise.allSettled([...active, ...backgroundActive, ...(retentionRun ? [retentionRun] : [])]),
    wait(15_000),
  ])
  await generations.shutdown()
  await runtimes.close()
  await Promise.allSettled([
    closeDatabase(database),
    redis.isOpen ? redis.close() : Promise.resolve(),
  ])
  objectStore?.close()
  metricsServer?.close()
}

// Liveness: the loop iterates (a stuck loop fails it; failing dependencies
// are reported but do not, since restarting would not fix them).
const metricsServer = await startMetricsServer(config.metricsPort, async () => ({
  ok: !stopping && Date.now() - lastLoopIterationAt < 60_000,
  detail: {
    loopAgeMs: Date.now() - lastLoopIterationAt,
    activeGenerations: active.size,
    activeBackgroundJobs: backgroundActive.size,
    failingSteps: Object.fromEntries([...failingSteps].map(([step, value]) => [step, { failures: value.failures, error: value.error }])),
  },
}))

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0))
})

try {
  const loop = mainLoop()
  mainLoopDone = loop.then(() => undefined, () => undefined)
  await loop
} catch (error) {
  console.error('Worker failed', error)
  await shutdown('fatal-error')
  process.exit(1)
}
