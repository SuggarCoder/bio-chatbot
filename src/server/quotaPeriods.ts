/**
 * Token quota periods: calendar weeks (Monday 00:00) and calendar months
 * (the 1st, 00:00) in Beijing time. Asia/Shanghai has no DST, so a fixed
 * +08:00 offset is exact.
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Cached totals outlive their period briefly so late increments still land. */
const CACHE_GRACE_MS = 7 * DAY_MS

export type QuotaPeriodKind = 'weekly' | 'monthly'

export type QuotaPeriod = {
  kind: QuotaPeriodKind
  start: Date
  end: Date
  /** Stable cache key segment, e.g. `w20261102` or `m202611`. */
  key: string
  ttlSeconds: number
}

/** Beijing wall-clock fields of an instant, read via UTC getters. */
function beijingWallClock(now: Date) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS)
}

/** The instant at which the given Beijing wall-clock midnight occurs. */
function fromBeijingMidnight(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day) - BEIJING_OFFSET_MS)
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function ttlSeconds(end: Date, now: Date) {
  return Math.max(60, Math.floor((end.getTime() + CACHE_GRACE_MS - now.getTime()) / 1000))
}

export function weekPeriod(now = new Date()): QuotaPeriod {
  const wall = beijingWallClock(now)
  // getUTCDay: 0 = Sunday … 6 = Saturday; weeks start on Monday.
  const daysSinceMonday = (wall.getUTCDay() + 6) % 7
  const start = fromBeijingMidnight(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() - daysSinceMonday,
  )
  const end = new Date(start.getTime() + 7 * DAY_MS)
  const startWall = beijingWallClock(start)

  return {
    kind: 'weekly',
    start,
    end,
    key: `w${startWall.getUTCFullYear()}${pad(startWall.getUTCMonth() + 1)}${pad(startWall.getUTCDate())}`,
    ttlSeconds: ttlSeconds(end, now),
  }
}

export function monthPeriod(now = new Date()): QuotaPeriod {
  const wall = beijingWallClock(now)
  const year = wall.getUTCFullYear()
  const month = wall.getUTCMonth()
  const end = fromBeijingMidnight(year, month + 1, 1)

  return {
    kind: 'monthly',
    start: fromBeijingMidnight(year, month, 1),
    end,
    key: `m${year}${pad(month + 1)}`,
    ttlSeconds: ttlSeconds(end, now),
  }
}

export function quotaPeriods(now = new Date()) {
  return { weekly: weekPeriod(now), monthly: monthPeriod(now) }
}

export function periodContains(period: QuotaPeriod, instant: Date) {
  return instant >= period.start && instant < period.end
}
