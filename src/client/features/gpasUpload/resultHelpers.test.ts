/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileCard } from '../../../server/gpasContracts'
import { categoryTopSpecies, COMPOSITION_COLORS, compositionSegments, coveragePct, OTHER_COLOR, resultBrief, resultCategories, resultSampleName } from './resultHelpers'

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
  assert.equal(resultSampleName(cards, 'task-1'), 'f')
  assert.equal(resultSampleName(cards, 'missing'), null)
})

test('composition segments keep a fixed category order and color, and fold past five into 其他', () => {
  const category = (type: string, name: string, speciesCount: number) => ({ type, name, speciesCount, maxHazard: 0, top: [] })
  const brief = (categories: ReturnType<typeof category>[]) => ({ categories, totalReads: null, dataVolume: null, tools: [] })
  const segments = compositionSegments(brief([category('fungi', '真菌', 5), category('bacteria', '细菌', 188), category('viral', '病毒', 4), category('animals', '动物等', 0)]))
  assert.deepEqual(segments.map((segment) => [segment.name, segment.count, segment.sharePct, segment.color]), [
    ['细菌', 188, 95.4, COMPOSITION_COLORS[0]], ['病毒', 4, 2, COMPOSITION_COLORS[1]], ['真菌', 5, 2.5, COMPOSITION_COLORS[2]],
  ])
  // Unknown categories take free slots; a sixth folds into 其他.
  const many = compositionSegments(brief([
    category('bacteria', '细菌', 10), category('t1', '甲', 1), category('t2', '乙', 1), category('t3', '丙', 1), category('t4', '丁', 1), category('t5', '戊', 1),
  ]))
  assert.deepEqual(many.map((segment) => segment.name), ['细菌', '甲', '乙', '丙', '丁', '其他'])
  assert.equal(many.at(-1)!.color, OTHER_COLOR)
  assert.equal(many.at(-1)!.count, 1)
  assert.deepEqual(compositionSegments(null), [])
})

test('top species are each category\'s most abundant one, in tab order', () => {
  const species = (cnName: string, abundancePct: number) => ({ cnName, enName: '', taxId: '1', abundancePct, hazard: 0 })
  const category = (type: string, name: string, speciesCount: number, top: ReturnType<typeof species>[]) =>
    ({ type, name, speciesCount, maxHazard: 0, top })
  const brief = {
    categories: [
      category('bacteria', '细菌', 188, [species('空肠普雷沃菌', 36.3), species('产黑色普雷沃菌', 24)]),
      category('viral', '病毒', 4, [species('人呼吸道病毒3型', 2.2), species('甲型流感病毒', 54.1)]),
      category('animals', '动物等', 0, []),
      category('archaea', '古菌', 2, []),
      category('fungi', '真菌', 5, [species('不完全链格孢', 89.1)]),
    ],
    totalReads: null, dataVolume: null, tools: [],
  }
  const cards = [{ analysisId: 'task-1', brief } as unknown as FileCard]
  const top = categoryTopSpecies(brief)
  assert.deepEqual(top.map((item) => [item.category, item.cnName]), [['细菌', '空肠普雷沃菌'], ['病毒', '甲型流感病毒'], ['真菌', '不完全链格孢']])
  // Same order as the panel tabs.
  const tabs = resultCategories(cards, 'task-1').map((item) => item.type)
  assert.deepEqual(top.map((item) => item.type), tabs.filter((type) => top.some((item) => item.type === type)))
})
