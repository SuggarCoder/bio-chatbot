import { inArray } from 'drizzle-orm'
import type { Database } from './db.js'
import { generations } from './db/schema.js'
import {
  redisKey,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import type { GenerationUsage } from './db.js'
import type { GenerationExecutionContext } from './generationExecution.js'
import type { MessageExecutionStep } from './domain.js'

export type GenerationRuntime = {
  generationId: string
  streamId: string
  userId: string
  chatId: string
  controller: AbortController
  partialOutput: string
  executionSteps: MessageExecutionStep[]
  providerRequestId?: string
  usage: GenerationUsage
  completion?: Promise<void>
  execution?: GenerationExecutionContext
  abortReason?: 'cancel' | 'timeout' | 'lease_lost' | 'shutdown'
}

type ControlMessage = {
  type?: unknown
  generationId?: unknown
}

export class GenerationRuntimeRegistry {
  readonly runnerId = `worker-${crypto.randomUUID()}`
  private config: AppConfig
  private redis: RedisClient
  private subscriber?: RedisClient
  private runtimes = new Map<string, GenerationRuntime>()

  private cancellationTimer?: ReturnType<typeof setInterval>
  private polling = false

  constructor(config: AppConfig, redis: RedisClient, private database?: Database) {
    this.config = config
    this.redis = redis
  }

  async pollCancellations(): Promise<void> {
    if (!this.database || this.polling || !this.runtimes.size) return
    this.polling = true
    const ids = [...this.runtimes.keys()]
    try {
      const rows = await this.database.select({ id: generations.id, status: generations.status, cancelled: generations.cancelRequestedAt }).from(generations).where(inArray(generations.id, ids))
      const live = new Set(rows.filter(row => !row.cancelled && ['scheduled', 'running'].includes(row.status)).map(row => row.id))
      for (const id of ids) if (!live.has(id)) this.abort(id, 'cancel')
    } finally { this.polling = false }
  }

  async start(): Promise<void> {
    if (this.database && !this.cancellationTimer) {
      this.cancellationTimer = setInterval(() => { void this.pollCancellations().catch(() => {}) }, this.config.generationCancelPollIntervalMs ?? 5000)
      this.cancellationTimer.unref()
    }
    if (!this.redis.isReady || this.subscriber) {
      return
    }

    const subscriber = this.redis.duplicate()
    subscriber.on('error', () => {
      // PostgreSQL checkpoints remain authoritative if Pub/Sub is unavailable.
    })
    await subscriber.connect()
    await subscriber.subscribe(
      redisKey(this.config, 'worker:cancel'),
      (payload) => {
        let message: ControlMessage

        try {
          message = JSON.parse(payload) as ControlMessage
        } catch {
          return
        }

        if (
          message.type === 'generation.cancel' &&
          typeof message.generationId === 'string'
        ) {
          this.abort(message.generationId, 'cancel')
        }
      },
    )
    this.subscriber = subscriber
  }

  register(runtime: GenerationRuntime): void {
    const existing = this.runtimes.get(runtime.generationId)

    if (existing && existing !== runtime) {
      existing.controller.abort()
    }

    this.runtimes.set(runtime.generationId, runtime)
  }

  get(generationId: string): GenerationRuntime | undefined {
    return this.runtimes.get(generationId)
  }

  abort(
    generationId: string,
    reason: GenerationRuntime['abortReason'] = 'cancel',
  ): boolean {
    const runtime = this.runtimes.get(generationId)

    if (!runtime) {
      return false
    }

    runtime.abortReason = reason
    runtime.controller.abort()
    return true
  }

  delete(generationId: string): void {
    this.runtimes.delete(generationId)
  }

  list(): GenerationRuntime[] {
    return [...this.runtimes.values()]
  }

  abortAll(reason: GenerationRuntime['abortReason'] = 'shutdown'): void {
    for (const runtime of this.runtimes.values()) {
      runtime.abortReason = reason
      runtime.controller.abort()
    }
  }

  async close(): Promise<void> {
    clearInterval(this.cancellationTimer)
    this.cancellationTimer = undefined
    this.abortAll()

    if (this.subscriber?.isOpen) {
      await this.subscriber.close()
    }

    this.subscriber = undefined
  }
}
