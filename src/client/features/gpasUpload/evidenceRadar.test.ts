/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileResultRow } from '../../../server/gpasContracts'
import { evidencePoints, hazardGradient, hazardGradients, radarPoint } from './evidenceRadar'

const row = (overrides: Partial<FileResultRow> = {}): FileResultRow => ({
  id: 'r', speciesType: 'bacteria', taxCname: '甲', taxEname: 'A', coverage: '0.05', coverageUrl: null,
  colonization: '', colonizationE: '', color: null, barcodeId: '', taxId: '1', hazardIndex: 3, coverageValue: 0.05,
  selfAlignRatio: 1, onlyMatching: 10, unifPvalue: 12.94, abundance: 0.005, ani95SpeciesNums: 0,
  ...overrides,
})

test('evidence scores follow the recommended normalization', () => {
  const points = evidencePoints(row())
  assert.deepEqual(points.map((point) => point.axis.name), ['物种自比对率', '基因组覆盖度', '唯一匹配 Reads', '基因组均一度', '样本内物种丰度', '物种混淆度'])
  assert.deepEqual(points.map((point) => point.score), [100, 25, 52, 86, 26, 100])
  assert.ok(points[4].score < 35)
  assert.deepEqual(points.map((point) => point.label), ['1', '0.05', '10', '12.94', '<0.01%', '0'])
  // Anchors of each rule.
  const anchors = evidencePoints(row({ coverageValue: 0.2, onlyMatching: 100, abundance: 1, ani95SpeciesNums: 1 }))
  assert.deepEqual(anchors.map((point) => point.score), [100, 100, 100, 86, 100, 50])
  assert.equal(evidencePoints(row({ abundance: 0.01 }))[4].score, 35)
})

test('missing or out-of-range evidence is bounded', () => {
  const points = evidencePoints(row({ selfAlignRatio: null, coverageValue: 3, onlyMatching: -5, unifPvalue: null, abundance: 50, ani95SpeciesNums: null }))
  assert.deepEqual(points.map((point) => point.score), [0, 100, 0, 0, 100, 0])
  assert.equal(points[0].label, '—')
  assert.equal(points[3].label, '—')
})

test('hazard levels map to five gradients plus a neutral one', () => {
  assert.equal(hazardGradient(null), hazardGradients[0])
  assert.equal(hazardGradient(0), hazardGradients[0])
  assert.equal(hazardGradient(1), hazardGradients[1])
  assert.equal(hazardGradient(5), hazardGradients[5])
  assert.equal(hazardGradient(9), hazardGradients[5])
  assert.equal(new Set(hazardGradients.map((item) => item.from)).size, 6)
})

test('radar points start at the top and go clockwise', () => {
  const top = radarPoint(0, 100, 50, 100, 100)
  assert.equal(Math.round(top.x), 100)
  assert.equal(Math.round(top.y), 50)
  const right = radarPoint(1, 100, 50, 100, 100)
  assert.ok(right.x > 100 && right.y < 100)
  const center = radarPoint(2, 0, 50, 100, 100)
  assert.deepEqual([center.x, center.y], [100, 100])
})
