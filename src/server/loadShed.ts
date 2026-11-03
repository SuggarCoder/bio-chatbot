import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

import { metrics } from './metrics.js'

export type LoadShedOptions = {
  /** Shed when the p99 event-loop delay of the last window exceeds this. */
  maxEventLoopDelayMs: number
  /** Shed when this many queries are already waiting for a pool connection. */
  maxPoolWaiting: number
}

export type PoolLike = { waitingCount: number }

/**
 * Rejects new work early when the process is already saturated, so latency
 * stays bounded for requests in flight instead of every request timing out.
 * The event-loop histogram is sampled in a short rolling window.
 */
export class LoadShedder {
  private readonly histogram: IntervalHistogram
  private readonly timer: NodeJS.Timeout
  private recentDelayMs = 0

  constructor(private readonly pool: PoolLike | null, private readonly options: LoadShedOptions) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.timer = setInterval(() => {
      this.recentDelayMs = this.histogram.percentile(99) / 1e6
      this.histogram.reset()
    }, 1_000)
    this.timer.unref()
  }

  /** The reason to shed this request, or null to accept it. */
  check(): 'event_loop' | 'db_pool' | null {
    if (this.recentDelayMs > this.options.maxEventLoopDelayMs) return 'event_loop'
    if (this.pool && this.pool.waitingCount > this.options.maxPoolWaiting) return 'db_pool'
    return null
  }

  shed(reason: 'event_loop' | 'db_pool'): void {
    metrics.loadShed.inc({ reason })
  }

  /** For tests: pretend the last window had this delay. */
  setRecentDelayForTest(delayMs: number): void {
    this.recentDelayMs = delayMs
  }

  stop(): void {
    clearInterval(this.timer)
    this.histogram.disable()
  }
}

/** The pg Pool behind a drizzle node-postgres database, if any. */
export function poolOf(database: unknown): PoolLike | null {
  const client = (database as { $client?: unknown }).$client
  return client && typeof (client as PoolLike).waitingCount === 'number' ? client as PoolLike : null
}
