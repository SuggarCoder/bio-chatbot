import type { TokenQuotaDto, TokenQuotaWindowDto } from '../chatbot/chatApi'

export type QuotaTone = 'normal' | 'warning' | 'exhausted'

const BEIJING_TIME_ZONE = 'Asia/Shanghai'

/** Whole-number percent for display; never shows 100% before the limit is hit. */
export function displayPercent(window: TokenQuotaWindowDto) {
  if (window.limit <= 0) return 0
  if (window.used >= window.limit) return 100
  return Math.min(99, Math.floor(window.percent))
}

export function quotaTone(window: TokenQuotaWindowDto): QuotaTone {
  if (window.limit <= 0) return 'normal'
  if (window.used >= window.limit) return 'exhausted'
  return window.percent >= 90 ? 'warning' : 'normal'
}

/** Compact Chinese token count: 860, 1.2万, 350万, 1.5亿. */
export function formatTokens(value: number) {
  const trim = (number: number) => number.toFixed(number < 10 ? 1 : 0).replace(/\.0$/, '')
  if (value >= 100_000_000) return `${trim(value / 100_000_000)}亿`
  if (value >= 10_000) return `${trim(value / 10_000)}万`
  return value.toLocaleString('zh-CN')
}

/** e.g. "11月16日 00:00 重置", in Beijing time like the server's periods. */
export function resetLabel(resetsAt: string) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(resetsAt))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')} 重置`
}

export function usageCaption(window: TokenQuotaWindowDto) {
  if (window.limit <= 0) return `已用 ${formatTokens(window.used)} · 不限额度`
  return `已用 ${formatTokens(window.used)} / ${formatTokens(window.limit)} · ${resetLabel(window.resetsAt)}`
}

export type ResetAvailability =
  | { available: true }
  | { available: false; reason: string }

/** Whether spending a Reset 卷 makes sense right now, and why not. */
export function resetAvailability(quota: TokenQuotaDto): ResetAvailability {
  if (quota.resetVouchers <= 0) return { available: false, reason: '暂无可用的 Reset 卷' }
  const limited = [quota.weekly, quota.monthly].filter((window) => window.limit > 0)
  if (limited.length === 0) return { available: false, reason: '当前额度不限，无需重置' }
  if (limited.every((window) => window.used === 0)) return { available: false, reason: '当前额度尚未使用，无需重置' }
  return { available: true }
}
