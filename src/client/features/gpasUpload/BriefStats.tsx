import { For, Show, type JSX } from 'solid-js'
import { categorySharePct, type FileBrief } from '../../../server/gpasContracts'
import { hazardGradient } from './evidenceRadar'
import { formatPercent, formatReads, formatVolume, toneFor } from './FileAnalysisCards'

/** Story-ring style outline in the app's teal theme. */
const RING = 'linear-gradient(135deg, #2c7378, #6a9ea2 55%, #b9ced2)'

export function briefStats(brief: FileBrief) {
  const detected = brief.categories.filter((category) => category.speciesCount > 0)
  const totalSpecies = detected.reduce((sum, category) => sum + category.speciesCount, 0)
  const maxHazard = brief.categories.reduce((max, category) => Math.max(max, category.maxHazard), 0)
  // Slices use the same category colors as the analysis cards.
  const slices = detected.map((category, index) => ({
    name: category.name,
    count: category.speciesCount,
    sharePct: categorySharePct(category.speciesCount, brief.categories),
    color: toneFor(category.type, index).tiles[0].bg,
  }))
  const topSpecies = detected
    .flatMap((category) => category.top.map((item) => ({ ...item, category: category.name })))
    .sort((a, b) => b.abundancePct - a.abundancePct)
    .slice(0, 3)
  return { totalSpecies, categoryCount: detected.length, maxHazard, slices, topSpecies }
}

function Donut(props: { slices: ReturnType<typeof briefStats>['slices'] }) {
  const R = 30
  const C = 2 * Math.PI * R
  const arcs = () => {
    const total = props.slices.reduce((sum, slice) => sum + slice.count, 0) || 1
    let offset = 0
    return props.slices.map((slice) => {
      const length = (slice.count / total) * C
      const arc = { ...slice, dash: `${Math.max(0, length - 1.5)} ${C}`, offset: -offset }
      offset += length
      return arc
    })
  }
  return (
    <span class="grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full p-[3px]" style={{ 'background-image': RING }}>
      <span class="grid h-full w-full place-items-center rounded-full bg-white">
        <svg viewBox="0 0 80 80" class="h-[70px] w-[70px] -rotate-90" aria-hidden="true">
          <circle cx="40" cy="40" r={R} fill="none" stroke="#eef2f3" stroke-width="11" />
          <For each={arcs()}>
            {(arc) => <circle cx="40" cy="40" r={R} fill="none" stroke={arc.color} stroke-width="11" stroke-dasharray={arc.dash} stroke-dashoffset={arc.offset} stroke-linecap="butt" />}
          </For>
        </svg>
      </span>
    </span>
  )
}

function Kpi(props: { label: string; value: string; hint?: JSX.Element; primary?: boolean; testId?: string }) {
  return (
    <div
      class={`min-w-0 flex-[1_1_120px] rounded-2xl p-3 ${props.primary ? 'text-white shadow-[0_6px_16px_-10px_rgba(44,115,120,0.8)]' : 'bg-white text-slate-800 ring-1 ring-slate-100'}`}
      style={props.primary ? { 'background-image': 'linear-gradient(135deg, #2c7378, #4f9095)' } : undefined}
      data-testid={props.testId}
    >
      <p class={`text-[11px] font-medium ${props.primary ? 'text-white/75' : 'text-slate-400'}`}>{props.label}</p>
      <p class={`mt-1 truncate text-xl font-bold tabular-nums leading-6 ${props.primary ? '' : 'text-teal-700'}`}>{props.value}</p>
      <Show when={props.hint}><p class={`mt-0.5 truncate text-[11px] ${props.primary ? 'text-white/75' : 'text-slate-500'}`}>{props.hint}</p></Show>
    </div>
  )
}

/** Sample-level statistics from briefAnalysis, above the species table. */
export function BriefStats(props: { brief: FileBrief }) {
  const stats = () => briefStats(props.brief)
  const hazard = () => hazardGradient(stats().maxHazard)
  return (
    <section class="space-y-2.5 px-3 pb-1 pt-3" aria-label="分析摘要统计" data-testid="gpas-brief-stats">
      <div class="flex flex-wrap gap-2.5">
        <Kpi
          label="检出物种"
          value={stats().totalSpecies.toLocaleString('zh-CN')}
          hint={`${stats().categoryCount} 个大类`}
          primary
          testId="gpas-stat-species"
        />
        <Kpi
          label="测序 Reads"
          value={props.brief.totalReads != null ? formatReads(props.brief.totalReads).replace(' Reads', '') : '—'}
          hint={props.brief.dataVolume != null ? `数据量 ${formatVolume(props.brief.dataVolume)}` : undefined}
        />
        <Kpi
          label="最高风险"
          value={stats().maxHazard > 0 ? hazard().label : '—'}
          hint={stats().maxHazard > 0
            ? <span style={{ color: hazard().ink }}>{'★'.repeat(Math.min(5, stats().maxHazard))}</span>
            : '未检出风险物种'}
        />
      </div>

      <div class="flex flex-wrap gap-2.5">
        <div class="flex min-w-0 flex-[1_1_220px] items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-100">
          <Donut slices={stats().slices} />
          <ul class="min-w-0 flex-1 space-y-1 text-xs" data-testid="gpas-stat-legend">
            <For each={stats().slices}>
              {(slice) => (
                <li class="flex items-center gap-1.5">
                  <span class="h-2 w-2 shrink-0 rounded-full" style={{ 'background-color': slice.color }} />
                  <span class="min-w-0 flex-1 truncate text-slate-600">{slice.name}</span>
                  <span class="shrink-0 tabular-nums text-slate-400">{slice.count}</span>
                  <span class="w-11 shrink-0 text-right font-semibold tabular-nums text-slate-700">{formatPercent(slice.sharePct)}</span>
                </li>
              )}
            </For>
          </ul>
        </div>

        <Show when={stats().topSpecies.length > 0}>
          <div class="min-w-0 flex-[1_1_200px] rounded-2xl bg-white p-3 ring-1 ring-slate-100">
            <p class="mb-2 text-[11px] font-medium text-slate-400">丰度 Top 物种 · 类别内相对丰度</p>
            <ul class="flex gap-3">
              <For each={stats().topSpecies}>
                {(item) => (
                  <li class="flex min-w-0 flex-1 flex-col items-center text-center" title={`${item.cnName}${item.enName ? `（${item.enName}）` : ''}`}>
                    <span class="grid h-12 w-12 place-items-center rounded-full p-[2.5px]" style={{ 'background-image': RING }}>
                      <span class="grid h-full w-full place-items-center rounded-full border-2 border-white bg-teal-50 text-sm font-bold text-teal-700">
                        {Array.from(item.cnName)[0] ?? '?'}
                      </span>
                    </span>
                    <span class="mt-1 w-full truncate text-[11px] font-medium text-slate-700">{item.cnName}</span>
                    <span class="text-[10px] tabular-nums text-slate-400">{item.category} · {formatPercent(item.abundancePct)}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
    </section>
  )
}
