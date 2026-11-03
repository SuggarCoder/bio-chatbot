import assert from 'node:assert/strict'
import { test } from 'node:test'

import { monthPeriod, periodContains, weekPeriod } from './quotaPeriods.js'

test('weeks start on Monday 00:00 Beijing time', () => {
  // Sunday 2026-11-08 23:59 +08:00 belongs to the week of Monday 11-02.
  const sunday = weekPeriod(new Date('2026-11-08T23:59:00+08:00'))
  assert.equal(sunday.key, 'w20261102')
  assert.equal(sunday.start.toISOString(), '2026-11-01T16:00:00.000Z')
  assert.equal(sunday.end.toISOString(), '2026-11-08T16:00:00.000Z')

  // One minute later a new week begins.
  const monday = weekPeriod(new Date('2026-11-09T00:00:00+08:00'))
  assert.equal(monday.key, 'w20261109')
  assert.equal(monday.start.toISOString(), '2026-11-08T16:00:00.000Z')
})

test('Beijing Monday morning is still the previous UTC day', () => {
  // 2026-11-09 07:00 +08:00 is Sunday 23:00 UTC, yet already the new week.
  const period = weekPeriod(new Date('2026-11-08T23:00:00Z'))
  assert.equal(period.key, 'w20261109')
})

test('weeks span month and year boundaries', () => {
  const period = weekPeriod(new Date('2027-01-01T12:00:00+08:00'))
  assert.equal(period.key, 'w20261228')
  assert.equal(period.end.toISOString(), '2027-01-03T16:00:00.000Z')
})

test('months start on the 1st 00:00 Beijing time', () => {
  const lastMinute = monthPeriod(new Date('2026-11-30T23:59:00+08:00'))
  assert.equal(lastMinute.key, 'm202611')
  assert.equal(lastMinute.start.toISOString(), '2026-10-31T16:00:00.000Z')
  assert.equal(lastMinute.end.toISOString(), '2026-11-30T16:00:00.000Z')

  const firstMinute = monthPeriod(new Date('2026-12-01T00:00:00+08:00'))
  assert.equal(firstMinute.key, 'm202612')

  const december = monthPeriod(new Date('2026-12-31T20:00:00Z'))
  assert.equal(december.key, 'm202701', '04:00 on Jan 1st in Beijing')
  assert.equal(december.end.toISOString(), '2027-01-31T16:00:00.000Z')
})

test('cache TTL outlives the period', () => {
  const now = new Date('2026-11-08T23:59:00+08:00')
  const period = weekPeriod(now)
  assert.ok(period.ttlSeconds > (period.end.getTime() - now.getTime()) / 1000)
})

test('periodContains is start-inclusive and end-exclusive', () => {
  const period = monthPeriod(new Date('2026-11-15T00:00:00+08:00'))
  assert.equal(periodContains(period, period.start), true)
  assert.equal(periodContains(period, period.end), false)
})
