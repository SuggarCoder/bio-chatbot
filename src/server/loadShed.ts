import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

import { metrics } from './metrics.js'

export type LoadShedOptions = {
  /** Shed when the p99 event-loop delay of the last window exceeds this. */
  maxEventLoopDelayMs: number
  /** Shed when this many queries are already waiting for a pool connection. */
  maxPoolWaiting: number
}

export type PoolLike = { waitingCount: number }

const POOL_SAMPLE_MS = 100
const POOL_SUSTAIN_MS = 1_000

/**
 * Rejects new work early when the process is already saturated, so latency
 * stays bounded for requests in flight instead of every request timing out.
 *
 * Only SUSTAINED saturation sheds: a burst that queues briefly on the pool
 * or one slow event-loop window is absorbed (a 300-request burst in 1 s
 * completes fully without shedding). Shedding starts when the pool queue
 * stayed above its limit for POOL_SUSTAIN_MS, or the event-loop p99 was over
 * its limit for two consecutive 1 s windows.
 */
export class LoadShedder {
  private readonly histogram: IntervalHistogram
  private readonly timer: NodeJS.Timeout
  private readonly poolTimer: NodeJS.Timeout
  private recentDelayMs = 0
  private slowWindows = 0
  private poolOverSince: number | null = null

  constructor(private readonly pool: PoolLike | null, private readonly options: LoadShedOptions) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.timer = setInterval(() => {
      this.recentDelayMs = this.histogram.percentile(99) / 1e6
      this.histogram.reset()
      this.slowWindows = this.recentDelayMs > this.options.maxEventLoopDelayMs ? this.slowWindows + 1 : 0
    }, 1_000)
    this.timer.unref()
    this.poolTimer = setInterval(() => this.samplePool(), POOL_SAMPLE_MS)
    this.poolTimer.unref()
  }

  private samplePool(now = Date.now()): void {
    if (this.pool && this.pool.waitingCount > this.options.maxPoolWaiting) this.poolOverSince ??= now
    else this.poolOverSince = null
  }

  /** The reason to shed this request, or null to accept it. */
  check(now = Date.now()): 'event_loop' | 'db_pool' | null {
    if (this.slowWindows >= 2) return 'event_loop'
    // A queue that just formed is not saturation; one that persists is.
    if (this.pool && this.pool.waitingCount <= this.options.maxPoolWaiting) this.poolOverSince = null
    if (this.poolOverSince !== null && now - this.poolOverSince >= POOL_SUSTAIN_MS) return 'db_pool'
    return null
  }

  shed(reason: 'event_loop' | 'db_pool'): void {
    metrics.loadShed.inc({ reason })
  }

  /** For tests: pretend the last `windows` windows had this delay. */
  setRecentDelayForTest(delayMs: number, windows = 2): void {
    this.recentDelayMs = delayMs
    this.slowWindows = delayMs > this.options.maxEventLoopDelayMs ? windows : 0
  }

  /** For tests: sample the pool as if at `now`. */
  samplePoolForTest(now: number): void {
    this.samplePool(now)
  }

  stop(): void {
    clearInterval(this.timer)
    clearInterval(this.poolTimer)
    this.histogram.disable()
  }
}

/** The pg Pool behind a drizzle node-postgres database, if any. */
export function poolOf(database: unknown): PoolLike | null {
  const client = (database as { $client?: unknown }).$client
  return client && typeof (client as PoolLike).waitingCount === 'number' ? client as PoolLike : null
}
