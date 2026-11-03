/**
 * Retry timing shared by the chat API, the SSE stream and the fallback poll.
 *
 * Every client that loses the server at the same moment (a deploy, a Redis
 * restart) must not come back at the same moment, so every delay is jittered.
 */

export type Random = () => number

/** HTTP statuses a proxy or the API returns while it is briefly unavailable. */
export function isTransientStatus(status: number) {
  return status === 502 || status === 503 || status === 504
}

/**
 * "Full jitter" exponential backoff: uniform in [0, min(cap, base * 2^attempt)).
 * `attempt` counts from 0 for the first retry.
 */
export function fullJitterDelay(
  attempt: number,
  options: { baseMs: number; capMs: number; random?: Random },
) {
  const ceiling = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt))
  return Math.round((options.random ?? Math.random)() * ceiling)
}

/** Spreads a fixed delay over [0.5, 1.5) of its value. */
export function jitter(delayMs: number, random: Random = Math.random) {
  return Math.round(delayMs * (0.5 + random()))
}

/**
 * Poll interval that grows from `baseMs` to `capMs` (doubling) with ±20 % jitter,
 * so a long wait costs a request every `capMs` instead of every `baseMs`.
 */
export function pollDelay(
  attempt: number,
  options: { baseMs: number; capMs: number; random?: Random },
) {
  const delay = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt))
  return Math.round(delay * (0.8 + 0.4 * (options.random ?? Math.random)()))
}

/**
 * Parses a Retry-After header (delta-seconds or an HTTP date) into milliseconds.
 * Returns undefined when absent or malformed; never more than `maxMs`.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
  maxMs = 120_000,
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  let delay: number
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    delay = Number(trimmed) * 1_000
  } else {
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    delay = date - now
  }
  return Math.min(maxMs, Math.max(0, Math.round(delay)))
}

export function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function sleep(durationMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timeoutId)
      reject(abortError())
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolves at once when the tab is visible, otherwise when it becomes visible. */
export function waitUntilVisible(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      resolve()
      return
    }
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onChange)
      signal?.removeEventListener('abort', onAbort)
    }
    const onChange = () => {
      if (document.visibilityState === 'hidden') return
      cleanup()
      resolve()
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    document.addEventListener('visibilitychange', onChange)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Waits `durationMs`, then for the tab to be visible: hidden tabs do not poll. */
export async function pollSleep(durationMs: number, signal?: AbortSignal) {
  await sleep(durationMs, signal)
  await waitUntilVisible(signal)
}

/** A signal that aborts when any input does (AbortSignal.any where available). */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (present.length === 1) return present[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(present)
  const controller = new AbortController()
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}
