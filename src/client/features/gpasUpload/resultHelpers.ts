import type { FileCard } from '../../../server/gpasContracts'

/** Coverage as a 0–100 bar width, or null when the value is not numeric. */
export function coveragePct(value: string): number | null {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  const pct = value.includes('%') || parsed > 1 ? parsed : parsed * 100
  return Math.min(100, Math.max(0, pct))
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
