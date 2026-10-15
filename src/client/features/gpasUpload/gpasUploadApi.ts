/**
 * Browser → GPAS file upload transport (same origin, session Cookie).
 *
 * Backend assumptions — unverified locally, confirm on the remote environment
 * and adjust the constants below if any differ:
 *  1. Auth: the GPAS session Cookie alone authorises the file APIs; no
 *     `Authorization` header is sent.
 *  2. Re-sending a chunk `no` to the same task is safe (timeouts retry it), and
 *     a task accepts missing chunks later in the same session. If the task is
 *     rejected the engine creates a new one and re-uploads the whole file.
 *  3. `dual/task` echoes each file `name` unchanged; `endType` is only used to
 *     check the two entries differ, never for its concrete values.
 *  4. `sampleType` takes the project plan keys (clinic/media/environment/lab).
 *  5. Business `code` other than 200 is a definite failure unless listed in
 *     RETRYABLE_BUSINESS_CODES.
 */
import { z } from 'zod'
import type { SampleKey } from '../../../server/gpasContracts'

export const GPAS_API_BASE = (import.meta.env?.VITE_GPAS_API_BASE ?? '/api/gpas2/v1').replace(/\/+$/, '')
/** Same as GPAS Web, so existing gateway body limits already fit. */
export const CHUNK_SIZE = 5 * 1024 * 1024
/** Business codes worth retrying (e.g. "system busy"); fill in after remote tests. */
export const RETRYABLE_BUSINESS_CODES: ReadonlySet<number> = new Set<number>()
const TASK_TIMEOUT_MS = 30_000

export type UploadChannel = 'single' | 'dual'

export type UploadErrorKind =
  | 'network'          // request failed before an HTTP response
  | 'offline'          // browser reports no connectivity; wait, do not spend attempts
  | 'stalled'          // no upload progress within the stall window
  | 'response_timeout' // body sent but no response in time
  | 'auth'             // session expired or forbidden: stop the whole batch
  | 'client'           // 4xx that a retry cannot fix
  | 'server'           // 408/429/5xx
  | 'invalid_response' // 2xx with a body that is not the GPAS envelope
  | 'business'         // HTTP 2xx, envelope code != 200
  | 'mapping'          // dual task response does not match the request
  | 'cancelled'

const retryableKinds: ReadonlySet<UploadErrorKind> = new Set([
  'network', 'stalled', 'response_timeout', 'server', 'invalid_response',
])

export class UploadError extends Error {
  readonly retryable: boolean
  constructor(
    readonly kind: UploadErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'UploadError'
    this.retryable = kind === 'business'
      ? code !== undefined && RETRYABLE_BUSINESS_CODES.has(code)
      : retryableKinds.has(kind)
  }
}

export const isUploadError = (error: unknown): error is UploadError => error instanceof UploadError

export function cancelledError(): UploadError {
  return new UploadError('cancelled', '上传已取消')
}

const envelope = z.object({ code: z.number(), message: z.string().nullish(), data: z.unknown().optional() }).passthrough()
const singleTaskData = z.union([z.string().min(1), z.number()]).transform(String)
const dualTaskData = z.object({
  groupId: z.union([z.string().min(1), z.number()]).transform(String),
  fileList: z.array(z.object({
    fileId: z.union([z.string().min(1), z.number()]).transform(String),
    name: z.string(),
    endType: z.union([z.string(), z.number()]).nullish(),
  })),
})

export type TaskFileMeta = { name: string; size: number; totalPieces: number; fileMN: string }
export type DualTask = z.infer<typeof dualTaskData>

/** Maps an HTTP status to an error kind; only called for non-2xx responses. */
export function errorForStatus(status: number, label: string): UploadError {
  if (status === 401 || status === 403) return new UploadError('auth', '登录已失效或无权上传，请重新登录后再试。', status)
  if (status === 408 || status === 429 || status >= 500) return new UploadError('server', `${label}暂时失败（HTTP ${status}）`, status)
  return new UploadError('client', `${label}被拒绝（HTTP ${status}）`, status)
}

/** Validates the GPAS envelope of a 2xx response. */
export function readEnvelope(body: unknown, label: string): z.infer<typeof envelope> {
  const parsed = envelope.safeParse(body)
  if (!parsed.success) throw new UploadError('invalid_response', `${label}返回了无法识别的数据`)
  const { code, message } = parsed.data
  if (code === 401 || code === 403) throw new UploadError('auth', '登录已失效或无权上传，请重新登录后再试。', undefined, code)
  if (code !== 200) throw new UploadError('business', `${label}未成功：${message || `业务状态码 ${code}`}`, undefined, code)
  return parsed.data
}

function linkedTimeout(signal: AbortSignal, ms: number) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

async function postJson(path: string, body: unknown, label: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw cancelledError()
  const timeout = linkedTimeout(signal, TASK_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${GPAS_API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: timeout.signal,
    })
    if (!response.ok) throw errorForStatus(response.status, label)
    let payload: unknown
    try { payload = await response.json() } catch {
      throw new UploadError('invalid_response', `${label}返回了无法识别的数据`)
    }
    return readEnvelope(payload, label).data
  } catch (error) {
    if (isUploadError(error)) throw error
    if (signal.aborted) throw cancelledError()
    if (timeout.signal.aborted) throw new UploadError('response_timeout', `${label}超时`)
    throw networkError(label)
  } finally {
    timeout.dispose()
  }
}

function networkError(label: string): UploadError {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? new UploadError('offline', '网络已断开，恢复后自动继续')
    : new UploadError('network', `${label}网络连接失败`)
}

export type SliceRequest = {
  channel: UploadChannel
  uploadId: string
  fileName: string
  no: number
  chunk: Blob
  hash: string
  signal: AbortSignal
  /** Bytes of this chunk sent so far. */
  onProgress: (loaded: number) => void
  /** Abort when no upload progress happens for this long. */
  stallTimeoutMs: number
  /** Abort when the response does not arrive this long after the body is sent. */
  responseTimeoutMs: number
}

export type UploadTransport = {
  createSingleTask(input: TaskFileMeta & { sampleType: SampleKey }, signal: AbortSignal): Promise<string>
  createDualTask(input: { files: [TaskFileMeta, TaskFileMeta]; sampleType: SampleKey }, signal: AbortSignal): Promise<DualTask>
  uploadSlice(request: SliceRequest): Promise<void>
}

function uploadSliceXhr(request: SliceRequest): Promise<void> {
  const label = `分片 ${request.no}`
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) return reject(cancelledError())
    const xhr = new XMLHttpRequest()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const arm = (ms: number, kind: 'stalled' | 'response_timeout') => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(new UploadError(kind, kind === 'stalled' ? `${label}长时间无上传进度` : `${label}等待服务器响应超时`)), ms)
    }
    const onAbort = () => finish(cancelledError())
    const finish = (error?: UploadError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      if (error) {
        xhr.abort()
        reject(error)
      } else resolve()
    }

    request.signal.addEventListener('abort', onAbort, { once: true })
    const path = request.channel === 'dual' ? 'file/dual/upload' : 'file/upload'
    xhr.open('POST', `${GPAS_API_BASE}/${path}/${encodeURIComponent(request.uploadId)}`)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (event) => {
      // event.total includes multipart framing; report chunk bytes only.
      if (event.lengthComputable && event.total > 0) {
        request.onProgress(Math.min(request.chunk.size, Math.round(request.chunk.size * event.loaded / event.total)))
      }
      arm(request.stallTimeoutMs, 'stalled')
    }
    xhr.upload.onload = () => arm(request.responseTimeoutMs, 'response_timeout')
    xhr.onerror = () => finish(networkError(label))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return finish(errorForStatus(xhr.status, label))
      try {
        readEnvelope(JSON.parse(xhr.responseText), label)
      } catch (error) {
        return finish(isUploadError(error) ? error : new UploadError('invalid_response', `${label}返回了无法识别的数据`))
      }
      request.onProgress(request.chunk.size)
      finish()
    }

    const form = new FormData()
    form.append('file', request.chunk, `${request.fileName}_${request.no}.part`)
    form.append('no', String(request.no))
    form.append('hash', request.hash)
    arm(request.stallTimeoutMs, 'stalled')
    xhr.send(form)
  })
}

export const gpasUploadTransport: UploadTransport = {
  async createSingleTask(input, signal) {
    const data = await postJson('/file/task', input, '创建单端上传任务', signal)
    const parsed = singleTaskData.safeParse(data)
    if (!parsed.success) throw new UploadError('invalid_response', '创建单端上传任务返回了无法识别的数据')
    return parsed.data
  },
  async createDualTask(input, signal) {
    const data = await postJson('/file/dual/task', input, '创建双端上传任务', signal)
    const parsed = dualTaskData.safeParse(data)
    if (!parsed.success) throw new UploadError('invalid_response', '创建双端上传任务返回了无法识别的数据')
    return parsed.data
  },
  uploadSlice: uploadSliceXhr,
}

/** First 3072 bytes as base64; GPAS checks the file type from it. */
export async function buildFileMN(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 3072).arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * GPAS Web caches its status-polling gate for two hours per user and team in
 * same-origin localStorage. Dropping it after an upload makes the data status
 * page re-check immediately instead of after the cache expires.
 */
export function invalidateGpasPollingGate(userName: string | null | undefined, teamId: string | null | undefined): void {
  if (!userName) return
  try {
    localStorage.removeItem(`pollingGate_${userName}_${teamId ?? ''}`)
  } catch {
    // Storage may be unavailable (private mode); the cache simply expires.
  }
}

/** Link shown when a batch exceeds the chat limit. */
export function gpasWebUploadUrl(): string {
  return `${window.location.origin}/app/upload`
}
