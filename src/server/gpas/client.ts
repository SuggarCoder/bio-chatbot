import { z } from 'zod'

import { AuthenticationError } from '../auth.js'
import type { AppConfig } from '../config.js'

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
export class GpasClient {
  constructor(private readonly config: AppConfig) {}

  async call(cookie: string | undefined, request: GpasRequest): Promise<GpasEnvelope> {
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
    try { payload = envelope.parse(await response.json()) } catch {
      throw new GpasUpstreamError(`${label}返回了无效数据（上游 HTTP ${response.status}）。`, 'gpas_invalid_response', responseDiagnostics)
    }
    if (payload.code === 401 || payload.code === 403) throw new GpasUpstreamError(`${label}失败：登录已失效或无权访问项目。`, 'unauthorized', { ...responseDiagnostics, upstreamCode: payload.code }, payload.code)
    if (payload.code !== 200) throw new GpasUpstreamError(`${label}未成功（业务状态码 ${payload.code}），请检查填写信息或稍后重试。`, 'gpas_business_error', { ...responseDiagnostics, upstreamCode: payload.code })
    return payload
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
