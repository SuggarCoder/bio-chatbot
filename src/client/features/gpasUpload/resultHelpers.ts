import { categorySharePct, sampleNameOf, type FileBrief, type FileCard } from '../../../server/gpasContracts'

/** Coverage as a 0–100 bar width, or null when the value is not numeric. */
export function coveragePct(value: string): number | null {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  const pct = value.includes('%') || parsed > 1 ? parsed : parsed * 100
  return Math.min(100, Math.max(0, pct))
}

/** The sample name of the card whose analysisId is `taskId`, or null. */
export function resultSampleName(cards: readonly FileCard[], taskId: string) {
  const card = cards.find((item) => item.analysisId === taskId)
  return card ? sampleNameOf(card.files.map((file) => file.fileName)) : null
}

/** The briefAnalysis of the card whose analysisId is `taskId`. */
export function resultBrief(cards: readonly FileCard[], taskId: string) {
  return cards.find((item) => item.analysisId === taskId)?.brief ?? null
}

/** Category tabs for a task, from its analysis card (detected categories only). */
export function resultCategories(cards: readonly FileCard[], taskId: string) {
  const card = cards.find((item) => item.analysisId === taskId)
  return (card?.brief?.categories ?? [])
    .filter((category) => category.speciesCount > 0 && category.type)
    .map((category) => ({ type: category.type, name: category.name }))
}

/**
 * Each detected category's most abundant species, in the brief's category
 * order (the detail panel's tab order). Abundance is relative within a
 * category, so species of different categories are not ranked together.
 */
export function categoryTopSpecies(brief: FileBrief) {
  return brief.categories
    .filter((category) => category.speciesCount > 0 && category.top.length > 0)
    .map((category) => ({
      ...category.top.reduce((best, item) => item.abundancePct > best.abundancePct ? item : best),
      type: category.type,
      category: category.name,
    }))
}

/**
 * Category colors for composition bars, validated as a categorical set
 * (adjacent CVD and normal-vision separation on the light surface). Known
 * categories keep their slot; others take the free slots in brief order.
 */
export const COMPOSITION_COLORS = ['#00918f', '#eb6834', '#6c5ce0', '#e0a000', '#c2457e'] as const
const COMPOSITION_SLOTS: Record<string, number> = { bacteria: 0, viral: 1, fungi: 2, archaea: 3, animals: 4 }
export const OTHER_COLOR = '#b8c0c6'

export type CompositionSegment = { type: string; name: string; count: number; sharePct: number; color: string }

/** Detected categories of a brief in a fixed order, colored by category; past five fold into 其他. */
export function compositionSegments(brief: FileBrief | null): CompositionSegment[] {
  if (!brief) return []
  const detected = brief.categories.filter((category) => category.speciesCount > 0)
  const used = new Set(detected.map((category) => COMPOSITION_SLOTS[category.type]).filter((slot) => slot !== undefined))
  const free = COMPOSITION_COLORS.map((_, slot) => slot).filter((slot) => !used.has(slot))
  const slotted = detected.map((category) => ({ category, slot: COMPOSITION_SLOTS[category.type] ?? free.shift() }))
  const segments: CompositionSegment[] = slotted
    .filter((item) => item.slot !== undefined)
    .sort((a, b) => a.slot! - b.slot!)
    .map(({ category, slot }) => ({
      type: category.type, name: category.name, count: category.speciesCount,
      sharePct: categorySharePct(category.speciesCount, brief.categories), color: COMPOSITION_COLORS[slot!],
    }))
  const rest = slotted.filter((item) => item.slot === undefined)
  if (rest.length) {
    const count = rest.reduce((sum, item) => sum + item.category.speciesCount, 0)
    segments.push({ type: 'other', name: '其他', count, sharePct: categorySharePct(count, brief.categories), color: OTHER_COLOR })
  }
  return segments
}
