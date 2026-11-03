import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppConfig } from './config.js'
import { quotaPeriods } from './quotaPeriods.js'
import { buildTokenQuota, exceededQuota, tokenLimitsFor } from './tokenQuota.js'

const now = new Date('2026-11-12T10:00:00+08:00') // Thursday
const periods = quotaPeriods(now)
const limits = { weekly: 1_000, monthly: 4_000 }

test('usage is the period total when no reset falls in the period', () => {
  const quota = buildTokenQuota({
    periods,
    totals: { weekly: 720, monthly: 2_240 },
    limits,
    lastReset: { resetAt: new Date('2026-10-20T10:00:00+08:00'), weeklyBaseline: 500, monthlyBaseline: 900 },
    resetVouchers: 2,
  })
  assert.deepEqual(quota.weekly, { used: 720, limit: 1_000, percent: 72, resetsAt: '2026-11-15T16:00:00.000Z' })
  assert.deepEqual(quota.monthly, { used: 2_240, limit: 4_000, percent: 56, resetsAt: '2026-11-30T16:00:00.000Z' })
  assert.equal(quota.resetVouchers, 2)
  assert.equal(quota.lastResetAt, '2026-10-20T02:00:00.000Z')
})

test('a reset subtracts its baseline only from the periods that contain it', () => {
  // Reset last Friday: same month, previous week.
  const lastWeek = buildTokenQuota({
    periods,
    totals: { weekly: 300, monthly: 3_000 },
    limits,
    lastReset: { resetAt: new Date('2026-11-06T09:00:00+08:00'), weeklyBaseline: 800, monthlyBaseline: 2_500 },
    resetVouchers: 0,
  })
  assert.equal(lastWeek.weekly.used, 300)
  assert.equal(lastWeek.monthly.used, 500)

  // Reset this week: both windows restart from it.
  const thisWeek = buildTokenQuota({
    periods,
    totals: { weekly: 1_200, monthly: 3_000 },
    limits,
    lastReset: { resetAt: new Date('2026-11-11T09:00:00+08:00'), weeklyBaseline: 1_150, monthlyBaseline: 2_950 },
    resetVouchers: 0,
  })
  assert.equal(thisWeek.weekly.used, 50)
  assert.equal(thisWeek.monthly.used, 50)
})

test('usage never goes negative and percent is capped and rounded down', () => {
  const quota = buildTokenQuota({
    periods,
    // A cached total that has not caught up with the baseline yet.
    totals: { weekly: 100, monthly: 10_000 },
    limits,
    lastReset: { resetAt: new Date('2026-11-10T09:00:00+08:00'), weeklyBaseline: 400, monthlyBaseline: 0 },
    resetVouchers: 0,
  })
  assert.equal(quota.weekly.used, 0)
  assert.equal(quota.weekly.percent, 0)
  assert.equal(quota.monthly.percent, 100)

  const almost = buildTokenQuota({ periods, totals: { weekly: 9_999, monthly: 0 }, limits: { weekly: 10_000, monthly: 0 }, lastReset: null, resetVouchers: 0 })
  assert.equal(almost.weekly.percent, 99.9, 'not shown as 100% while still allowed')
})

test('a zero limit is unlimited', () => {
  const quota = buildTokenQuota({ periods, totals: { weekly: 5_000, monthly: 5_000 }, limits: { weekly: 0, monthly: 0 }, lastReset: null, resetVouchers: 0 })
  assert.equal(quota.weekly.percent, 0)
  assert.equal(exceededQuota(quota), null)
})

test('the weekly limit is reported before the monthly one', () => {
  const window = (used: number, limit: number) => ({ used, limit, percent: 0, resetsAt: '' })
  assert.equal(exceededQuota({ weekly: window(1_000, 1_000), monthly: window(4_000, 4_000) })?.code, 'weekly_quota_exceeded')
  assert.equal(exceededQuota({ weekly: window(10, 1_000), monthly: window(4_000, 4_000) })?.code, 'monthly_quota_exceeded')
  assert.equal(exceededQuota({ weekly: window(999, 1_000), monthly: window(3_999, 4_000) }), null)
  assert.equal(exceededQuota({ weekly: window(1_000, 1_000), monthly: window(0, 0) })?.statusCode, 429)
})

test('limits are chosen by service tier', () => {
  const config = {
    tokenLimits: {
      free: { weekly: 1, monthly: 2 },
      pro: { weekly: 10, monthly: 20 },
      enterprise: { weekly: 0, monthly: 0 },
    },
  } as Pick<AppConfig, 'tokenLimits'>
  assert.deepEqual(tokenLimitsFor(config, 'pro'), { weekly: 10, monthly: 20 })
  assert.deepEqual(tokenLimitsFor(config, 'enterprise'), { weekly: 0, monthly: 0 })
})
