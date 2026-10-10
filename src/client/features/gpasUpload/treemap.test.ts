import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutTreemap, type TreemapRect } from './treemap'

const area = (rect: TreemapRect) => rect.width * rect.height
const overlaps = (a: TreemapRect, b: TreemapRect) =>
  a.x + a.width > b.x + 1e-6 && b.x + b.width > a.x + 1e-6 && a.y + a.height > b.y + 1e-6 && b.y + b.height > a.y + 1e-6

test('tiles fill the box without overlapping for any item count', () => {
  for (const count of [1, 2, 3, 5]) {
    const rects = layoutTreemap(Array.from({ length: count }, (_, index) => ({ key: `k${index}`, value: 50 - index * 8 })))
    assert.equal(rects.length, count)
    assert.ok(Math.abs(rects.reduce((sum, rect) => sum + area(rect), 0) - 100 * 100) < 1e-6, String(count))
    for (const rect of rects) {
      assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.width <= 100 + 1e-9 && rect.y + rect.height <= 100 + 1e-9)
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) assert.equal(overlaps(rects[i], rects[j]), false)
    }
  }
})

test('areas follow values, keep order, and skip empty items', () => {
  const rects = layoutTreemap([{ key: 'a', value: 60 }, { key: 'zero', value: 0 }, { key: 'b', value: 30 }, { key: 'c', value: 10 }], 1.6, 0)
  assert.deepEqual(rects.map((rect) => rect.key), ['a', 'b', 'c'])
  assert.ok(Math.abs(area(rects[0]) / 10_000 - 0.6) < 1e-9)
  assert.ok(Math.abs(area(rects[1]) / 10_000 - 0.3) < 1e-9)
  // The largest item starts at the top left of the box.
  assert.deepEqual([rects[0].x, rects[0].y], [0, 0])
  assert.deepEqual(layoutTreemap([{ key: 'x', value: 0 }]), [])
})

test('narrow boxes stack every item as a full-width row', () => {
  const rects = layoutTreemap([{ key: 'a', value: 50 }, { key: 'b', value: 30 }, { key: 'c', value: 20 }], 0.5, 0)
  assert.deepEqual(rects.map((rect) => [rect.x, rect.width]), [[0, 100], [0, 100], [0, 100]])
  assert.deepEqual(rects.map((rect) => Math.round(rect.y)), [0, 50, 80])
})

test('tiny values are lifted to a readable minimum share', () => {
  const rects = layoutTreemap([{ key: 'big', value: 98 }, { key: 'tiny', value: 2 }])
  assert.ok(area(rects[1]) / 10_000 > 0.08)
})

test('five species plus others stay close to square instead of thin strips', () => {
  const aspect = 2
  const values = [36.3, 24, 3.6, 1.8, 0.9, 33.4]
  const rects = layoutTreemap(values.map((value, index) => ({ key: `k${index}`, value })), aspect)
  assert.deepEqual(rects.map((rect) => rect.key), values.map((_, index) => `k${index}`))
  for (const rect of rects) {
    // Back to box units (width is `aspect` times the height).
    const width = rect.width * aspect
    const ratio = Math.max(width / rect.height, rect.height / width)
    assert.ok(ratio < 3, `${rect.key} ratio ${ratio.toFixed(2)}`)
  }
})
