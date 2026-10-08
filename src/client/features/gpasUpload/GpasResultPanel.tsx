import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { FILE_RESULT_PAGE_SIZE, type FileResultPage, type FileResultRow } from '../../../server/gpasContracts'
import { fetchGpasFileResults } from '../chatbot/chatApi'
import type { GpasResultSelection } from '../artifacts/artifactStore'
import { coveragePct } from './resultHelpers'

const ALL = ''
const SKELETON_ROWS = 8

function SkeletonRows() {
  return (
    <ul class="divide-y divide-slate-100" aria-hidden="true" data-testid="gpas-result-skeleton">
      <For each={Array.from({ length: SKELETON_ROWS })}>
        {() => (
          <li class="flex items-center gap-3 px-4 py-3">
            <span class="gpas-skeleton h-2.5 w-2.5 shrink-0 rounded-full" />
            <span class="min-w-0 flex-1 space-y-1.5">
              <span class="gpas-skeleton block h-3.5 w-2/5" />
              <span class="gpas-skeleton block h-3 w-3/5" />
            </span>
            <span class="gpas-skeleton h-3 w-16 shrink-0" />
          </li>
        )}
      </For>
    </ul>
  )
}

function ResultRow(props: { row: FileResultRow; categoryName: (type: string) => string }) {
  const pct = () => coveragePct(props.row.coverage)
  return (
    <li class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50/80" data-testid="gpas-result-row">
      <span
        class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white"
        style={{ 'background-color': props.row.color ?? '#94a3b8' }}
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-baseline gap-2">
          <span class="truncate text-sm font-semibold text-slate-800" title={props.row.taxCname}>{props.row.taxCname || '—'}</span>
          <Show when={props.row.colonization}>
            <span class="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 ring-1 ring-amber-200/70" title={props.row.colonizationE || undefined}>
              {props.row.colonization}
            </span>
          </Show>
        </div>
        <Show when={props.row.taxEname && props.row.taxEname !== props.row.taxCname}>
          <p class="truncate text-xs italic text-slate-500" title={props.row.taxEname}>{props.row.taxEname}</p>
        </Show>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
          <Show when={props.row.speciesType}>
            <span class="rounded bg-slate-100 px-1.5 py-px font-medium text-slate-600">{props.categoryName(props.row.speciesType)}</span>
          </Show>
          <Show when={props.row.barcodeId}>
            <span>Barcode {props.row.barcodeId}</span>
          </Show>
          <Show when={props.row.coverageUrl}>
            {(url) => (
              <a class="inline-flex items-center gap-0.5 text-teal-700 hover:underline" href={url()} target="_blank" rel="noopener noreferrer">
                <span aria-hidden="true" class="i-lucide-chart-area h-3 w-3" />覆盖度图
              </a>
            )}
          </Show>
        </div>
      </div>
      <div class="w-20 shrink-0 text-right">
        <span class="text-xs font-semibold tabular-nums text-slate-700">{props.row.coverage || '—'}</span>
        <Show when={pct() !== null}>
          <span class="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span class="block h-full rounded-full bg-teal-500/80" style={{ width: `${pct()}%` }} />
          </span>
        </Show>
        <span class="mt-0.5 block text-[10px] text-slate-400">覆盖度</span>
      </div>
    </li>
  )
}

/**
 * A sample's analysis detail: one tab per detected category plus "全部".
 * Each tab and page is requested only when shown, and cached afterwards.
 */
export function GpasResultPanel(props: { selection: GpasResultSelection }) {
  const tabs = createMemo(() => [{ type: ALL, name: '全部' }, ...props.selection.categories])
  const categoryName = (type: string) => props.selection.categories.find((item) => item.type === type)?.name ?? type
  const [tab, setTab] = createSignal(ALL)
  const [pages, setPages] = createStore<Record<string, number>>({})
  const [cache, setCache] = createStore<Record<string, FileResultPage>>({})
  // Latest totals per tab: tab badges and the pager while a page loads.
  const [meta, setMeta] = createStore<Record<string, { total: number; totalPage: number }>>({})
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  let controller: AbortController | undefined

  const page = () => pages[tab()] ?? 1
  const key = () => `${tab()}|${page()}`
  const current = () => cache[key()] as FileResultPage | undefined
  const totalFor = (type: string) => meta[type]?.total

  createEffect(on([key, retry, () => props.selection.taskId], ([requestKey]) => {
    if (cache[requestKey]) return
    controller?.abort()
    const request = new AbortController()
    controller = request
    const [speciesType, pageNumber] = [tab(), page()]
    setLoading(true)
    setError('')
    fetchGpasFileResults({
      taskId: props.selection.taskId,
      speciesType: speciesType || undefined,
      page: pageNumber,
      pageSize: FILE_RESULT_PAGE_SIZE,
    }, request.signal)
      .then((result) => {
        setCache(requestKey, result)
        setMeta(speciesType, { total: result.total, totalPage: result.totalPage })
      })
      .catch((reason: unknown) => {
        if (request.signal.aborted) return
        setError(reason instanceof Error && reason.message ? reason.message : '分析详情加载失败')
      })
      .finally(() => {
        if (controller === request) setLoading(false)
      })
  }))
  onCleanup(() => controller?.abort())

  const go = (next: number) => setPages(tab(), Math.max(1, next))
  const totalPage = () => meta[tab()]?.totalPage ?? 0

  return (
    <div class="flex min-h-full flex-col bg-white" data-testid="gpas-result-panel">
      <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-3 pt-3 backdrop-blur">
        <div class="gpas-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2" role="tablist" aria-label="物种大类">
          <For each={tabs()}>
            {(item) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab() === item.type}
                class={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${tab() === item.type ? 'bg-teal-700 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-800'}`}
                onClick={() => setTab(item.type)}
              >
                {item.name}
                <Show when={totalFor(item.type) !== undefined}>
                  <span class={`tabular-nums ${tab() === item.type ? 'text-teal-100' : 'text-slate-400'}`}>{totalFor(item.type)}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="min-h-0 flex-1" role="tabpanel" aria-busy={loading()}>
        <Show
          when={!loading() || current()}
          fallback={<SkeletonRows />}
        >
          <Show
            when={!error()}
            fallback={
              <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <p class="text-sm text-slate-500">{error()}</p>
                <button type="button" class="rounded-full bg-slate-100 px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200" onClick={() => setRetry((value) => value + 1)}>
                  重试
                </button>
              </div>
            }
          >
            <Show when={current()} keyed>
              {(result) => (
                <Show
                  when={result.rows.length > 0}
                  fallback={<p class="px-6 py-12 text-center text-sm text-slate-500">该类别暂无分析结果</p>}
                >
                  <ul class="gpas-fade-in divide-y divide-slate-100">
                    <For each={result.rows}>{(row) => <ResultRow row={row} categoryName={categoryName} />}</For>
                  </ul>
                </Show>
              )}
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={totalPage() > 0}>
        <div class="sticky bottom-0 flex items-center justify-between gap-2 border-t border-slate-100 bg-white/95 px-4 py-2.5 text-xs text-slate-500 backdrop-blur">
          <span class="tabular-nums">共 {meta[tab()]?.total ?? 0} 条</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="grid h-7 w-7 place-items-center rounded-full text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="上一页"
              disabled={page() <= 1 || loading()}
              onClick={() => go(page() - 1)}
            >
              <span aria-hidden="true" class="i-lucide-chevron-left h-4 w-4" />
            </button>
            <span class="min-w-14 text-center tabular-nums" data-testid="gpas-result-page">{page()} / {totalPage()}</span>
            <button
              type="button"
              class="grid h-7 w-7 place-items-center rounded-full text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="下一页"
              disabled={page() >= totalPage() || loading()}
              onClick={() => go(page() + 1)}
            >
              <span aria-hidden="true" class="i-lucide-chevron-right h-4 w-4" />
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
