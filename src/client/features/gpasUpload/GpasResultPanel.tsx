import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { FILE_RESULT_PAGE_SIZE, type FileResultPage, type FileResultRow } from '../../../server/gpasContracts'
import { fetchGpasFileResults } from '../chatbot/chatApi'
import type { GpasResultSelection } from '../artifacts/artifactStore'
import { BriefStats } from './BriefStats'
import { EvidenceRadarDialog, MiniRadar } from './EvidenceRadar'
import { HazardStars } from './HazardStars'
import { coveragePct } from './resultHelpers'

const ALL = ''
const SKELETON_ROWS = 8
/** Below this width the 生物学编号 column folds under the species name. */
const NARROW_WIDTH = 460
const COLUMNS = ['序号', '生物学编号', '物种名称', '定植特性', '风险程度分级', '覆盖度', '可信度雷达']

function SkeletonRows(props: { narrow: boolean }) {
  return (
    <tbody aria-hidden="true" data-testid="gpas-result-skeleton">
      <For each={Array.from({ length: SKELETON_ROWS })}>
        {() => (
          <tr class="border-b border-slate-100">
            <td class="px-2 py-3"><span class="gpas-skeleton mx-auto block h-3 w-4" /></td>
            <Show when={!props.narrow}><td class="px-2 py-3"><span class="gpas-skeleton block h-3 w-12" /></td></Show>
            <td class="px-2 py-3">
              <span class="gpas-skeleton block h-3.5 w-24" />
              <span class="gpas-skeleton mt-1.5 block h-3 w-32" />
            </td>
            <td class="px-2 py-3"><span class="gpas-skeleton block h-4 w-10 rounded-full" /></td>
            <td class="px-2 py-3"><span class="gpas-skeleton block h-5 w-12 rounded-full" /></td>
            <td class="px-2 py-3"><span class="gpas-skeleton ml-auto block h-3 w-10" /><span class="gpas-skeleton ml-auto mt-1.5 block h-1 w-14" /></td>
            <td class="px-2 py-2"><span class="gpas-skeleton mx-auto block h-10 w-10 rounded-xl" /></td>
          </tr>
        )}
      </For>
    </tbody>
  )
}


function ResultRow(props: { row: FileResultRow; index: number; narrow: boolean; categoryName: (type: string) => string; onRadar: () => void }) {
  const pct = () => coveragePct(props.row.coverage)
  return (
    <tr class="border-b border-slate-100 transition-colors odd:bg-white even:bg-slate-50/40 hover:bg-teal-50/40" data-testid="gpas-result-row">
      <td class="px-2 py-2.5 text-center text-xs font-medium tabular-nums text-slate-400" data-testid="gpas-result-index">{props.index}</td>
      <Show when={!props.narrow}>
        <td class="px-2 py-2.5 font-mono text-[11px] text-slate-500">{props.row.taxId || '—'}</td>
      </Show>
      <td class="min-w-0 max-w-0 px-2 py-2.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="h-2 w-2 shrink-0 rounded-full" style={{ 'background-color': props.row.color ?? '#cbd5e1' }} aria-hidden="true" />
          <span class="truncate text-[13px] font-semibold text-slate-800" title={props.row.taxCname}>{props.row.taxCname || '—'}</span>
        </div>
        <Show when={props.row.taxEname && props.row.taxEname !== props.row.taxCname}>
          <p class="truncate pl-3.5 text-[11px] italic text-slate-400" title={props.row.taxEname}>{props.row.taxEname}</p>
        </Show>
        <p class="truncate pl-3.5 text-[10px] text-slate-400">
          {props.categoryName(props.row.speciesType)}
          <Show when={props.narrow && props.row.taxId}> · <span class="font-mono">{props.row.taxId}</span></Show>
        </p>
      </td>
      <td class="px-2 py-2.5">
        <Show when={props.row.colonization} fallback={<span class="text-slate-300">—</span>}>
          <span class="inline-block max-w-full truncate rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 ring-1 ring-teal-100" title={props.row.colonizationE || props.row.colonization}>
            {props.row.colonization}
          </span>
        </Show>
      </td>
      <td class="px-2 py-2.5 text-center"><HazardStars level={props.row.hazardIndex} /></td>
      <td class="px-2 py-2.5 text-right">
        <span class="inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700">
          {props.row.coverage || '—'}
          <Show when={props.row.coverageUrl}>
            {(url) => (
              <a class="text-slate-400 hover:text-teal-700" href={url()} target="_blank" rel="noopener noreferrer" aria-label="覆盖度图" title="覆盖度图">
                <span aria-hidden="true" class="i-lucide-external-link h-3 w-3" />
              </a>
            )}
          </Show>
        </span>
        <Show when={pct() !== null}>
          <span class="ml-auto mt-1 block h-1 w-14 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span class="block h-full rounded-full" style={{ width: `${pct()}%`, 'background-image': 'linear-gradient(90deg, #6a9ea2, #2c7378)' }} />
          </span>
        </Show>
      </td>
      <td class="px-1.5 py-1.5 text-center">
        <button
          type="button"
          class="rounded-xl p-0.5 transition hover:bg-white hover:shadow-md hover:ring-1 hover:ring-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          aria-label={`查看 ${props.row.taxCname} 证据雷达`}
          onClick={props.onRadar}
          data-testid="gpas-mini-radar"
        >
          <MiniRadar row={props.row} />
        </button>
      </td>
    </tr>
  )
}

type PanelSession = {
  tab: string
  pages: Record<string, number>
  cache: Record<string, FileResultPage>
  meta: Record<string, { total: number; totalPage: number }>
}
/** Samples whose loaded pages survive closing and reopening the panel. */
const MAX_SESSIONS = 10
const sessions = new Map<string, PanelSession>()

/** The kept state of one sample's panel; least recently opened samples are dropped. */
export function panelSession(taskId: string): PanelSession {
  const kept = sessions.get(taskId) ?? { tab: ALL, pages: {}, cache: {}, meta: {} }
  sessions.delete(taskId)
  sessions.set(taskId, kept)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  return kept
}

/**
 * A sample's analysis detail: one tab per detected category plus "全部".
 * Each tab and page is requested only when shown, and cached for the session,
 * so reopening the same sample shows its last tab and page without a request.
 */
export function GpasResultPanel(props: { selection: GpasResultSelection }) {
  const session = panelSession(props.selection.taskId)
  const tabs = createMemo(() => [{ type: ALL, name: '全部' }, ...props.selection.categories])
  const categoryName = (type: string) => props.selection.categories.find((item) => item.type === type)?.name ?? type
  const [tab, selectTab] = createSignal(session.tab)
  const setTab = (next: string) => {
    session.tab = next
    selectTab(next)
  }
  // Stores write through to the kept session objects.
  const [pages, setPages] = createStore(session.pages)
  const [cache, setCache] = createStore(session.cache)
  // Latest totals per tab: tab badges and the pager while a page loads.
  const [meta, setMeta] = createStore(session.meta)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  const [radar, setRadar] = createSignal<{ row: FileResultRow; index: number }>()
  const [narrow, setNarrow] = createSignal(false)
  let controller: AbortController | undefined
  let root: HTMLDivElement | undefined
  onMount(() => {
    if (!root || typeof ResizeObserver === 'undefined') return
    let frame = 0
    // Deferred so the column change never re-enters the observer loop.
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setNarrow(entry.contentRect.width < NARROW_WIDTH))
    })
    observer.observe(root)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    })
  })

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
    <div ref={root} class="flex min-h-full flex-col bg-slate-50" data-testid="gpas-result-panel">
      <Show when={props.selection.brief}>{(brief) => <BriefStats brief={brief()} />}</Show>
      <div class="sticky top-0 z-20 h-12 border-b border-slate-100 bg-slate-50/95 px-3 pt-2 backdrop-blur">
        <div class="gpas-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2" role="tablist" aria-label="物种大类">
          <For each={tabs()}>
            {(item) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab() === item.type}
                class={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${tab() === item.type ? 'bg-teal-700 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900'}`}
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

      <div class="min-h-0 flex-1 px-3 pt-2" role="tabpanel" aria-busy={loading()}>
        <Show
          when={!error()}
          fallback={
            <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <p class="text-sm text-slate-500">{error()}</p>
              <button type="button" class="rounded-full bg-white px-4 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => setRetry((value) => value + 1)}>
                重试
              </button>
            </div>
          }
        >
          {/* Phones scroll the table sideways instead of crushing the name column. */}
          <div class={`rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-100 ${narrow() ? 'gpas-scrollbar overflow-x-auto' : ''}`}>
            <table class={`w-full table-fixed border-collapse text-left ${narrow() ? 'min-w-[420px]' : ''}`} data-testid="gpas-result-table">
              {/* Shares of the table width, so the name column no longer takes all the slack. */}
              <colgroup>
                <Show
                  when={!narrow()}
                  fallback={
                    <>
                      <col class="w-[8%]" />
                      <col class="w-[30%]" />
                      <col class="w-[15%]" />
                      <col class="w-[16%]" />
                      <col class="w-[16%]" />
                      <col class="w-[15%]" />
                    </>
                  }
                >
                  <col class="w-[6%]" />
                  <col class="w-[13%]" />
                  <col class="w-[25%]" />
                  <col class="w-[14%]" />
                  <col class="w-[15%]" />
                  <col class="w-[14%]" />
                  <col class="w-[13%]" />
                </Show>
              </colgroup>
              <thead>
                <tr class="border-b border-slate-100 text-[11px] font-semibold text-slate-400">
                  <For each={COLUMNS.filter((name) => !narrow() || name !== '生物学编号')}>
                    {(name) => (
                      <th
                        scope="col"
                        class={`${narrow() ? '' : 'sticky top-12 z-10 backdrop-blur'} whitespace-nowrap bg-white/95 px-2 py-2.5 ${name === '覆盖度' ? 'text-right' : name === '序号' || name === '风险程度分级' || name === '可信度雷达' ? 'text-center' : ''}`}
                      >
                        {name === '风险程度分级' ? '风险分级' : name === '可信度雷达' ? '可信度' : name}
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <Show when={!loading() || current()} fallback={<SkeletonRows narrow={narrow()} />}>
                <Show when={current()} keyed>
                  {(result) => (
                    <Show
                      when={result.rows.length > 0}
                      fallback={<tbody><tr><td colSpan={narrow() ? 6 : 7} class="px-6 py-12 text-center text-sm text-slate-500">该类别暂无分析结果</td></tr></tbody>}
                    >
                      <tbody class="gpas-fade-in">
                        <For each={result.rows}>
                          {(row, index) => {
                            const number = () => (result.page - 1) * result.pageSize + index() + 1
                            return (
                              <ResultRow
                                row={row}
                                index={number()}
                                narrow={narrow()}
                                categoryName={categoryName}
                                onRadar={() => setRadar({ row, index: number() })}
                              />
                            )
                          }}
                        </For>
                      </tbody>
                    </Show>
                  )}
                </Show>
              </Show>
            </table>
          </div>
        </Show>
      </div>

      <Show when={radar()} keyed>
        {(item) => <EvidenceRadarDialog row={item.row} index={item.index} onClose={() => setRadar(undefined)} />}
      </Show>

      <Show when={totalPage() > 0}>
        <div class="sticky bottom-0 mt-2 flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/95 px-4 py-2.5 text-xs text-slate-500 backdrop-blur">
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
