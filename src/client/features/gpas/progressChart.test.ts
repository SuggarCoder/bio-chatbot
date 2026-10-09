/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProgressCard } from '../../../server/gpasContracts'
import { PROGRESS_COLORS, progressSeries, progressTotals, shortMonth } from './progressChart'

const counts = (clinic: number, media = 0, environment = 0, lab = 0) => ({ clinic, media, environment, lab })
const card = (overrides: Partial<ProgressCard> = {}): ProgressCard => ({
  projectName: '项目甲', teamName: '甲队', demo: false,
  samples: [
    { type: 'clinic', label: '临床样本', plan: 10, submitted: 7, remaining: 3, completionRate: 70 },
    { type: 'media', label: '虫媒样本', plan: 4, submitted: 6, remaining: 0, completionRate: 150 },
    { type: 'environment', label: '环境样本', plan: 0, submitted: 0, remaining: 0, completionRate: null },
    { type: 'lab', label: '实验室样本', plan: 5, submitted: 0, remaining: 5, completionRate: 0 },
  ],
  monthly: [
    { month: '2026-01', counts: counts(3, 2) },
    { month: '2026-02', counts: counts(4, 4) },
  ],
  ...overrides,
})

test('series accumulate submissions per planned type and skip types without a plan', () => {
  const { months, series, maxRate } = progressSeries(card())
  assert.deepEqual(months, ['2026-01', '2026-02'])
  assert.deepEqual(series.map((item) => item.type), ['clinic', 'media', 'lab'])
  assert.deepEqual(series[0].points, [{ cumulative: 3, rate: 30 }, { cumulative: 7, rate: 70 }])
  assert.deepEqual(series[1].points.map((point) => point.rate), [50, 150])
  assert.equal(series[0].color, PROGRESS_COLORS.clinic)
  // Over-delivery stretches the axis past 100%, rounded up to a 25% step.
  assert.equal(maxRate, 150)
  assert.equal(progressSeries(card({ monthly: [{ month: '2026-01', counts: counts(1) }] })).maxRate, 100)
})

test('totals sum every type and leave the rate empty without a plan', () => {
  assert.deepEqual(progressTotals(card()), { plan: 19, submitted: 13, remaining: 8, rate: 68.4 })
  assert.equal(progressTotals(card({ samples: [] })).rate, null)
  assert.equal(shortMonth('2026-03'), '26/03')
})
