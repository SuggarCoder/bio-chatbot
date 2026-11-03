import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'

import gpasUrl from '../../assets/images/gpas.svg'
import {
  fetchTokenQuota,
  redeemResetVoucher,
  type TokenQuotaDto,
  type TokenQuotaWindowDto,
} from '../chatbot/chatApi'
import { displayPercent, quotaTone, resetAvailability, usageCaption, type QuotaTone } from './quotaView'

const [open, setOpen] = createSignal(false)
/**
 * The last quota seen, kept across openings: the dialog shows it at once and
 * refreshes it in the background instead of starting from a loading state.
 */
const [cachedQuota, setCachedQuota] = createSignal<TokenQuotaDto | null>(null)

/** Longest exit animation (.dialog-panel-out) plus a margin. */
const CLOSE_FALLBACK_MS = 200

/** Opens the token usage dialog from anywhere (account menu, quota errors). */
export function openTokenUsage() {
  setOpen(true)
}

/** Rendered once in the layout; shows the dialog while it is open. */
export function TokenUsageHost() {
  return (
    <Show when={open()}>
      <TokenUsageDialog onClosed={() => setOpen(false)} />
    </Show>
  )
}

const percentClass: Record<QuotaTone, string> = {
  normal: 'text-teal-600',
  warning: 'text-amber-600',
  exhausted: 'text-rose-600',
}

const barGradient: Record<QuotaTone, string> = {
  normal: 'linear-gradient(90deg, #0d9488, #5eead4)',
  warning: 'linear-gradient(90deg, #d97706, #fcd34d)',
  exhausted: 'linear-gradient(90deg, #e11d48, #fb7185)',
}

/*
 * QuotaRow and QuotaRowSkeleton share one box model (a 32px header, a 10px
 * bar, a 16px caption) so the card keeps its size when the data arrives.
 */
function QuotaRow(props: { label: string; icon: string; window: TokenQuotaWindowDto }) {
  const tone = () => quotaTone(props.window)
  const limited = () => props.window.limit > 0
  const percent = () => displayPercent(props.window)
  // The bar starts empty and grows to its value, on first show and on change.
  const [shownPercent, setShownPercent] = createSignal(0)

  createEffect(() => {
    const target = percent()
    // Two frames: the first lets the empty bar be painted, so the change animates.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShownPercent(target))
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <div class="flex gap-4">
      <span aria-hidden="true" class={`${props.icon} mt-0.5 h-7 w-7 shrink-0 text-slate-600`} />
      <div class="min-w-0 flex-1">
        <div class="flex h-8 items-baseline justify-between gap-3">
          <span class="text-base font-semibold text-slate-800">{props.label}</span>
          <span class={`text-2xl font-bold tabular-nums ${limited() ? percentClass[tone()] : 'text-slate-400'}`}>
            {limited() ? `${percent()}%` : '不限'}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${props.label}已使用`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()}
          class="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200"
        >
          <span
            class="block h-full rounded-full transition-[width] duration-700 ease-out"
            style={{ width: `${shownPercent()}%`, 'background-image': barGradient[tone()] }}
          />
        </div>
        <p class="mt-2 h-4 text-xs leading-4 text-slate-500">{usageCaption(props.window)}</p>
      </div>
    </div>
  )
}

function QuotaRowSkeleton() {
  return (
    <div class="flex gap-4" aria-hidden="true">
      <span class="gpas-skeleton mt-0.5 h-7 w-7 shrink-0 rounded-lg" />
      <div class="min-w-0 flex-1">
        <div class="flex h-8 items-center justify-between gap-3">
          <span class="gpas-skeleton block h-5 w-16" />
          <span class="gpas-skeleton block h-7 w-14" />
        </div>
        <div class="gpas-skeleton mt-3 h-2.5 rounded-full" />
        <span class="gpas-skeleton mt-2 block h-4 w-48" />
      </div>
    </div>
  )
}

function TokenUsageDialog(props: { onClosed: () => void }) {
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [redeeming, setRedeeming] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [closing, setClosing] = createSignal(false)
  let panelRef: HTMLElement | undefined
  let closeTimer: number | undefined
  // Only the newest request may update the quota: a slow background refresh
  // must not overwrite the result of a redemption that finished after it.
  let latestRequest = 0

  const load = async (request: () => Promise<TokenQuotaDto>) => {
    const id = ++latestRequest
    const result = await request()
    if (id === latestRequest) setCachedQuota(result)
  }

  const refresh = async () => {
    try {
      await load(fetchTokenQuota)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '暂时无法获取用量，请稍后重试。')
    }
  }
  void refresh()

  const redeem = async () => {
    setRedeeming(true)
    setError(null)
    setNotice(null)
    try {
      await load(redeemResetVoucher)
      setConfirming(false)
      setNotice('已使用 1 张 Reset 卷，周限额与月限额已重置。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败，请稍后重试。')
    } finally {
      setRedeeming(false)
    }
  }

  const finishClose = () => {
    window.clearTimeout(closeTimer)
    props.onClosed()
  }

  /** Plays the exit animation, then unmounts. */
  const requestClose = () => {
    if (closing()) return
    setClosing(true)
    closeTimer = window.setTimeout(finishClose, CLOSE_FALLBACK_MS)
  }

  const availability = () => {
    const current = cachedQuota()
    return current ? resetAvailability(current) : { available: false as const, reason: '正在加载…' }
  }

  createEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (confirming()) setConfirming(false)
      else requestClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    queueMicrotask(() => panelRef?.focus({ preventScroll: true }))
    onCleanup(() => {
      window.clearTimeout(closeTimer)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    })
  })

  return (
    <Portal>
      {/*
        Anchored near the top rather than centred: if the content ever grows
        (a notice, an error), the card extends downwards instead of jumping.
      */}
      <div
        class={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[10vh] sm:p-6 sm:pt-[14vh] ${closing() ? 'dialog-backdrop-out' : 'dialog-backdrop-in'}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose()
        }}
      >
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="token-usage-title"
          aria-busy={cachedQuota() === null}
          tabindex="-1"
          class={`relative w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl outline-none will-change-transform sm:p-8 ${closing() ? 'dialog-panel-out' : 'dialog-panel-in'}`}
          onAnimationEnd={(event) => {
            if (closing() && event.target === event.currentTarget) finishClose()
          }}
        >
          <header class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <img src={gpasUrl} alt="" class="h-8 w-8 object-contain" />
              <h3 id="token-usage-title" class="text-2xl font-bold text-slate-900">Token 使用量</h3>
            </div>
            <button
              type="button"
              aria-label="关闭"
              class="grid h-9 w-9 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 cursor-pointer"
              onClick={requestClose}
            >
              <span aria-hidden="true" class="i-lucide-x h-5 w-5" />
            </button>
          </header>

          <div class="mt-6 flex min-h-16 items-center rounded-2xl bg-teal-50/80 px-4 py-3 sm:px-5">
            <Show
              when={confirming()}
              fallback={
                <div class="flex w-full items-center justify-between gap-3">
                  <span class="flex items-center gap-3 text-lg font-semibold text-slate-800">
                    <span aria-hidden="true" class="i-lucide-layers h-6 w-6 text-slate-700" />
                    当前可用
                  </span>
                  <button
                    type="button"
                    title={availability().available ? undefined : (availability() as { reason: string }).reason}
                    disabled={redeeming() || !availability().available}
                    class="inline-flex shrink-0 items-center gap-2 rounded-full bg-teal-100 px-4 py-2 text-sm font-semibold text-teal-800 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-teal-100 cursor-pointer"
                    onClick={() => setConfirming(true)}
                  >
                    <span aria-hidden="true" class="i-lucide-ticket h-5 w-5" />
                    使用 Reset 卷
                    <span class="min-w-8 rounded-full bg-white/80 px-2 py-0.5 text-center text-xs tabular-nums text-teal-700">
                      {cachedQuota() ? `×${cachedQuota()!.resetVouchers}` : '—'}
                    </span>
                  </button>
                </div>
              }
            >
              <div class="flex w-full flex-wrap items-center justify-between gap-3">
                <span class="text-sm text-slate-700">
                  使用 1 张 Reset 卷重置周限额与月限额？剩余 {cachedQuota()?.resetVouchers ?? 0} 张，此操作无法撤销。
                </span>
                <div class="flex shrink-0 gap-2 text-sm">
                  <button
                    type="button"
                    class="rounded-full px-3 py-1.5 font-semibold text-slate-500 hover:bg-white/70 cursor-pointer"
                    onClick={() => setConfirming(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={redeeming()}
                    class="rounded-full bg-teal-700 px-4 py-1.5 font-semibold text-white hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
                    onClick={() => void redeem()}
                  >
                    确认使用
                  </button>
                </div>
              </div>
            </Show>
          </div>

          <Show when={error()}>
            <p class="gpas-fade-in mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error()}</p>
          </Show>
          <Show when={notice()}>
            <p class="gpas-fade-in mt-4 rounded-xl bg-teal-50 px-3 py-2 text-sm text-teal-800">{notice()}</p>
          </Show>

          <div class="my-6 h-px bg-slate-200" />

          <div class="flex flex-col gap-7">
            <Show
              when={cachedQuota()}
              fallback={<For each={[0, 1]}>{() => <QuotaRowSkeleton />}</For>}
            >
              {(current) => (
                <>
                  <QuotaRow label="周限额" icon="i-lucide-calendar-plus" window={current().weekly} />
                  <QuotaRow label="月限额" icon="i-lucide-calendar-days" window={current().monthly} />
                </>
              )}
            </Show>
          </div>

          <div class="my-6 h-px bg-slate-200" />

          <p class="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
            <span aria-hidden="true" class="i-lucide-info h-5 w-5 shrink-0" />
            Reset 卷可重置全部限制（周限额与月限额）。
          </p>
        </section>
      </div>
    </Portal>
  )
}
