import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
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

/** Opens the token usage dialog from anywhere (account menu, quota errors). */
export function openTokenUsage() {
  setOpen(true)
}

/** Rendered once in the layout; shows the dialog while it is open. */
export function TokenUsageHost() {
  return (
    <Show when={open()}>
      <TokenUsageDialog onClose={() => setOpen(false)} />
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

function QuotaRow(props: { label: string; icon: string; window: TokenQuotaWindowDto }) {
  const tone = () => quotaTone(props.window)
  const limited = () => props.window.limit > 0
  const percent = () => displayPercent(props.window)

  return (
    <div class="flex gap-4">
      <span aria-hidden="true" class={`${props.icon} mt-0.5 h-7 w-7 shrink-0 text-slate-600`} />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-base font-semibold text-slate-800">{props.label}</span>
          <span class={`text-2xl font-bold tabular-nums ${limited() ? percentClass[tone()] : 'text-slate-400'}`}>
            {limited() ? `${percent()}%` : '不限'}
          </span>
        </div>
        <Show when={limited()}>
          <div
            role="progressbar"
            aria-label={`${props.label}已使用`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent()}
            class="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200"
          >
            <span
              class="block h-full rounded-full transition-[width] duration-500"
              style={{ width: `${percent()}%`, 'background-image': barGradient[tone()] }}
            />
          </div>
        </Show>
        <p class="mt-2 text-xs text-slate-500">{usageCaption(props.window)}</p>
      </div>
    </div>
  )
}

function TokenUsageDialog(props: { onClose: () => void }) {
  const [quota, setQuota] = createSignal<TokenQuotaDto | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  let dialogRef: HTMLElement | undefined

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  void run(async () => {
    setQuota(await fetchTokenQuota())
  })

  const redeem = () =>
    run(async () => {
      setQuota(await redeemResetVoucher())
      setConfirming(false)
      setNotice('已使用 1 张 Reset 卷，周限额与月限额已重置。')
    })

  const availability = () => {
    const current = quota()
    return current ? resetAvailability(current) : { available: false as const, reason: '正在加载…' }
  }

  createEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (confirming()) setConfirming(false)
      else props.onClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    queueMicrotask(() => dialogRef?.focus())
    onCleanup(() => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    })
  })

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 sm:p-6"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="token-usage-title"
          tabindex="-1"
          class="relative w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl outline-none sm:p-8"
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
              onClick={props.onClose}
            >
              <span aria-hidden="true" class="i-lucide-x h-5 w-5" />
            </button>
          </header>

          <div class="mt-6 rounded-2xl bg-teal-50/80 px-4 py-3 sm:px-5">
            <Show
              when={confirming()}
              fallback={
                <div class="flex items-center justify-between gap-3">
                  <span class="flex items-center gap-3 text-lg font-semibold text-slate-800">
                    <span aria-hidden="true" class="i-lucide-layers h-6 w-6 text-slate-700" />
                    当前可用
                  </span>
                  <button
                    type="button"
                    title={availability().available ? undefined : (availability() as { reason: string }).reason}
                    disabled={busy() || !availability().available}
                    class="inline-flex shrink-0 items-center gap-2 rounded-full bg-teal-100 px-4 py-2 text-sm font-semibold text-teal-800 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-teal-100 cursor-pointer"
                    onClick={() => setConfirming(true)}
                  >
                    <span aria-hidden="true" class="i-lucide-ticket h-5 w-5" />
                    使用 Reset 卷
                    <span class="rounded-full bg-white/80 px-2 py-0.5 text-xs tabular-nums text-teal-700">
                      ×{quota()?.resetVouchers ?? 0}
                    </span>
                  </button>
                </div>
              }
            >
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-sm text-slate-700">
                  使用 1 张 Reset 卷重置周限额与月限额？剩余 {quota()?.resetVouchers ?? 0} 张，此操作无法撤销。
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
                    disabled={busy()}
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
            <p class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error()}</p>
          </Show>
          <Show when={notice()}>
            <p class="mt-4 rounded-xl bg-teal-50 px-3 py-2 text-sm text-teal-800">{notice()}</p>
          </Show>

          <div class="my-6 h-px bg-slate-200" />

          <Show
            when={quota()}
            fallback={<p class="py-6 text-center text-sm text-slate-400">{error() ? '暂时无法获取用量' : '正在加载…'}</p>}
          >
            {(current) => (
              <div class="flex flex-col gap-7">
                <QuotaRow label="周限额" icon="i-lucide-calendar-plus" window={current().weekly} />
                <QuotaRow label="月限额" icon="i-lucide-calendar-days" window={current().monthly} />
              </div>
            )}
          </Show>

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
