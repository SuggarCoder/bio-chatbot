/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileCard } from '../../../server/gpasContracts'
import { coveragePct, resultBrief, resultCategories } from './resultHelpers'

test('coverage reads percentages, fractions and plain numbers', () => {
  assert.equal(coveragePct('12.5%'), 12.5)
  assert.equal(coveragePct('0.25'), 25)
  assert.equal(coveragePct('37'), 37)
  assert.equal(coveragePct('150%'), 100)
  assert.equal(coveragePct(''), null)
  assert.equal(coveragePct('n/a'), null)
})

test('detail tabs are the detected categories of the matching card', () => {
  const category = (type: string, name: string, speciesCount: number) => ({ type, name, speciesCount, maxHazard: 0, top: [] })
  const card = (analysisId: string | null, categories: ReturnType<typeof category>[]) => ({
    groupId: null, paired: false, files: [{ fileId: 'f', fileName: 'f.fq', sizeBytes: null }], sampleType: null, status: null,
    analysisStatus: null, metaStatus: null, uploadTime: null, analysisId,
    brief: { categories, totalReads: null, dataVolume: null, tools: [] },
  }) as FileCard
  const cards = [
    card('other', [category('fungi', '真菌', 3)]),
    card('task-1', [category('bacteria', '细菌', 10), category('viral', '病毒', 2), category('animals', '动物等', 0)]),
  ]
  assert.deepEqual(resultCategories(cards, 'task-1'), [{ type: 'bacteria', name: '细菌' }, { type: 'viral', name: '病毒' }])
  assert.deepEqual(resultCategories(cards, 'missing'), [])
  assert.equal(resultBrief(cards, 'task-1'), cards[1].brief)
  assert.equal(resultBrief(cards, 'missing'), null)
})
