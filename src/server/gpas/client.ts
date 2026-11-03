import { z } from 'zod'

import { AuthenticationError } from '../auth.js'
import type { AppConfig } from '../config.js'
import { metrics } from '../metrics.js'

export type GpasRequest = {
  /** Stable operation key for diagnostics, e.g. `project_summary`. */
  operation: string
  /** Chinese label used in user-facing error messages, e.g. `项目进度汇总查询`. */
  label: string
  method: 'GET' | 'POST'
  /** Resource path relative to the GPAS API prefix, already URL-encoded. */
  path: string
  /** Query parameters; undefined values are skipped. */
  query?: Record<string, string | number | undefined>
  body?: unknown
}

export type GpasDiagnostics = {
  operation: string
  upstreamStatus?: number
  upstreamCode?: number
  responseContentType?: string
  method: string
  endpoint: string
}

export class GpasUpstreamError extends AuthenticationError {
  constructor(
    message: string,
    code: string,
    readonly diagnostics: GpasDiagnostics,
    statusCode = 502,
  ) {
    super(message, statusCode, code)
  }
}

export function gpasUrl(userInfoUrl: string | undefined, resource: string): URL {
  if (!userInfoUrl) throw new AuthenticationError('未配置 GPAS 用户信息接口地址。', 503, 'gpas_config_invalid')
  const url = new URL(userInfoUrl)
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  const suffix = '/user/info'
  if (!path.endsWith(suffix)) throw new AuthenticationError('GPAS 用户信息接口地址应以 /user/info 结尾。', 503, 'gpas_config_invalid')
  url.pathname = `${path.slice(0, -suffix.length)}/${resource}`
  url.search = ''
  url.hash = ''
  return url
}

const envelope = z.object({ code: z.number(), message: z.string().optional() }).passthrough()
export type GpasEnvelope = z.infer<typeof envelope>

/**
 * Shared transport for every GPAS API. It always uses the caller's own session
 * cookie; identity never comes from tool arguments. Cookies and payloads are
 * never included in diagnostics.
 */
/** Upstream responses larger than this are refused rather than buffered. */
export const GPAS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Concurrent upstream calls per process; more wait briefly, then get 503. */
const GPAS_MAX_CONCURRENCY = 32
const GPAS_MAX_WAITING = 64
const GPAS_QUEUE_WAIT_MS = 5_000
/** After this many consecutive transport failures the breaker opens ... */
const BREAKER_FAILURES = 5
/** ... and calls fail fast for this long before one trial call is allowed. */
const BREAKER_OPEN_MS = 15_000

/** Reads a fetch body, refusing to buffer more than `maxBytes`. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Response of ${declared} bytes exceeds ${maxBytes}`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Response exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Per-process protection for the GPAS upstream: a concurrency limit with a
 * short wait, and a circuit breaker so a slow or failing GPAS turns into fast
 * 503s instead of one held socket per inbound request.
 */
export class GpasGuard {
  private active = 0
  private readonly waiting: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = []
  private consecutiveFailures = 0
  private openUntil = 0
  private trialInFlight = false

  constructor(
    private readonly concurrency = GPAS_MAX_CONCURRENCY,
    private readonly maxWaiting = GPAS_MAX_WAITING,
    private readonly waitMs = GPAS_QUEUE_WAIT_MS,
  ) {}

  private unavailable(diagnostics: GpasDiagnostics, reason: string): GpasUpstreamError {
    return new GpasUpstreamError('项目服务繁忙或暂不可用，请稍后重试。', reason, diagnostics, 503)
  }

  async run<T>(diagnostics: GpasDiagnostics, operation: () => Promise<T>): Promise<T> {
    const now = Date.now()
    let trial = false
    if (this.openUntil > now) throw this.unavailable(diagnostics, 'gpas_circuit_open')
    if (this.openUntil > 0) {
      // Half-open: one trial call decides whether to close the breaker.
      if (this.trialInFlight) throw this.unavailable(diagnostics, 'gpas_circuit_open')
      this.trialInFlight = true
      trial = true
    }
    try {
      await this.acquire(diagnostics)
    } catch (error) {
      if (trial) this.trialInFlight = false
      throw error
    }
    try {
      const result = await operation()
      this.consecutiveFailures = 0
      this.openUntil = 0
      return result
    } catch (error) {
      if (error instanceof GpasUpstreamError && ['gpas_unavailable', 'gpas_upstream_error'].includes(error.code)) {
        this.consecutiveFailures += 1
        if (trial || this.consecutiveFailures >= BREAKER_FAILURES) this.openUntil = Date.now() + BREAKER_OPEN_MS
      } else {
        this.consecutiveFailures = 0
        this.openUntil = 0
      }
      throw error
    } finally {
      if (trial) this.trialInFlight = false
      this.release()
    }
  }

  private acquire(diagnostics: GpasDiagnostics): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1
      return Promise.resolve()
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(this.unavailable(diagnostics, 'gpas_busy'))
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(this.unavailable(diagnostics, 'gpas_busy'))
        }, this.waitMs),
      }
      entry.timer.unref()
      this.waiting.push(entry)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve() // Hand the slot over.
    } else {
      this.active -= 1
    }
  }
}

export class GpasClient {
  private readonly guard = new GpasGuard()

  constructor(private readonly config: AppConfig) {}

  async call(cookie: string | undefined, request: GpasRequest): Promise<GpasEnvelope> {
    const stop = metrics.gpasRequests.startTimer()
    try {
      const result = await this.callUnmetered(cookie, request)
      stop({ outcome: 'ok' })
      return result
    } catch (error) {
      stop({ outcome: error instanceof GpasUpstreamError ? error.code : 'error' })
      throw error
    }
  }

  private async callUnmetered(cookie: string | undefined, request: GpasRequest): Promise<GpasEnvelope> {
    if (!cookie) throw new AuthenticationError('登录已失效，请重新登录。')
    const { operation, label, method, path, query, body } = request
    const url = gpasUrl(this.config.gpas2UserInfoUrl, path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    // Keep the actual request path for diagnosis. Only URL credentials are removed.
    const endpoint = new URL(url)
    endpoint.username = ''
    endpoint.password = ''
    // Query values are business filters; diagnostics keep the path only.
    endpoint.search = ''
    const diagnostics = { operation, method, endpoint: endpoint.toString() }
    return this.guard.run(diagnostics, async () => {
    let response: Response
    try {
      response = await fetch(url, {
        method, redirect: 'error',
        headers: { accept: 'application/json', cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new GpasUpstreamError(`${label}连接失败或超时，请稍后重试；若刚提交过表单，请先查询项目进度确认结果。`, 'gpas_unavailable', diagnostics)
    }
    const responseDiagnostics = {
      ...diagnostics,
      upstreamStatus: response.status,
      responseContentType: response.headers.get('content-type') ?? undefined,
    }
    if (response.status === 401 || response.status === 403) throw new GpasUpstreamError(`${label}失败：登录已失效或无权访问项目（上游 HTTP ${response.status}）。`, 'unauthorized', responseDiagnostics, response.status)
    if (!response.ok) throw new GpasUpstreamError(`${label}返回错误（上游 HTTP ${response.status}），请联系管理员检查对应接口。`, 'gpas_upstream_error', responseDiagnostics)
    let payload: GpasEnvelope
    try {
      payload = envelope.parse(JSON.parse(await readBoundedBody(response, GPAS_MAX_RESPONSE_BYTES)))
    } catch {
      throw new GpasUpstreamError(`${label}返回了无效数据（上游 HTTP ${response.status}）。`, 'gpas_invalid_response', responseDiagnostics)
    }
    if (payload.code === 401 || payload.code === 403) throw new GpasUpstreamError(`${label}失败：登录已失效或无权访问项目。`, 'unauthorized', { ...responseDiagnostics, upstreamCode: payload.code }, payload.code)
    if (payload.code !== 200) throw new GpasUpstreamError(`${label}未成功（业务状态码 ${payload.code}），请检查填写信息或稍后重试。`, 'gpas_business_error', { ...responseDiagnostics, upstreamCode: payload.code })
    return payload
    })
  }

  /** Call and validate the envelope payload against a response schema. */
  async read<T>(cookie: string | undefined, request: GpasRequest, schema: z.ZodType<T>): Promise<T> {
    return parseGpasData(schema, await this.call(cookie, request))
  }
}

export function parseGpasData<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AuthenticationError('项目服务数据不完整，请联系管理员。', 502, 'gpas_invalid_response')
  return parsed.data
}
