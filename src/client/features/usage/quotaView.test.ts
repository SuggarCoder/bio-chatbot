import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TokenQuotaDto, TokenQuotaWindowDto } from '../chatbot/chatApi'
import { displayPercent, formatTokens, quotaTone, resetAvailability, resetLabel, usageCaption } from './quotaView'

const window = (used: number, limit: number, percent = limit ? Math.min(100, Math.floor((used / limit) * 1000) / 10) : 0): TokenQuotaWindowDto => ({
  used,
  limit,
  percent,
  resetsAt: '2026-11-15T16:00:00.000Z',
})

test('percent is a whole number that only reads 100 once the limit is hit', () => {
  assert.equal(displayPercent(window(720, 1_000)), 72)
  assert.equal(displayPercent(window(999_999, 1_000_000)), 99)
  assert.equal(displayPercent(window(1_000, 1_000)), 100)
  assert.equal(displayPercent(window(5_000, 1_000)), 100)
  assert.equal(displayPercent(window(5_000, 0)), 0, 'unlimited')
})

test('the bar warns from 90% and turns exhausted at the limit', () => {
  assert.equal(quotaTone(window(720, 1_000)), 'normal')
  assert.equal(quotaTone(window(900, 1_000)), 'warning')
  assert.equal(quotaTone(window(1_000, 1_000)), 'exhausted')
  assert.equal(quotaTone(window(1_000, 0)), 'normal')
})

test('token counts use 万 and 亿', () => {
  assert.equal(formatTokens(860), '860')
  assert.equal(formatTokens(9_999), '9,999')
  assert.equal(formatTokens(12_000), '1.2万')
  assert.equal(formatTokens(3_500_000), '350万')
  assert.equal(formatTokens(150_000_000), '1.5亿')
})

test('reset times are shown in Beijing time', () => {
  assert.equal(resetLabel('2026-11-15T16:00:00.000Z'), '11月16日 00:00 重置')
  assert.equal(usageCaption(window(720_000, 1_000_000)), '已用 72万 / 100万 · 11月16日 00:00 重置')
  assert.equal(usageCaption(window(720_000, 0)), '已用 72万 · 不限额度')
})

test('a Reset 卷 is offered only when it would change something', () => {
  const quota = (overrides: Partial<TokenQuotaDto>): TokenQuotaDto => ({
    weekly: window(720, 1_000),
    monthly: window(2_240, 4_000),
    resetVouchers: 1,
    lastResetAt: null,
    ...overrides,
  })
  assert.deepEqual(resetAvailability(quota({})), { available: true })
  assert.equal(resetAvailability(quota({ resetVouchers: 0 })).available, false)
  assert.equal(resetAvailability(quota({ weekly: window(0, 1_000), monthly: window(0, 4_000) })).available, false)
  assert.equal(resetAvailability(quota({ weekly: window(10, 0), monthly: window(10, 0) })).available, false)
})
