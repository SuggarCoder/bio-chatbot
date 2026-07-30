import {
  generationControlChannel,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import type { GenerationUsage } from './db.js'

export type GenerationRuntime = {
  generationId: string
  streamId: string
  userId: string
  chatId: string
  controller: AbortController
  partialOutput: string
  providerRequestId?: string
  usage: GenerationUsage
  completion?: Promise<void>
}

type ControlMessage = {
  type?: unknown
  generationId?: unknown
}

export class GenerationRuntimeRegistry {
  readonly runnerId = `fastify-${crypto.randomUUID()}`
  private config: AppConfig
  private redis: RedisClient
  private subscriber?: RedisClient
  private runtimes = new Map<string, GenerationRuntime>()

  constructor(config: AppConfig, redis: RedisClient) {
    this.config = config
    this.redis = redis
  }

  async start(): Promise<void> {
    if (!this.redis.isReady || this.subscriber) {
      return
    }

    const subscriber = this.redis.duplicate()
    subscriber.on('error', () => {
      // PostgreSQL checkpoints remain authoritative if Pub/Sub is unavailable.
    })
    await subscriber.connect()
    await subscriber.subscribe(
      generationControlChannel(this.config, this.runnerId),
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
          this.abort(message.generationId)
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

  abort(generationId: string): boolean {
    const runtime = this.runtimes.get(generationId)

    if (!runtime) {
      return false
    }

    runtime.controller.abort()
    return true
  }

  delete(generationId: string): void {
    this.runtimes.delete(generationId)
  }

  list(): GenerationRuntime[] {
    return [...this.runtimes.values()]
  }

  abortAll(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.controller.abort()
    }
  }

  async close(): Promise<void> {
    this.abortAll()

    if (this.subscriber?.isOpen) {
      await this.subscriber.close()
    }

    this.subscriber = undefined
  }
}
