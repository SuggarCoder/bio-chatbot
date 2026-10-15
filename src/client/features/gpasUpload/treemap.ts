export type TreemapItem = { key: string; value: number }
/** Below this width/height ratio items are stacked as rows. */
export const NARROW_ASPECT = 0.9
/** Rectangle in percent of the container. */
export type TreemapRect = { key: string; x: number; y: number; width: number; height: number }

/** Worst width/height ratio of a row of areas laid along a side of length `side`. */
function worstRatio(row: number[], side: number) {
  const sum = row.reduce((acc, value) => acc + value, 0)
  const thickness = sum / side
  return Math.max(...row.map((value) => {
    const length = value / thickness
    return Math.max(length / thickness, thickness / length)
  }))
}

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): items fill rows along the
 * shorter side of the remaining box, and a row closes once another item would
 * make its tiles less square. Item order is kept, so callers put the largest
 * first and a catch-all ("others") last; very narrow boxes stack all items as
 * rows instead.
 *
 * `aspect` is the box's width/height. `minShare` lifts tiny values so their
 * tiles stay readable; the displayed numbers must come from the data, not from
 * the tile size.
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

  // Lay out in units where the box is aspect × 1, then convert to percent.
  const areas = weighted.map((item) => (item.value / sum) * aspect)
  const rects: TreemapRect[] = []
  let box = { x: 0, y: 0, width: aspect, height: 1 }
  let index = 0
  while (index < areas.length) {
    const side = Math.min(box.width, box.height)
    const row = [areas[index]]
    let next = index + 1
    while (next < areas.length && worstRatio([...row, areas[next]], side) <= worstRatio(row, side)) {
      row.push(areas[next])
      next += 1
    }
    const thickness = row.reduce((acc, value) => acc + value, 0) / side
    let offset = 0
    row.forEach((area, position) => {
      const length = area / thickness
      const key = weighted[index + position].key
      rects.push(box.width >= box.height
        ? { key, x: box.x, y: box.y + offset, width: thickness, height: length }
        : { key, x: box.x + offset, y: box.y, width: length, height: thickness })
      offset += length
    })
    box = box.width >= box.height
      ? { x: box.x + thickness, y: box.y, width: box.width - thickness, height: box.height }
      : { x: box.x, y: box.y + thickness, width: box.width, height: box.height - thickness }
    index = next
  }
  return rects.map((rect) => ({
    key: rect.key,
    x: (rect.x / aspect) * 100,
    y: rect.y * 100,
    width: (rect.width / aspect) * 100,
    height: rect.height * 100,
  }))
}
