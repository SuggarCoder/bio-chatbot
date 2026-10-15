import type { ProgressCard } from '../../../server/gpasContracts'

/**
 * Sample-type line colors, validated as a categorical set across all pairs
 * (lines cross): CVD and normal-vision separation and 3:1 contrast pass on
 * the light surface. Teal leads, matching the theme.
 */
export const PROGRESS_COLORS = { clinic: '#00918f', media: '#eb6834', environment: '#6c5ce0', lab: '#9b2f6f' } as const

export type ProgressSeries = {
  type: keyof typeof PROGRESS_COLORS
  label: string
  color: string
  plan: number
  /** Cumulative submissions and completion (%) per month, aligned with `months`. */
  points: Array<{ cumulative: number; rate: number }>
}

/** Cumulative completion per planned sample type, month by month. */
export function progressSeries(progress: ProgressCard): { months: string[]; series: ProgressSeries[]; maxRate: number } {
  const months = progress.monthly.map((item) => item.month)
  const series = progress.samples
    .filter((sample) => sample.plan > 0)
    .map((sample) => {
      let cumulative = 0
      return {
        type: sample.type,
        label: sample.label,
        color: PROGRESS_COLORS[sample.type],
        plan: sample.plan,
        points: progress.monthly.map((item) => {
          cumulative += item.counts[sample.type]
          return { cumulative, rate: Math.round((cumulative / sample.plan) * 1000) / 10 }
        }),
      }
    })
  const peak = Math.max(100, ...series.flatMap((item) => item.points.map((point) => point.rate)))
  // Round the axis top up to a multiple of 25 so ticks stay readable.
  return { months, series, maxRate: Math.ceil(peak / 25) * 25 }
}

/** Totals over all sample types; null rate when nothing is planned. */
export function progressTotals(progress: ProgressCard) {
  const plan = progress.samples.reduce((sum, sample) => sum + sample.plan, 0)
  const submitted = progress.samples.reduce((sum, sample) => sum + sample.submitted, 0)
  const remaining = progress.samples.reduce((sum, sample) => sum + sample.remaining, 0)
  return { plan, submitted, remaining, rate: plan > 0 ? Math.round((submitted / plan) * 1000) / 10 : null }
}

/** "2026-03" → "26/03". */
export const shortMonth = (month: string) => `${month.slice(2, 4)}/${month.slice(5, 7)}`
