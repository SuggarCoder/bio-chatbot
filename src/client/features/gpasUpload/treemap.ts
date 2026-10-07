export type TreemapItem = { key: string; value: number }
/** Below this width/height ratio items are stacked as rows. */
export const NARROW_ASPECT = 0.9
/** Rectangle in percent of the container. */
export type TreemapRect = { key: string; x: number; y: number; width: number; height: number }

/**
 * Template layout: the first item takes a slice along the longer side of the
 * box (left column when wide, top row when tall), sized by its value; the
 * remaining items share the rest, stacked across the other axis. Item order is
 * kept, so callers put the largest first and a catch-all ("others") last.
 * Works for any number of items; very narrow boxes stack all items as rows.
 *
 * `minShare` lifts tiny values so their tiles stay readable; the displayed
 * numbers must come from the data, not from the tile size.
 */
export function layoutTreemap(items: TreemapItem[], aspect = 1.6, minShare = 0.1): TreemapRect[] {
  const positive = items.filter((item) => Number.isFinite(item.value) && item.value > 0)
  if (positive.length === 0) return []
  const total = positive.reduce((sum, item) => sum + item.value, 0)
  const weighted = positive.map((item) => ({ key: item.key, value: Math.max(item.value, total * minShare) }))
  const sum = weighted.reduce((acc, item) => acc + item.value, 0)
  if (weighted.length === 1) return [{ key: weighted[0].key, x: 0, y: 0, width: 100, height: 100 }]

  if (aspect < NARROW_ASPECT) {
    // Too narrow for columns: one row per item keeps every label readable.
    let top = 0
    return weighted.map((item) => {
      const height = (item.value / sum) * 100
      const rect = { key: item.key, x: 0, y: top, width: 100, height }
      top += height
      return rect
    })
  }

  const [first, ...rest] = weighted
  const firstShare = (first.value / sum) * 100
  const restSum = sum - first.value
  const rects: TreemapRect[] = []
  let offset = 0
  if (aspect >= 1) {
    rects.push({ key: first.key, x: 0, y: 0, width: firstShare, height: 100 })
    for (const item of rest) {
      const height = (item.value / restSum) * 100
      rects.push({ key: item.key, x: firstShare, y: offset, width: 100 - firstShare, height })
      offset += height
    }
  } else {
    rects.push({ key: first.key, x: 0, y: 0, width: 100, height: firstShare })
    for (const item of rest) {
      const width = (item.value / restSum) * 100
      rects.push({ key: item.key, x: offset, y: firstShare, width, height: 100 - firstShare })
      offset += width
    }
  }
  return rects
}
