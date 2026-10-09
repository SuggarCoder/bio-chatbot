import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { ProgressCard } from '../../../server/gpasContracts'
import { PROGRESS_COLORS, progressSeries, progressTotals, shortMonth, type ProgressSeries } from './progressChart'

const HEIGHT = 200
const PAD = { top: 14, right: 92, bottom: 26, left: 40 }
const LABEL_GAP = 14

const percent = (value: number) => `${Number(value.toFixed(1))}%`
const number = (value: number) => value.toLocaleString('zh-CN')
const shortLabel = (label: string) => label.replace(/样本$/, '')

/** Spreads end labels so none overlap; keeps them in plot order. */
function spreadLabels(items: Array<{ key: string; y: number }>, top: number, bottom: number) {
  const sorted = [...items].sort((a, b) => a.y - b.y)
  for (let index = 1; index < sorted.length; index += 1) {
    sorted[index].y = Math.max(sorted[index].y, sorted[index - 1].y + LABEL_GAP)
  }
  const overflow = (sorted.at(-1)?.y ?? 0) - bottom
  if (overflow > 0) for (const item of sorted) item.y = Math.max(top, item.y - overflow)
  return new Map(sorted.map((item) => [item.key, item.y]))
}

function ProgressChart(props: { progress: ProgressCard }) {
  const data = createMemo(() => progressSeries(props.progress))
  const [width, setWidth] = createSignal(560)
  const [hover, setHover] = createSignal<number>()
  let container: HTMLDivElement | undefined
  onMount(() => {
    if (!container) return
    setWidth(container.clientWidth || 560)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 560))
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })

  const plotWidth = () => Math.max(120, width() - PAD.left - PAD.right)
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const x = (index: number) => PAD.left + (data().months.length <= 1 ? 0 : (index / (data().months.length - 1)) * plotWidth())
  const y = (rate: number) => PAD.top + plotHeight - (Math.min(rate, data().maxRate) / data().maxRate) * plotHeight
  const ticks = () => [0, 50, 100, ...(data().maxRate > 100 ? [data().maxRate] : [])]
  // Thin month labels so they never collide.
  const monthStep = () => Math.max(1, Math.ceil(data().months.length / Math.max(2, Math.floor(plotWidth() / 52))))
  const endLabels = () => spreadLabels(
    data().series.map((item) => ({ key: item.type, y: y(item.points.at(-1)!.rate) })),
    PAD.top + 4, PAD.top + plotHeight,
  )
  const path = (item: ProgressSeries) => item.points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.rate).toFixed(1)}`).join(' ')

  const pick = (clientX: number, rect: DOMRect) => {
    const months = data().months.length
    if (months < 1) return
    const ratio = (clientX - rect.left - PAD.left) / plotWidth()
    setHover(Math.min(months - 1, Math.max(0, Math.round(ratio * (months - 1)))))
  }
  const onKey = (event: KeyboardEvent) => {
    const last = data().months.length - 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const current = hover() ?? last
      setHover(Math.min(last, Math.max(0, current + (event.key === 'ArrowLeft' ? -1 : 1))))
    } else if (event.key === 'Escape') {
      setHover(undefined)
    }
  }
  const tooltipLeft = () => {
    const index = hover()
    if (index === undefined) return 0
    return Math.min(Math.max(x(index) - 80, 4), width() - 168)
  }

  return (
    <Show
      when={data().months.length >= 2 && data().series.length > 0}
      fallback={<p class="px-1 py-6 text-center text-xs text-slate-400" data-testid="gpas-progress-chart-empty">暂无按月数据</p>}
    >
      <div ref={container} class="relative" data-testid="gpas-progress-chart">
        <svg
          width={width()}
          height={HEIGHT}
          viewBox={`0 0 ${width()} ${HEIGHT}`}
          class="block overflow-visible outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-teal-500"
          role="img"
          aria-label={`累计完成率：${data().series.map((item) => `${item.label} ${percent(item.points.at(-1)!.rate)}`).join('，')}`}
          tabIndex={0}
          onPointerMove={(event) => pick(event.clientX, event.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHover(undefined)}
          onKeyDown={onKey}
          onBlur={() => setHover(undefined)}
        >
          {/* Recessive grid and the 100% target. */}
          <For each={ticks()}>
            {(tick) => (
              <g>
                <line
                  x1={PAD.left} x2={PAD.left + plotWidth()} y1={y(tick)} y2={y(tick)}
                  stroke={tick === 100 ? '#94a3b8' : '#eef2f4'} stroke-width="1" stroke-dasharray={tick === 100 ? '4 4' : undefined}
                />
                <text x={PAD.left - 8} y={y(tick) + 3.5} text-anchor="end" font-size="10" fill="#94a3b8">{tick}%</text>
              </g>
            )}
          </For>
          <text x={PAD.left + 4} y={y(100) - 5} font-size="10" fill="#64748b">目标 100%</text>
          <For each={data().months}>
            {(month, index) => (
              <Show when={index() % monthStep() === 0 || index() === data().months.length - 1}>
                <text x={x(index())} y={HEIGHT - 8} text-anchor="middle" font-size="10" fill="#94a3b8">{shortMonth(month)}</text>
              </Show>
            )}
          </For>

          <Show when={hover() !== undefined}>
            <line x1={x(hover()!)} x2={x(hover()!)} y1={PAD.top} y2={PAD.top + plotHeight} stroke="#cbd5e1" stroke-width="1" />
          </Show>

          <For each={data().series}>
            {(item) => (
              <g data-testid="gpas-progress-line">
                <path d={path(item)} fill="none" stroke={item.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                <circle cx={x(item.points.length - 1)} cy={y(item.points.at(-1)!.rate)} r="4" fill={item.color} stroke="#fff" stroke-width="2" />
                <Show when={hover() !== undefined}>
                  <circle cx={x(hover()!)} cy={y(item.points[hover()!].rate)} r="4" fill="#fff" stroke={item.color} stroke-width="2" />
                </Show>
                <text
                  x={PAD.left + plotWidth() + 10}
                  y={(endLabels().get(item.type) ?? 0) + 3.5}
                  font-size="11"
                  fill="#334155"
                  data-testid="gpas-progress-end-label"
                >
                  <tspan fill={item.color}>●</tspan> {shortLabel(item.label)} {percent(item.points.at(-1)!.rate)}
                </text>
              </g>
            )}
          </For>
        </svg>

        <Show when={hover() !== undefined}>
          <div
            class="pointer-events-none absolute top-1 z-10 w-40 rounded-xl bg-white/95 px-3 py-2 text-[11px] shadow-lg ring-1 ring-slate-200 backdrop-blur"
            style={{ left: `${tooltipLeft()}px` }}
            role="status"
            data-testid="gpas-progress-tooltip"
          >
            <p class="mb-1 font-semibold text-slate-700">{data().months[hover()!]}</p>
            <For each={data().series}>
              {(item) => (
                <p class="flex items-center gap-1.5 text-slate-600">
                  <span class="h-2 w-2 shrink-0 rounded-full" style={{ 'background-color': item.color }} />
                  <span class="flex-1">{shortLabel(item.label)}</span>
                  <span class="tabular-nums text-slate-400">{number(item.points[hover()!].cumulative)}</span>
                  <span class="w-11 text-right font-semibold tabular-nums text-slate-800">{percent(item.points[hover()!].rate)}</span>
                </p>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

/** Project progress under a project.progress reply: totals, monthly chart and table. */
export function ProjectProgressCard(props: { progress: ProgressCard }) {
  const totals = () => progressTotals(props.progress)
  return (
    <article class="my-2 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200" data-testid="gpas-progress-card">
      <header class="flex flex-wrap items-end justify-between gap-4 bg-slate-50 px-5 py-4">
        <div class="min-w-0">
          <p class="text-[11px] font-medium uppercase tracking-[0.12em] text-teal-700/80">Project progress</p>
          <h3 class="mt-0.5 truncate text-base font-semibold text-slate-900" title={props.progress.projectName}>{props.progress.projectName || '项目进度'}</h3>
          <p class="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
            <Show when={props.progress.teamName}>{(team) => <span>{team()}</span>}</Show>
            <Show when={props.progress.demo}><span class="rounded-full bg-amber-50 px-2 py-px text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">本地演示数据</span></Show>
          </p>
        </div>
        <div class="w-44 text-right">
          <p class="text-[11px] text-slate-400">总体完成率</p>
          <p class="text-2xl font-bold tabular-nums leading-7 text-teal-700" data-testid="gpas-progress-total">
            {totals().rate === null ? '—' : percent(totals().rate!)}
          </p>
          <span class="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
            <span class="block h-full rounded-full" style={{ width: `${Math.min(100, totals().rate ?? 0)}%`, 'background-image': 'linear-gradient(90deg, #4f9095, #2c7378)' }} />
          </span>
          <p class="mt-1 text-[11px] tabular-nums text-slate-400">{number(totals().submitted)} / {number(totals().plan)} 份</p>
        </div>
      </header>

      <section class="px-4 pb-2 pt-4" aria-label="累计完成率走势">
        <p class="mb-2 px-1 text-xs font-semibold text-slate-700">累计完成率走势 <span class="font-normal text-slate-400">· 按月累计提交 ÷ 计划数量</span></p>
        <ProgressChart progress={props.progress} />
      </section>

      <div class="gpas-scrollbar overflow-x-auto px-4 pb-4">
        <table class="w-full min-w-[460px] border-collapse text-left text-sm" data-testid="gpas-progress-table">
          <thead>
            <tr class="border-b border-slate-100 text-[11px] font-semibold text-slate-400">
              <th scope="col" class="py-2 pl-1 font-semibold">样本类型</th>
              <th scope="col" class="py-2 text-right font-semibold">计划</th>
              <th scope="col" class="py-2 text-right font-semibold">已提交</th>
              <th scope="col" class="py-2 text-right font-semibold">剩余</th>
              <th scope="col" class="w-[38%] py-2 pl-4 font-semibold">完成率</th>
            </tr>
          </thead>
          <tbody class="tabular-nums">
            <For each={props.progress.samples}>
              {(sample) => (
                <tr class="border-b border-slate-50 transition-colors hover:bg-teal-50/30" data-testid="gpas-progress-row">
                  <td class="py-2.5 pl-1">
                    <span class="inline-flex items-center gap-2 font-medium text-slate-700">
                      <span class="h-2 w-2 rounded-full" style={{ 'background-color': PROGRESS_COLORS[sample.type] }} aria-hidden="true" />
                      {sample.label}
                    </span>
                  </td>
                  <td class="py-2.5 text-right text-slate-600">{number(sample.plan)}</td>
                  <td class="py-2.5 text-right font-semibold text-slate-800">{number(sample.submitted)}</td>
                  <td class="py-2.5 text-right text-slate-600">{number(sample.remaining)}</td>
                  <td class="py-2.5 pl-4">
                    <Show when={sample.completionRate !== null} fallback={<span class="text-xs text-slate-400">未设置计划</span>}>
                      <div class="flex items-center gap-2">
                        <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                          <span class="block h-full rounded-full bg-teal-600" style={{ width: `${Math.min(100, sample.completionRate!)}%` }} />
                        </span>
                        <span class="w-12 text-right text-xs font-semibold text-slate-700">{percent(sample.completionRate!)}</span>
                        <Show when={sample.completionRate! >= 100}>
                          <span class="rounded-full bg-teal-50 px-1.5 py-px text-[10px] font-medium text-teal-700 ring-1 ring-teal-100">已完成</span>
                        </Show>
                      </div>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
          <tfoot>
            <tr class="text-slate-800" data-testid="gpas-progress-totals">
              <th scope="row" class="py-2.5 pl-1 text-left font-semibold">合计</th>
              <td class="py-2.5 text-right font-semibold tabular-nums">{number(totals().plan)}</td>
              <td class="py-2.5 text-right font-semibold tabular-nums">{number(totals().submitted)}</td>
              <td class="py-2.5 text-right font-semibold tabular-nums">{number(totals().remaining)}</td>
              <td class="py-2.5 pl-4 text-xs font-semibold tabular-nums text-teal-700">{totals().rate === null ? '—' : percent(totals().rate!)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </article>
  )
}
