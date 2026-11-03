import type { AppConfig } from './config.js'
import type { StreamEvent } from './domain.js'
import { redisKey, type RedisClient } from './cache.js'

type StoredEvent = StreamEvent

type StreamListener = {
  controller: ReadableStreamDefaultController<string>
  cursor: string
  closed: boolean
  polling: boolean
  userId: string
  generationId: string
  timer?: NodeJS.Timeout
  heartbeatTimer?: NodeJS.Timeout
  /** Catch-up stopped because the consumer's queue is full; pull() resumes it. */
  paused: boolean
  stalledSince?: number
  /** A catch-up was requested while one was running; run again when it ends. */
  rerun: boolean
  /** Unsent remainder of the last batch read from Redis. */
  pending?: Array<{ id: string; event: StoredEvent }>
}

/** Events read from Redis per catch-up round; small, so a backlog streams in steps. */
const CATCH_UP_BATCH = 64
/** Bytes of SSE text queued per subscriber before catch-up waits for the consumer. */
const SUBSCRIBER_HIGH_WATER_BYTES = 64 * 1024
/** A consumer that has not drained its queue for this long is dropped; it can resume. */
const SLOW_CONSUMER_MAX_STALL_MS = 30_000

type StreamNotification = {
  key?: unknown
}

const terminalTypes = new Set(['message.finish'])

function compareStreamIds(left: string, right: string): number {
  const [leftMs = '0', leftSequence = '0'] = left.split('-')
  const [rightMs = '0', rightSequence = '0'] = right.split('-')
  const millisecondDifference = BigInt(leftMs) - BigInt(rightMs)

  if (millisecondDifference !== 0n) return millisecondDifference > 0n ? 1 : -1
  const sequenceDifference = BigInt(leftSequence) - BigInt(rightSequence)
  return sequenceDifference === 0n ? 0 : sequenceDifference > 0n ? 1 : -1
}

function encodeSse(id: string, event: StoredEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function generationStreamKey(
  config: AppConfig,
  userId: string,
  generationId: string,
): string {
  return redisKey(config, `stream:${userId}:${generationId}`)
}

export class GenerationStreamStore {
  private readonly channel: string

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisClient,
  ) {
    this.channel = redisKey(config, 'stream:events')
  }

  async append(
    userId: string,
    generationId: string,
    event: StoredEvent,
  ): Promise<string> {
    const key = generationStreamKey(this.config, userId, generationId)
    const serialized = JSON.stringify(event)
    const id = await this.redis.xAdd(key, '*', { event: serialized }, {
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10_000 },
    })
    // A finished stream only serves clients reconnecting right after the end;
    // later readers get the full message from PostgreSQL.
    const retention = event.type === 'message.finish'
      ? event.finishReason === 'error' || event.finishReason === 'length'
        ? 10 * 60
        : 3 * 60
      : 60 * 60
    await Promise.all([
      this.redis.expire(key, retention),
      this.redis.publish(this.channel, JSON.stringify({
        key,
        id,
        event: serialized,
      })),
    ])
    return id
  }

  async exists(userId: string, generationId: string): Promise<boolean> {
    return (await this.redis.exists(
      generationStreamKey(this.config, userId, generationId),
    )) > 0
  }

  async readAfter(
    key: string,
    cursor: string,
    count = 500,
  ): Promise<Array<{ id: string; event: StoredEvent }>> {
    const start = cursor === '0-0' ? '-' : `(${cursor}`
    const entries = await this.redis.xRange(key, start, '+', { COUNT: count })
    return entries.flatMap((entry) => {
      const serialized = entry.message.event
      if (typeof serialized !== 'string') return []

      try {
        return [{
          id: entry.id,
          event: JSON.parse(serialized) as StoredEvent,
        }]
      } catch {
        return []
      }
    })
  }

  notificationChannel(): string {
    return this.channel
  }
}

export class GenerationStreamHub {
  private readonly store: GenerationStreamStore
  private readonly subscriber: RedisClient
  private readonly listeners = new Map<string, Set<StreamListener>>()
  private started = false
  private readonly terminalChecks = new Map<string, { at: number; result: Promise<StreamEvent | null> }>()

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisClient,
    private readonly readTerminal?: (userId: string, generationId: string) => Promise<StreamEvent | null>,
    private readonly terminalPollMs = 5_000,
  ) {
    this.store = new GenerationStreamStore(config, redis)
    this.subscriber = redis.duplicate()
    this.subscriber.on('error', () => {
      // Periodic XRANGE catch-up remains available when Pub/Sub reconnects.
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    if (!this.subscriber.isOpen) await this.subscriber.connect()
    await this.subscriber.subscribe(
      this.store.notificationChannel(),
      (payload) => this.onNotification(payload),
    )
    this.started = true
  }

  private onNotification(payload: string): void {
    let notification: StreamNotification
    try {
      notification = JSON.parse(payload) as StreamNotification
    } catch {
      return
    }
    if (
      typeof notification.key !== 'string'
    ) return

    for (const listener of this.listeners.get(notification.key) ?? []) {
      // A paused listener resumes from pull() once its consumer drains.
      if (listener.paused) continue
      void this.catchUp(notification.key, listener).catch(() => undefined)
    }
  }

  private finishListener(key: string, listener: StreamListener): void {
    listener.closed = true
    if (listener.timer) clearInterval(listener.timer)
    if (listener.heartbeatTimer) clearInterval(listener.heartbeatTimer)
    listener.controller.close()
    this.cleanup(key)
  }

  private deliver(key: string, listener: StreamListener, id: string, event: StoredEvent): void {
    if (listener.closed || compareStreamIds(id, listener.cursor) <= 0) return
    listener.cursor = id
    listener.controller.enqueue(encodeSse(id, event))
    if (terminalTypes.has(event.type)) this.finishListener(key, listener)
  }

  private async checkTerminal(key: string, listener: StreamListener): Promise<void> {
    if (!this.readTerminal || listener.closed) return
    let check = this.terminalChecks.get(key)
    if (!check || Date.now() - check.at >= this.terminalPollMs) {
      check = { at: Date.now(), result: this.readTerminal(listener.userId, listener.generationId) }
      this.terminalChecks.set(key, check)
    }
    const terminal = await check.result
    if (!terminal || listener.closed) return
    // The full durable message repairs missing/trimmed deltas and terminal events.
    // Reuse the cursor: a synthetic terminal must not invent a Redis stream ID.
    listener.controller.enqueue(encodeSse(listener.cursor, terminal))
    this.finishListener(key, listener)
  }

  private cleanup(key: string): void {
    const listeners = this.listeners.get(key)
    if (!listeners) return
    for (const listener of listeners) {
      if (listener.closed) listeners.delete(listener)
    }
    if (listeners.size === 0) {
      this.listeners.delete(key)
      this.terminalChecks.delete(key)
    }
  }

  /**
   * Delivers events after the listener's cursor in small batches and stops
   * as soon as the consumer's queue is full: a long backlog then streams at
   * the consumer's pace instead of being enqueued all at once.
   */
  private async catchUp(key: string, listener: StreamListener): Promise<void> {
    if (listener.closed) return
    if (listener.polling) {
      listener.rerun = true
      return
    }
    listener.polling = true
    listener.rerun = false
    try {
      while (!listener.closed && !listener.paused) {
        const fromPending = Boolean(listener.pending?.length)
        const entries = fromPending
          ? listener.pending!.splice(0)
          : await this.store.readAfter(key, listener.cursor, CATCH_UP_BATCH)
        let index = 0
        while (index < entries.length && !listener.closed) {
          const entry = entries[index++]!
          this.deliver(key, listener, entry.id, entry.event)
          if ((listener.controller.desiredSize ?? 0) <= 0) {
            listener.paused = true
            listener.stalledSince ??= Date.now()
            break
          }
        }
        if (listener.paused) {
          listener.pending = entries.slice(index)
          break
        }
        if (!fromPending && entries.length < CATCH_UP_BATCH) break
      }
    } catch {
      // Redis is only a replay cache. Always check the authoritative terminal.
    } finally {
      try { await this.checkTerminal(key, listener) }
      finally { listener.polling = false }
    }
    if (listener.rerun && !listener.closed && !listener.paused) {
      await this.catchUp(key, listener)
    }
  }

  subscribe(
    userId: string,
    generationId: string,
    cursor = '0-0',
  ): ReadableStream<string> {
    const key = generationStreamKey(this.config, userId, generationId)
    let listener: StreamListener | undefined

    return new ReadableStream<string>({
      start: (controller) => {
        listener = {
          controller,
          cursor,
          closed: false,
          polling: false,
          paused: false,
          rerun: false,
          userId,
          generationId,
        }
        const listeners = this.listeners.get(key) ?? new Set<StreamListener>()
        listeners.add(listener)
        this.listeners.set(key, listeners)
        void this.catchUp(key, listener).catch(() => undefined)
        listener.timer = setInterval(() => {
          if (listener && !listener.closed && !listener.paused) {
            void this.catchUp(key, listener).catch(() => undefined)
          }
        }, 2_000)
        listener.timer.unref()
        listener.heartbeatTimer = setInterval(() => {
          if (!listener || listener.closed) return
          // Dropped by stall time, not queue length: a client that is merely
          // behind keeps streaming, one that stopped reading is let go and
          // resumes later from its Last-Event-ID.
          if (listener.stalledSince !== undefined && Date.now() - listener.stalledSince >= SLOW_CONSUMER_MAX_STALL_MS) {
            this.finishListener(key, listener)
            return
          }
          if ((listener.controller.desiredSize ?? 0) > 0) {
            listener.controller.enqueue(': keep-alive\n\n')
          }
        }, 15_000)
        listener.heartbeatTimer.unref()
      },
      pull: () => {
        if (!listener || listener.closed || !listener.paused) return
        listener.paused = false
        listener.stalledSince = undefined
        void this.catchUp(key, listener).catch(() => undefined)
      },
      cancel: () => {
        if (listener?.timer) clearInterval(listener.timer)
        if (listener?.heartbeatTimer) clearInterval(listener.heartbeatTimer)
        if (listener) listener.closed = true
        this.cleanup(key)
      },
    }, { highWaterMark: SUBSCRIBER_HIGH_WATER_BYTES, size: (chunk) => chunk.length })
  }

  /** Open SSE subscriptions in this process (for metrics). */
  subscriberCount(): number {
    let count = 0
    for (const listeners of this.listeners.values()) count += listeners.size
    return count
  }

  async close(): Promise<void> {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) {
        if (listener.timer) clearInterval(listener.timer)
        if (listener.heartbeatTimer) clearInterval(listener.heartbeatTimer)
        if (!listener.closed) listener.controller.close()
        listener.closed = true
      }
    }
    this.listeners.clear()
    this.terminalChecks.clear()
    if (this.subscriber.isOpen) await this.subscriber.close()
    this.started = false
  }
}
