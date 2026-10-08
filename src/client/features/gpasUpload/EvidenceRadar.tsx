import { createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import type { FileResultRow } from '../../../server/gpasContracts'
import { EVIDENCE_AXES, evidencePoints, hazardGradient, polygon, radarPoint } from './evidenceRadar'

const RINGS = [25, 50, 75, 100]

/** Gradient defs shared by both sizes: fill follows the species' hazard level. */
function Defs(props: { id: string; hazard: number | null }) {
  const tone = () => hazardGradient(props.hazard)
  return (
    <defs>
      <linearGradient id={`${props.id}-fill`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color={tone().from} stop-opacity="0.42" />
        <stop offset="100%" stop-color={tone().to} stop-opacity="0.3" />
      </linearGradient>
      <linearGradient id={`${props.id}-line`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color={tone().from} />
        <stop offset="100%" stop-color={tone().to} />
      </linearGradient>
    </defs>
  )
}

/** Unlabelled radar for the table cell. */
export function MiniRadar(props: { row: FileResultRow; size?: number }) {
  const id = createUniqueId()
  const size = () => props.size ?? 44
  const c = () => size() / 2
  const r = () => size() / 2 - 2
  const points = () => evidencePoints(props.row).map((point, index) => radarPoint(index, point.score, r(), c(), c()))
  return (
    <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} aria-hidden="true" class="block">
      <Defs id={id} hazard={props.row.hazardIndex} />
      <For each={[50, 100]}>
        {(ring) => (
          <polygon
            points={polygon(EVIDENCE_AXES.map((_, index) => radarPoint(index, ring, r(), c(), c())))}
            fill={ring === 100 ? '#faf8f6' : 'none'}
            stroke="#e7e2dd"
            stroke-width="0.75"
          />
        )}
      </For>
      <polygon points={polygon(points())} fill={`url(#${id}-fill)`} stroke={`url(#${id}-line)`} stroke-width="1.25" stroke-linejoin="round" />
    </svg>
  )
}

/** The full species evidence radar: axis names, raw values and hazard-tinted area. */
export function EvidenceRadarCard(props: { row: FileResultRow; index: number; onClose?: () => void; closeRef?: (element: HTMLButtonElement) => void }) {
  const id = createUniqueId()
  const W = 560
  const H = 420
  const cx = W / 2
  const cy = 214
  const R = 124
  const tone = () => hazardGradient(props.row.hazardIndex)
  const points = () => evidencePoints(props.row)
  const vertex = (index: number, score: number) => radarPoint(index, score, R, cx, cy)
  const anchor = (index: number) => {
    const x = vertex(index, 100).x - cx
    return Math.abs(x) < 1 ? 'middle' : x > 0 ? 'start' : 'end'
  }

  return (
    <article class="rounded-3xl bg-[#f8f6f3] p-5 text-[#4a4048]" data-testid="gpas-evidence-radar">
      <header class="flex items-start justify-between gap-3">
        <div>
          <p class="text-[10px] font-medium uppercase tracking-[0.14em] text-[#a3958f]">Species evidence / {String(props.index).padStart(2, '0')}</p>
          <h3 class="mt-0.5 text-base font-semibold text-[#2f2830]">物种证据雷达</h3>
          <p class="text-xs text-[#a3958f]">Normalized evidence profile</p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <span
            class="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white shadow-sm"
            style={{ 'background-image': `linear-gradient(135deg, ${tone().from}, ${tone().to})` }}
          >
            Detected
          </span>
          <Show when={props.onClose}>
            <button
              ref={props.closeRef}
              type="button"
              class="grid h-7 w-7 place-items-center rounded-full text-[#a3958f] transition hover:bg-white hover:text-[#2f2830]"
              aria-label="关闭证据雷达"
              onClick={() => props.onClose?.()}
            >
              <span aria-hidden="true" class="i-lucide-x h-4 w-4" />
            </button>
          </Show>
        </div>
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} class="mt-1 block h-auto w-full" role="img" aria-label={`${props.row.taxCname} 证据雷达`}>
        <Defs id={id} hazard={props.row.hazardIndex} />
        <For each={RINGS}>
          {(ring) => (
            <polygon
              points={polygon(EVIDENCE_AXES.map((_, index) => vertex(index, ring)))}
              fill={ring === 100 ? '#fdfcfb' : 'none'}
              stroke="#e6e0da"
              stroke-width="1"
            />
          )}
        </For>
        <For each={EVIDENCE_AXES}>
          {(_, index) => {
            const end = vertex(index(), 100)
            return <line x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#e3d9de" stroke-width="1" stroke-dasharray="4 5" />
          }}
        </For>
        <polygon
          points={polygon(points().map((point, index) => vertex(index, point.score)))}
          fill={`url(#${id}-fill)`}
          stroke={`url(#${id}-line)`}
          stroke-width="2"
          stroke-linejoin="round"
        />
        <For each={points()}>
          {(point, index) => {
            const at = () => vertex(index(), point.score)
            // Value sits just outside its vertex, along the axis, clear of the point.
            const label = () => {
              const unit = vertex(index(), 100)
              const dx = (unit.x - cx) / R
              const dy = (unit.y - cy) / R
              return { x: at().x + dx * 16 + (Math.abs(dx) < 0.01 ? 0 : Math.sign(dx) * 4), y: at().y + dy * 16 + (dy < -0.5 ? -4 : dy > 0.5 ? 12 : 6) }
            }
            return (
              <>
                <circle cx={at().x} cy={at().y} r="5" fill="#fff" stroke={tone().ink} stroke-width="2" />
                <text
                  x={label().x}
                  y={label().y}
                  text-anchor={anchor(index())}
                  font-size="17"
                  font-weight="700"
                  fill={tone().ink}
                  data-testid="gpas-radar-value"
                >
                  {point.label}
                </text>
              </>
            )
          }}
        </For>
        <For each={EVIDENCE_AXES}>
          {(axis, index) => {
            const at = () => radarPoint(index(), 100, R + 50, cx, cy)
            return (
              <text x={at().x} y={at().y - 4} text-anchor={anchor(index())}>
                <tspan font-size="15" font-weight="600" fill="#4a4048">{axis.name}</tspan>
                <tspan x={at().x} dy="17" font-size="10.5" letter-spacing="1" fill="#b3a6a8">{axis.en}</tspan>
              </text>
            )
          }}
        </For>
      </svg>
    </article>
  )
}

/** Full radar in a modal: Esc or the backdrop closes it and focus returns to the trigger. */
export function EvidenceRadarDialog(props: { row: FileResultRow; index: number; onClose: () => void }) {
  let closeButton: HTMLButtonElement | undefined
  const setCloseButton = (element: HTMLButtonElement) => { closeButton = element }
  const previous = document.activeElement as HTMLElement | null
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose()
    }
  }
  onMount(() => {
    closeButton?.focus()
    window.addEventListener('keydown', onKey)
  })
  onCleanup(() => {
    window.removeEventListener('keydown', onKey)
    previous?.focus?.()
  })

  return (
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${props.row.taxCname} 物种证据雷达`}>
      <button type="button" aria-label="关闭" tabIndex={-1} class="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={props.onClose} />
      <div class="gpas-fade-in gpas-scrollbar relative z-10 max-h-full w-full max-w-[540px] overflow-auto rounded-[28px] bg-white p-2 shadow-2xl">
        <EvidenceRadarCard row={props.row} index={props.index} onClose={props.onClose} closeRef={setCloseButton} />
        <div class="px-4 pb-3 pt-2">
          <p class="mb-1.5 text-xs font-semibold text-slate-700">{props.row.taxCname}<Show when={props.row.taxEname && props.row.taxEname !== props.row.taxCname}> · <i class="font-normal text-slate-500">{props.row.taxEname}</i></Show></p>
          <table class="w-full text-xs">
            <thead class="text-slate-400">
              <tr><th class="py-1 text-left font-medium">维度</th><th class="py-1 text-right font-medium">原始值</th><th class="py-1 text-right font-medium">分数</th></tr>
            </thead>
            <tbody class="tabular-nums text-slate-600">
              <For each={evidencePoints(props.row)}>
                {(point) => (
                  <tr class="border-t border-slate-100">
                    <td class="py-1.5">{point.axis.name}</td>
                    <td class="py-1.5 text-right">{point.label}</td>
                    <td class="py-1.5 text-right font-semibold text-slate-800">{point.raw === null ? '—' : point.score}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
