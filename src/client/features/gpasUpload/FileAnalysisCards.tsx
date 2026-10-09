import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { categorySharePct, sampleKeys, sampleLabel, type FileBrief, type FileCard, type SampleKey } from '../../../server/gpasContracts'
import { layoutTreemap } from './treemap'

/** Category blocks shown per card; more categories fold into "其他". */
export const MAX_CATEGORY_BLOCKS = 5

type Category = FileBrief['categories'][number]
type Tone = { block: string; label: string; tiles: Array<{ bg: string; fg: string }>; rest: { bg: string; fg: string } }

const tones: Record<string, Tone> = {
  bacteria: {
    block: '#b9ced2', label: '#28525a',
    tiles: [{ bg: '#2c7378', fg: '#fff' }, { bg: '#4f9095', fg: '#fff' }, { bg: '#5b8389', fg: '#fff' }, { bg: '#3d666b', fg: '#fff' }, { bg: '#6a9ea2', fg: '#fff' }],
    rest: { bg: '#dbe7e9', fg: '#28525a' },
  },
  viral: {
    block: '#d5d7d8', label: '#3f4b4d',
    tiles: [{ bg: '#7d9293', fg: '#fff' }, { bg: '#93a9ab', fg: '#fff' }, { bg: '#6f8586', fg: '#fff' }, { bg: '#5f7374', fg: '#fff' }, { bg: '#889c9d', fg: '#fff' }],
    rest: { bg: '#e8eaea', fg: '#3f4b4d' },
  },
  fungi: {
    block: '#ece6df', label: '#5b4e3f',
    tiles: [{ bg: '#8c7a63', fg: '#fff' }, { bg: '#a3927b', fg: '#fff' }, { bg: '#7a6b57', fg: '#fff' }, { bg: '#685b4a', fg: '#fff' }, { bg: '#978670', fg: '#fff' }],
    rest: { bg: '#f6f2ed', fg: '#5b4e3f' },
  },
}
// Unknown categories (archaea, animals, …) cycle through these.
const fallbackTones: Tone[] = [
  {
    block: '#d3d8e6', label: '#34405e',
    tiles: [{ bg: '#55658f', fg: '#fff' }, { bg: '#6d7da6', fg: '#fff' }, { bg: '#4a597f', fg: '#fff' }, { bg: '#3f4c6e', fg: '#fff' }, { bg: '#61719a', fg: '#fff' }],
    rest: { bg: '#e9ecf3', fg: '#34405e' },
  },
  {
    block: '#e3d6dc', label: '#5a3446',
    tiles: [{ bg: '#8d5a70', fg: '#fff' }, { bg: '#a3707f', fg: '#fff' }, { bg: '#7b4d61', fg: '#fff' }, { bg: '#694153', fg: '#fff' }, { bg: '#986577', fg: '#fff' }],
    rest: { bg: '#f2eaee', fg: '#5a3446' },
  },
]
const otherTone = { block: '#e2e4e6', label: '#475155' }

export const toneFor = (type: string, index: number): Tone => tones[type] ?? fallbackTones[index % fallbackTones.length]

const formatSize = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}
export const formatReads = (reads: number) => reads >= 1e6 ? `${(reads / 1e6).toFixed(2)}M Reads` : `${reads.toLocaleString('zh-CN')} Reads`
export const formatVolume = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} G` : value >= 1e6 ? `${(value / 1e6).toFixed(2)} M` : String(value)
export const formatPercent = (value: number) => `${Number(value.toFixed(1))}%`
const formatTime = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1].slice(2)}/${match[2]}/${match[3]} ${match[4]}:${match[5]}` : value
}
const sampleText = (value: string | null) =>
  value && (sampleKeys as readonly string[]).includes(value) ? sampleLabel(value as SampleKey) : value

/** Splits detected categories into shown blocks and those folded into "其他". */
export function groupCategories(categories: readonly Category[]) {
  const detected = categories.filter((category) => category.speciesCount > 0)
  const missing = categories.filter((category) => category.speciesCount === 0)
  if (detected.length <= MAX_CATEGORY_BLOCKS) return { shown: detected, folded: [] as Category[], missing }
  const ranked = [...detected].sort((a, b) => b.speciesCount - a.speciesCount)
  return { shown: ranked.slice(0, MAX_CATEGORY_BLOCKS - 1), folded: ranked.slice(MAX_CATEGORY_BLOCKS - 1), missing }
}

function Stars(props: { count: number; color?: string }) {
  return (
    <Show when={props.count > 0}>
      <span class="inline-flex shrink-0 gap-0.5" role="img" aria-label={`危害等级 ${props.count}`} style={{ color: props.color ?? '#f08a24' }}>
        <span aria-hidden="true" class="text-[11px] leading-none tracking-tight">{'★'.repeat(Math.min(props.count, 5))}</span>
      </span>
    </Show>
  )
}

const TREEMAP_HEIGHT = 160
// Narrow blocks stack rows, which need a little more height.
const treemapHeight = (width: number) => width < 200 ? 200 : TREEMAP_HEIGHT

function CategoryBlock(props: { category: Category; index: number; sharePct: number }) {
  const tone = () => toneFor(props.category.type, props.index)
  // Real container width decides the split direction and how much text fits.
  const [width, setWidth] = createSignal(320)
  let container: HTMLDivElement | undefined
  onMount(() => {
    if (!container) return
    setWidth(container.clientWidth || 320)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 320))
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })
  const topSum = () => props.category.top.reduce((sum, item) => sum + item.abundancePct, 0)
  const restCount = () => props.category.speciesCount - props.category.top.length
  const restPct = () => Math.max(0, 100 - topSum())
  const showRest = () => restCount() > 0 && restPct() > 0.5
  const rects = () => layoutTreemap([
    ...props.category.top.map((item, index) => ({ key: `t${index}`, value: item.abundancePct })),
    ...(showRest() ? [{ key: 'rest', value: restPct() }] : []),
  ], width() / treemapHeight(width()))

  return (
    <section
      class="flex min-w-0 flex-[1_1_240px] flex-col rounded-xl p-2"
      style={{ 'background-color': tone().block, color: tone().label }}
      data-testid="gpas-brief-category"
    >
      <header class="mb-1.5 flex items-center justify-between gap-2 px-1 text-xs">
        <span class="min-w-0 truncate font-semibold" title="种数占比：该类别检出种数 / 全部检出种数">
          {props.category.name} · 检出 {props.category.speciesCount} 种 · 占比 {formatPercent(props.sharePct)}
        </span>
        <Show when={props.category.top.length > 0}>
          <span class="shrink-0 opacity-80">丰度前 {props.category.top.length}</span>
        </Show>
      </header>
      <Show
        when={rects().length > 0}
        fallback={<p class="px-1 pb-1 text-xs opacity-80">摘要未包含该类别的物种明细</p>}
      >
        <div ref={container} class="relative w-full" style={{ height: `${treemapHeight(width())}px` }}>
          <For each={rects()}>
            {(rect) => {
              const isRest = rect.key === 'rest'
              const item = isRest ? undefined : props.category.top[Number(rect.key.slice(1))]
              const colors = isRest ? tone().rest : tone().tiles[Number(rect.key.slice(1)) % tone().tiles.length]
              // full: name, stars, value; line: one row; dot: value only (details in the title).
              const fit = () => {
                const w = (rect.width / 100) * width()
                const h = (rect.height / 100) * treemapHeight(width())
                return w >= 64 && h >= 60 ? 'full' : w >= 44 && h >= 20 ? 'line' : 'dot'
              }
              return (
                <div
                  class="absolute p-0.5"
                  style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
                >
                  <div
                    class={`flex h-full w-full overflow-hidden rounded-lg text-[11px] leading-4 ${fit() === 'full' ? 'flex-col gap-0.5 px-2 py-1.5' : fit() === 'line' ? 'items-center justify-between gap-1 px-1.5' : 'items-center justify-center px-0.5'}`}
                    style={{ 'background-color': colors.bg, color: colors.fg }}
                    title={item
                      ? `${item.cnName}${item.enName ? `（${item.enName}）` : ''} · 类别内相对丰度 ${formatPercent(item.abundancePct)}${item.taxId ? ` · taxId ${item.taxId}` : ''}${item.hazard ? ` · 危害等级 ${item.hazard}` : ''}`
                      : `其它 ${restCount()} 种，合计约 ${formatPercent(restPct())}`}
                    data-testid={isRest ? 'gpas-brief-rest' : 'gpas-brief-species'}
                  >
                    <Show when={fit() !== 'dot'} fallback={<span class="sr-only">{item ? item.cnName : `其它 ${restCount()} 种`}</span>}>
                      <span class={`min-w-0 font-semibold ${fit() === 'full' ? 'line-clamp-2' : 'truncate'}`}>
                        {item ? item.cnName : `其它 ${restCount()} 种`}
                      </span>
                    </Show>
                    <Show when={fit() === 'full' && item}>
                      <Stars count={item!.hazard} />
                    </Show>
                    <Show when={fit() !== 'dot' || rect.width * width() / 100 >= 28}>
                      <span class={`shrink-0 ${isRest ? 'opacity-80' : 'opacity-90'}`}>{formatPercent(item ? item.abundancePct : restPct())}</span>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

function FoldedBlock(props: { categories: Category[]; share: (category: Category) => number }) {
  const sharePct = () => Math.round(props.categories.reduce((sum, category) => sum + props.share(category), 0) * 10) / 10
  return (
    <section
      class="flex min-w-0 flex-[1_1_160px] flex-col rounded-xl p-2"
      style={{ 'background-color': otherTone.block, color: otherTone.label }}
      data-testid="gpas-brief-category"
    >
      <header class="mb-1.5 px-1 text-xs font-semibold">其他 · {props.categories.length} 类 · 占比 {formatPercent(sharePct())}</header>
      <ul class="space-y-1 px-1 text-xs">
        <For each={props.categories}>
          {(category) => <li class="truncate">{category.name} · 检出 {category.speciesCount} 种 · {formatPercent(props.share(category))}</li>}
        </For>
      </ul>
    </section>
  )
}

type DetailProps = { onViewDetail?: (taskId: string) => void; detailDisabled?: boolean; hasDetail?: (taskId: string) => boolean }

function AnalysisCard(props: { card: FileCard } & DetailProps) {
  const size = () => {
    const sizes = props.card.files.map((file) => file.sizeBytes)
    return sizes.every((value) => value !== null) ? sizes.reduce((sum, value) => sum! + value!, 0)! : null
  }
  const groups = () => props.card.brief ? groupCategories(props.card.brief.categories) : null
  const share = (category: Category) => categorySharePct(category.speciesCount, props.card.brief?.categories ?? [])

  return (
    <article class="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200" data-testid="gpas-file-card">
      <header class="flex items-start gap-3 bg-slate-50 px-4 py-3">
        <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-teal-700">病原体分类分布</h3>
        <p class="mt-0.5 text-[11px] text-slate-500">
          <Show when={props.card.brief} fallback="暂无分析摘要">
            {(brief) => (
              <>
                分析摘要 · 每类展示类别内相对丰度前 5 位物种及其它 · 类别占比按检出种数计算 · ★ 为危害等级
                <Show when={brief().tools.length}> · {brief().tools.join('、')}</Show>
              </>
            )}
          </Show>
        </p>
        </div>
        <Show when={props.card.analysisId && props.onViewDetail}>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-teal-700 ring-1 ring-teal-200 transition hover:bg-teal-50 hover:ring-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
            // A loaded detail opens without a new request, even while a reply runs.
            disabled={props.detailDisabled && !props.hasDetail?.(props.card.analysisId!)}
            title={props.hasDetail?.(props.card.analysisId!) ? '打开已加载的分析详情' : props.detailDisabled ? '请等待当前回复完成' : undefined}
            onClick={() => props.onViewDetail!(props.card.analysisId!)}
            data-testid="gpas-view-detail"
          >
            查看详情
            <span aria-hidden="true" class="i-lucide-chevron-right h-3.5 w-3.5" />
          </button>
        </Show>
      </header>

      <div class="px-3 py-3">
        <Show
          when={groups()}
          fallback={
            <p class="px-1 text-xs text-slate-500">
              分析状态：{props.card.analysisStatus ?? '未知'}，暂无分析摘要。
            </p>
          }
        >
          {(group) => (
            <>
              <Show
                when={group().shown.length > 0}
                fallback={<p class="px-1 text-xs text-slate-500">分析摘要中未检出微生物。</p>}
              >
                <div class="flex flex-wrap gap-2">
                  <For each={group().shown}>{(category, index) => <CategoryBlock category={category} index={index()} sharePct={share(category)} />}</For>
                  <Show when={group().folded.length > 0}>
                    <FoldedBlock categories={group().folded} share={share} />
                  </Show>
                </div>
              </Show>
              <Show when={group().missing.length > 0}>
                <p class="mt-2 px-1 text-xs text-slate-500">未检出：{group().missing.map((category) => category.name).join('、')}</p>
              </Show>
            </>
          )}
        </Show>
      </div>

      <footer class="flex flex-wrap items-center gap-x-4 gap-y-1 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        <span class="inline-flex min-w-0 items-center gap-1" title={props.card.files.map((file) => file.fileName).join('\n')}>
          <span aria-hidden="true" class="i-lucide-file h-3.5 w-3.5 shrink-0" />
          <span class="truncate">
            {props.card.files.map((file) => file.fileName).join(' / ')}
          </span>
        </span>
        <Show when={size() !== null}>
          <span class="font-semibold">{formatSize(size()!)}</span>
        </Show>
        <Show when={props.card.brief?.totalReads != null}>
          <span class="inline-flex items-center gap-1 font-semibold">
            <span aria-hidden="true" class="i-lucide-file-text h-3.5 w-3.5 shrink-0" />
            {formatReads(props.card.brief!.totalReads!)}
          </span>
        </Show>
        <Show when={props.card.brief?.dataVolume != null}>
          <span>数据量 {formatVolume(props.card.brief!.dataVolume!)}</span>
        </Show>
        <Show when={props.card.uploadTime}>
          {(time) => (
            <span class="inline-flex items-center gap-1 font-semibold">
              <span aria-hidden="true" class="i-lucide-clock h-3.5 w-3.5 shrink-0" />
              {formatTime(time())}
            </span>
          )}
        </Show>
        <Show when={sampleText(props.card.sampleType)}>{(type) => <span>{type()}</span>}</Show>
        <Show when={props.card.metaStatus}>{(status) => <span>元数据：{status()}</span>}</Show>
      </footer>
    </article>
  )
}

/** Analysis summary cards returned by the file list tool, one per sample. */
export function FileAnalysisCards(props: { cards: FileCard[] } & DetailProps) {
  return (
    <div class="my-2 space-y-3" data-testid="gpas-file-cards">
      <For each={props.cards}>
        {(card) => <AnalysisCard card={card} onViewDetail={props.onViewDetail} detailDisabled={props.detailDisabled} hasDetail={props.hasDetail} />}
      </For>
    </div>
  )
}

/** Entry to a sample's analysis detail; opens the side panel. */
export function GpasResultEntry(props: { taskId: string; total: number; sampleName: string | null; onOpen: (taskId: string) => void }) {
  return (
    <button
      type="button"
      class="my-3 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-gray-300 bg-gray-50/60 p-4 text-left transition hover:border-gray-300 hover:bg-gray-50"
      onClick={() => props.onOpen(props.taskId)}
      data-testid="gpas-result-entry"
    >
      <span class="i-lucide-list-tree h-5 w-5 shrink-0 text-teal-700" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-slate-800">{props.sampleName ? `${props.sampleName} 分析详情` : '样本分析详情'}</span>
        <span class="block truncate text-xs text-slate-500">共 {props.total} 条物种结果 · 按大类分页查看</span>
      </span>
      <span class="i-lucide-chevron-right h-4 w-4 text-slate-400" />
    </button>
  )
}
