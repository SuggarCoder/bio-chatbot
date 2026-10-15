import type { FileResultRow } from '../../../server/gpasContracts'

export type EvidenceAxis = {
  key: 'selfAlign' | 'coverage' | 'uniqueReads' | 'uniformity' | 'abundance' | 'ambiguity'
  name: string
  en: string
  raw: (row: FileResultRow) => number | null
  /** 0–100; a missing value scores 0. */
  score: (value: number) => number
  format: (value: number) => string
}

const clamp = (value: number) => Math.min(100, Math.max(0, value))
const trim = (value: number, digits: number) => String(Number(value.toFixed(digits)))

/** Clockwise from the top, as in the evidence radar design. */
export const EVIDENCE_AXES: readonly EvidenceAxis[] = [
  {
    key: 'selfAlign', name: '物种自比对率', en: 'SELF ALIGN',
    raw: (row) => row.selfAlignRatio,
    score: (ratio) => clamp(ratio * 100),
    format: (ratio) => trim(ratio, 3),
  },
  {
    key: 'coverage', name: '基因组覆盖度', en: 'COVERAGE',
    raw: (row) => row.coverageValue,
    // 20% genome coverage is full marks.
    score: (fraction) => clamp((fraction / 0.2) * 100),
    format: (fraction) => trim(fraction, 4),
  },
  {
    key: 'uniqueReads', name: '唯一匹配 Reads', en: 'UNIQUE READS',
    raw: (row) => row.onlyMatching,
    // Logarithmic: 10 reads ≈ 52, 100 reads = 100.
    score: (reads) => clamp((100 * Math.log10(1 + Math.max(0, reads))) / Math.log10(101)),
    format: (reads) => Math.round(reads).toLocaleString('zh-CN'),
  },
  {
    key: 'uniformity', name: '基因组均一度', en: 'UNIFORMITY',
    raw: (row) => row.unifPvalue,
    // Exponential saturation of −log10 P: 12.94 ≈ 86.
    score: (value) => clamp(100 * (1 - Math.exp(-Math.max(0, value) / 6.6))),
    format: (value) => trim(value, 2),
  },
  {
    key: 'abundance', name: '样本内物种丰度', en: 'ABUNDANCE',
    raw: (row) => row.abundance,
    // Logarithmic over percent: 0.01% ≈ 35, 1% ≈ 100.
    score: (pct) => clamp((100 * Math.log10(1 + Math.max(0, pct) / 0.001)) / Math.log10(1001)),
    format: (pct) => (pct < 0.01 ? '<0.01%' : `${trim(pct, 2)}%`),
  },
  {
    key: 'ambiguity', name: '物种混淆度', en: 'AMBIGUITY',
    raw: (row) => row.ani95SpeciesNums,
    // No confusable species is full marks.
    score: (count) => clamp(100 / (1 + Math.max(0, count))),
    format: (count) => String(Math.round(count)),
  },
]

export type EvidencePoint = { axis: EvidenceAxis; raw: number | null; score: number; label: string }

export function evidencePoints(row: FileResultRow): EvidencePoint[] {
  return EVIDENCE_AXES.map((axis) => {
    const raw = axis.raw(row)
    return raw === null
      ? { axis, raw, score: 0, label: '—' }
      : { axis, raw, score: Math.round(axis.score(raw)), label: axis.format(raw) }
  })
}

export type HazardGradient = { from: string; to: string; ink: string; label: string }

/** Five hazard levels as Instagram-style two-stop gradients; index 0 is "none". */
export const hazardGradients: readonly HazardGradient[] = [
  { from: '#c9c3d6', to: '#a59dbb', ink: '#6b6480', label: '未评级' },
  { from: '#5ec4c4', to: '#8fd8b0', ink: '#2f8a87', label: '1 级' },
  { from: '#6aa8f0', to: '#a48ef0', ink: '#4f6fc4', label: '2 级' },
  { from: '#f7b267', to: '#f4845f', ink: '#c2622f', label: '3 级' },
  { from: '#f27ca8', to: '#d9488f', ink: '#b8326f', label: '4 级' },
  { from: '#c13584', to: '#833ab4', ink: '#8e2b7e', label: '5 级' },
]

/** Levels above 5 use the top gradient; missing or 0 uses the neutral one. */
export function hazardGradient(level: number | null): HazardGradient {
  if (level === null || !Number.isFinite(level) || level <= 0) return hazardGradients[0]
  return hazardGradients[Math.min(5, Math.round(level))]
}

/** Point of axis `index` at `score` (0–100) on a hexagon of `radius` around (cx, cy). */
export function radarPoint(index: number, score: number, radius: number, cx: number, cy: number) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / EVIDENCE_AXES.length
  const r = (radius * Math.max(0, Math.min(100, score))) / 100
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

export const polygon = (points: Array<{ x: number; y: number }>) =>
  points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
