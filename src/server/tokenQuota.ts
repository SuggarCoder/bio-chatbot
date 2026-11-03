import { and, desc, eq, gt, sql } from 'drizzle-orm'

import { readQuotaUsage, type RedisClient } from './cache.js'
import type { AppConfig, TokenLimitTier } from './config.js'
import { getTokenUsage, type Database } from './db.js'
import { auditLogs, quotaVoucherEvents, users } from './db/schema.js'
import type { CurrentUser } from './domain.js'
import { periodContains, quotaPeriods, type QuotaPeriod } from './quotaPeriods.js'

/**
 * Token quota: Beijing-time calendar week and month limits per service tier,
 * and Reset 卷 that reset both. A reset snapshots the usage that preceded it
 * in its week and month (the baseline); while the current period still
 * contains the reset, that baseline is subtracted from the period total.
 */

export type QuotaWindow = {
  used: number
  /** 0 means unlimited. */
  limit: number
  /** Used share, 0–100, one decimal, rounded down. */
  percent: number
  resetsAt: string
}

export type TokenQuota = {
  weekly: QuotaWindow
  monthly: QuotaWindow
  resetVouchers: number
  lastResetAt: string | null
}

export type LastReset = {
  resetAt: Date
  weeklyBaseline: number
  monthlyBaseline: number
}

export class TokenQuotaError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: 'weekly_quota_exceeded' | 'monthly_quota_exceeded' | 'no_reset_voucher',
  ) {
    super(message)
    this.name = 'TokenQuotaError'
  }
}

export function tokenLimitsFor(config: Pick<AppConfig, 'tokenLimits'>, tier: TokenLimitTier) {
  return config.tokenLimits[tier] ?? config.tokenLimits.free
}

function quotaWindow(period: QuotaPeriod, total: number, baseline: number, limit: number): QuotaWindow {
  const used = Math.max(0, total - baseline)
  const percent = limit > 0 ? Math.min(100, Math.floor((used / limit) * 1000) / 10) : 0
  return { used, limit, percent, resetsAt: period.end.toISOString() }
}

/** Pure: combines cached period totals, the latest reset and the limits. */
export function buildTokenQuota(input: {
  periods: { weekly: QuotaPeriod; monthly: QuotaPeriod }
  totals: { weekly: number; monthly: number }
  limits: { weekly: number; monthly: number }
  lastReset: LastReset | null
  resetVouchers: number
}): TokenQuota {
  const { periods, totals, limits, lastReset } = input
  const baseline = (kind: 'weekly' | 'monthly') =>
    lastReset && periodContains(periods[kind], lastReset.resetAt)
      ? kind === 'weekly' ? lastReset.weeklyBaseline : lastReset.monthlyBaseline
      : 0

  return {
    weekly: quotaWindow(periods.weekly, totals.weekly, baseline('weekly'), limits.weekly),
    monthly: quotaWindow(periods.monthly, totals.monthly, baseline('monthly'), limits.monthly),
    resetVouchers: input.resetVouchers,
    lastResetAt: lastReset?.resetAt.toISOString() ?? null,
  }
}

/** The first exhausted window, weekly before monthly, or null. */
export function exceededQuota(quota: Pick<TokenQuota, 'weekly' | 'monthly'>): TokenQuotaError | null {
  if (quota.weekly.limit > 0 && quota.weekly.used >= quota.weekly.limit) {
    return new TokenQuotaError('本周 Token 额度已用完，可使用 Reset 卷重置。', 429, 'weekly_quota_exceeded')
  }
  if (quota.monthly.limit > 0 && quota.monthly.used >= quota.monthly.limit) {
    return new TokenQuotaError('本月 Token 额度已用完，可使用 Reset 卷重置。', 429, 'monthly_quota_exceeded')
  }
  return null
}

async function readResetState(database: Database, userId: string) {
  const [[balanceRow], [resetRow]] = await Promise.all([
    database
      .select({ balance: users.resetVoucherBalance })
      .from(users)
      .where(eq(users.id, userId)),
    database
      .select({
        resetAt: quotaVoucherEvents.resetAt,
        weeklyBaseline: quotaVoucherEvents.weeklyBaseline,
        monthlyBaseline: quotaVoucherEvents.monthlyBaseline,
      })
      .from(quotaVoucherEvents)
      .where(and(eq(quotaVoucherEvents.userId, userId), eq(quotaVoucherEvents.kind, 'redeem')))
      .orderBy(desc(quotaVoucherEvents.createdAt))
      .limit(1),
  ])

  const lastReset: LastReset | null = resetRow?.resetAt
    ? {
        resetAt: resetRow.resetAt,
        weeklyBaseline: Number(resetRow.weeklyBaseline ?? 0n),
        monthlyBaseline: Number(resetRow.monthlyBaseline ?? 0n),
      }
    : null

  return { resetVouchers: balanceRow?.balance ?? 0, lastReset }
}

export async function getTokenQuota(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  user: Pick<CurrentUser, 'id' | 'serviceTier'>,
  now = new Date(),
): Promise<TokenQuota> {
  const [usage, state] = await Promise.all([
    readQuotaUsage(database, redis, config, user.id, now),
    readResetState(database, user.id),
  ])

  return buildTokenQuota({
    periods: usage.periods,
    totals: { weekly: usage.weekly, monthly: usage.monthly },
    limits: tokenLimitsFor(config, user.serviceTier),
    lastReset: state.lastReset,
    resetVouchers: state.resetVouchers,
  })
}

/** Rejects new model work once the weekly or monthly quota is used up. */
export async function assertTokenQuota(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  user: Pick<CurrentUser, 'id' | 'serviceTier'>,
): Promise<void> {
  const limits = tokenLimitsFor(config, user.serviceTier)
  if (limits.weekly <= 0 && limits.monthly <= 0) return

  const exceeded = exceededQuota(await getTokenQuota(database, redis, config, user))
  if (exceeded) throw exceeded
}

/** Spends one Reset 卷 and restarts both the weekly and the monthly quota. */
export async function redeemResetVoucher(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  user: Pick<CurrentUser, 'id' | 'serviceTier' | 'externalUserId'>,
): Promise<TokenQuota> {
  await database.transaction(async (transaction) => {
    const [spent] = await transaction
      .update(users)
      .set({ resetVoucherBalance: sql`${users.resetVoucherBalance} - 1` })
      .where(and(eq(users.id, user.id), gt(users.resetVoucherBalance, 0)))
      .returning({ balance: users.resetVoucherBalance })

    if (!spent) {
      throw new TokenQuotaError('没有可用的 Reset 卷。', 409, 'no_reset_voucher')
    }

    const resetAt = new Date()
    const periods = quotaPeriods(resetAt)
    const weeklyBaseline = await getTokenUsage(transaction, user.id, periods.weekly.start, resetAt)
    const monthlyBaseline = await getTokenUsage(transaction, user.id, periods.monthly.start, resetAt)

    await transaction.insert(quotaVoucherEvents).values({
      userId: user.id,
      kind: 'redeem',
      delta: -1,
      resetAt,
      weeklyBaseline: BigInt(weeklyBaseline),
      monthlyBaseline: BigInt(monthlyBaseline),
    })
    await transaction.insert(auditLogs).values({
      actorUserId: user.id,
      actorExternalUserId: user.externalUserId,
      action: 'token_quota.reset',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { weeklyBaseline, monthlyBaseline, remainingVouchers: spent.balance },
    })
  })

  return getTokenQuota(database, redis, config, user)
}

/** Admin: issues Reset 卷 to a user. Returns the new balance. */
export async function grantResetVouchers(
  database: Database,
  userId: string,
  count: number,
  note?: string,
): Promise<number> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('count must be a positive integer')
  }

  return database.transaction(async (transaction) => {
    const [granted] = await transaction
      .update(users)
      .set({ resetVoucherBalance: sql`${users.resetVoucherBalance} + ${count}` })
      .where(eq(users.id, userId))
      .returning({ balance: users.resetVoucherBalance })

    if (!granted) throw new Error(`User ${userId} not found`)

    await transaction.insert(quotaVoucherEvents).values({
      userId,
      kind: 'grant',
      delta: count,
      note: note ?? null,
    })
    await transaction.insert(auditLogs).values({
      action: 'token_quota.voucher_grant',
      resourceType: 'user',
      resourceId: userId,
      metadata: { count, note: note ?? null, balance: granted.balance },
    })
    return granted.balance
  })
}
