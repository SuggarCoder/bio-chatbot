import {
  anySignal,
  fullJitterDelay,
  isAbortError,
  parseRetryAfter,
  pollDelay,
  pollSleep,
  sleep,
  type Random,
} from './backoff'
import type { FileResultPage, FileResultQuery, GpasDetailPart, GpasDetailRequest, GpasPart, GpasUploadBatch, GpasUploadPart, ProjectInput, SampleKey } from '../../../server/gpasContracts'
export type { GpasDetailRequest, GpasPart, GpasUploadBatch, GpasUploadPart, ProjectInput } from '../../../server/gpasContracts'

const API_BASE = `${import.meta.env?.BASE_URL ?? '/ai-chatbot/'}api`

export type CurrentUserDto = {
  id: string
  externalUserId: string
  externalTeamId: string | null
  realName: string | null
  userName: string | null
  jobTitle: string | null
  researchField: string | null
  email: string | null
  name: string | null
  image: string | null
  gpas2Role: number | null
  serviceTier: 'free' | 'pro' | 'enterprise'
  schedulingWeight: number
  generationConcurrencyLimit: number
  maxQueuedGenerations: number
}

export type ChatMessageDto = {
  id: string
  seq: number
  role: 'user' | 'assistant'
  status: 'pending' | 'streaming' | 'completed' | 'cancelled' | 'failed'
  content: string
  parts: Array<
    | GpasPart
    | GpasUploadPart
    | GpasDetailPart
    | { type: 'text'; order: number; text: string }
    | {
        type: 'artifact_ref'
        order: number
        artifactId: string
        logicalId: string
        version: number
      }
  >
  createdAt: string
  vote: 'up' | 'down' | null
  executionSteps: Array<{
    id: string
    kind?:
      | 'request'
      | 'queue'
      | 'context'
      | 'artifact_context'
      | 'model'
      | 'reasoning'
      | 'tool'
      | 'artifact'
      | 'response'
    label: string
    status: 'active' | 'completed' | 'interrupted'
    detail?: string
    startedAt?: string
    completedAt?: string
  }>
}

export type GenerationDto = {
  id: string
  chatId: string
  streamId: string
  status:
    | 'created'
    | 'queued'
    | 'scheduled'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'timed_out'
  effectiveStatus:
    | 'created'
    | 'queued'
    | 'scheduled'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'timed_out'
  cancelRequestedAt: string | null
  cancelSource:
    | 'user_stop'
    | 'superseded'
    | 'timeout'
    | 'server_shutdown'
    | 'system'
    | null
}

export type ChatSummaryDto = {
  id: string
  title: string
  chatType: string
  status: string
  createdAt: string
  updatedAt: string
}

export type ChatDetailDto = ChatSummaryDto & {
  messages: ChatMessageDto[]
  pageInfo: ChatMessagePageInfo
  activeGeneration: {
    id: string
    streamId: string
    status: 'created' | 'queued' | 'scheduled' | 'running' | 'cancelling'
    replacesMessageId: string | null
  } | null
}

export type ChatMessagePageInfo = {
  hasMore: boolean
  beforeSeq: number | null
}

export type ChatMessagePageDto = {
  messages: ChatMessageDto[]
  pageInfo: ChatMessagePageInfo
}

export type SharedConversationDto = {
  id: string
  title: string
  shareMode: 'snapshot' | 'live'
  messages: ChatMessageDto[]
}

type ApiErrorBody = {
  error?: {
    code?: string
    message?: string
  }
}

let loginRedirectStarted = false

export class ChatApiError extends Error {
  status: number
  code: string
  /** From a Retry-After response header, when the server sent one. */
  retryAfterMs?: number

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ChatApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export async function parseApiError(response: Response): Promise<ChatApiError> {
  let payload: ApiErrorBody = {}

  try {
    payload = (await response.json()) as ApiErrorBody
  } catch {
    // Fall back to the HTTP status below.
  }

  const error = new ChatApiError(
    response.status,
    payload.error?.code || 'request_failed',
    payload.error?.message || `HTTP ${response.status}`,
    parseRetryAfter(response.headers.get('retry-after')),
  )

  if (
    response.status === 401 &&
    !loginRedirectStarted &&
    typeof window !== 'undefined'
  ) {
    loginRedirectStarted = true
    window.location.assign('/login')
  }

  return error
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers)

  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })

  if (!response.ok) {
    throw await parseApiError(response)
  }

  return response.json() as Promise<T>
}

export function fetchCurrentUser() {
  return requestJson<CurrentUserDto>('/me')
}

/** Sample types the team can upload, from the GPAS project status tool. */
export function fetchUploadSampleTypes() {
  return requestJson<{ initialized: boolean; types: SampleKey[] }>('/gpas/upload/sample-types')
}

/** One page of a sample's analysis detail, via the server's file.result tool. */
export function fetchGpasFileResults(query: FileResultQuery, signal?: AbortSignal) {
  const params = new URLSearchParams({ taskId: query.taskId })
  if (query.speciesType) params.set('speciesType', query.speciesType)
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  return requestJson<FileResultPage>(`/gpas/file/results?${params}`, { signal })
}

export async function fetchChats() {
  const result = await requestJson<{ conversations: ChatSummaryDto[] }>(
    '/conversations',
  )
  return result.conversations
}

/** `id` is chosen by the client; repeating the request returns the same chat. */
export function createChat(title: string, id: string) {
  return requestJson<ChatSummaryDto>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ id, title }),
  })
}

export type MemorySettingsDto = {
  memoryEnabled: boolean
  chatSearchEnabled: boolean
}

export function fetchMemorySettings() {
  return requestJson<MemorySettingsDto>('/memory/settings')
}

export function updateMemorySettings(settings: Partial<MemorySettingsDto>) {
  return requestJson<MemorySettingsDto>('/memory/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
}

async function requestNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include' })
  if (!response.ok) throw await parseApiError(response)
}

export function deleteAllMemories() {
  return requestNoContent('/memory', { method: 'DELETE' })
}

export async function fetchChat(chatId: string, signal?: AbortSignal) {
  const pending = await retryRequest(
    () => requestJson<{ requests: RequestTicket<unknown>[] }>(
      `/conversations/${encodeURIComponent(chatId)}/requests`,
      { signal },
    ),
    { signal },
  )
  await Promise.all(pending.requests.map(ticket => waitForRequest(ticket, signal)))
  return requestJson<ChatDetailDto>(
    `/conversations/${encodeURIComponent(chatId)}`,
    { signal },
  )
}

export function fetchSharedConversation(shareSlug: string) {
  return requestJson<SharedConversationDto>(
    `/shared/conversations/${encodeURIComponent(shareSlug)}`,
  )
}

export function fetchChatMessages(
  chatId: string,
  beforeSeq: number,
  limit = 50,
) {
  const params = new URLSearchParams({
    beforeSeq: String(beforeSeq),
    limit: String(limit),
  })
  return requestJson<ChatMessagePageDto>(
    `/conversations/${encodeURIComponent(chatId)}/messages?${params}`,
  )
}

export function renameChat(chatId: string, title: string) {
  return requestJson<ChatSummaryDto>(
    `/conversations/${encodeURIComponent(chatId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    },
  )
}

export async function deleteChat(chatId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(chatId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
    },
  )

  if (!response.ok) {
    throw await parseApiError(response)
  }
}

export function generationUrl(chatId: string) {
  return `${API_BASE}/conversations/${encodeURIComponent(chatId)}/messages`
}

type RequestTicket<T> = { id: string; status: string; result: T | null; error: { code: string; message: string } | null }

export type RetryOptions = {
  signal?: AbortSignal
  /** Attempts including the first. */
  maxAttempts?: number
  baseMs?: number
  capMs?: number
  random?: Random
}

/** Retryable: a lost connection, a request timeout, a 5xx. Never the caller's abort or a 4xx. */
function isRetryableRequestError(error: unknown) {
  if (error instanceof ChatApiError) return error.status >= 500
  return !isAbortError(error)
}

/**
 * Retries with full-jitter exponential backoff (500 ms doubling to 8 s, six
 * attempts), honouring Retry-After. The operation must be idempotent: the
 * callers reuse one idempotency key, which also covers an acceptance response
 * lost after the server committed.
 */
export async function retryRequest<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 6
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt + 1 >= maxAttempts ||
        !isRetryableRequestError(error)
      ) {
        throw error
      }
      const backoff = fullJitterDelay(attempt, {
        baseMs: options.baseMs ?? 500,
        capMs: options.capMs ?? 8_000,
        random: options.random,
      })
      const retryAfter = error instanceof ChatApiError ? error.retryAfterMs : undefined
      await sleep(
        retryAfter === undefined ? backoff : Math.max(retryAfter, backoff),
        options.signal,
      )
    }
  }
}

const REQUEST_TIMEOUT_MS = 15_000
const REQUEST_WAIT_MS = 30 * 60_000

async function waitForRequest<T>(
  ticket: RequestTicket<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + REQUEST_WAIT_MS
  for (let attempt = 0; ticket.status === 'queued' || ticket.status === 'running'; attempt++) {
    if (Date.now() > deadline) throw new Error('请求仍在后台排队，请稍后重新打开会话查看结果。')
    // 2 s growing to 15 s; a hidden tab waits until it is visible again.
    await pollSleep(pollDelay(attempt, { baseMs: 2_000, capMs: 15_000 }), signal)
    const ticketId = ticket.id
    ticket = await retryRequest(
      () => requestJson<RequestTicket<T>>(
        `/requests/${encodeURIComponent(ticketId)}`,
        { signal: anySignal([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
      ),
      { signal },
    )
  }
  if (ticket.status !== 'succeeded' || !ticket.result) throw new Error(ticket.error?.message ?? '请求处理失败')
  return ticket.result
}

export async function createGeneration(
  chatId: string,
  input: {
    content: string
    clientMessageId: string
    artifactId?: string
    supersedesGenerationId?: string
    projectInput?: ProjectInput
    uploads?: GpasUploadBatch
    detail?: GpasDetailRequest
  },
  signal?: AbortSignal,
) {
  type Result = {
    kind: 'business'
    userMessage: ChatMessageDto
    assistantMessage: ChatMessageDto
  } | {
    generation: GenerationDto
    userMessage: ChatMessageDto
    assistantMessageId: string
    replacesMessageId: string | null
  }
  const accepted = await retryRequest(() => requestJson<Result | RequestTicket<Result>>(
    `/conversations/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'POST',
      signal: anySignal([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: { 'Idempotency-Key': input.clientMessageId },
      body: JSON.stringify({
        content: input.content,
        artifactId: input.artifactId,
        supersedesGenerationId: input.supersedesGenerationId,
        projectInput: input.projectInput,
        uploads: input.uploads,
        detail: input.detail,
      }),
    },
  ), { signal })
  return 'status' in accepted ? waitForRequest(accepted, signal) : accepted
}

export type GenerationStatusDto = GenerationDto & {
  streamAvailable: boolean
  assistantMessage: ChatMessageDto | null
}

/** The generation's status row: a few hundred bytes, unlike the whole conversation. */
export function fetchGeneration(generationId: string, signal?: AbortSignal) {
  return requestJson<GenerationStatusDto>(
    `/generations/${encodeURIComponent(generationId)}`,
    { signal: anySignal([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
  )
}

export function isTerminalGenerationStatus(status: GenerationDto['status']) {
  return status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    status === 'timed_out'
}

export function regenerateMessage(
  messageId: string,
  requestId: string,
  artifactId?: string,
) {
  return requestJson<{
    generation: GenerationDto
    userMessage: ChatMessageDto
    assistantMessageId: string
    replacesMessageId: string | null
  }>(`/messages/${encodeURIComponent(messageId)}/regenerations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId },
    body: JSON.stringify({ artifactId }),
  })
}

export async function setMessageVote(messageId: string, vote: 'up' | 'down') {
  const result = await requestJson<{ vote: 'up' | 'down' }>(
    `/messages/${encodeURIComponent(messageId)}/vote`,
    {
      method: 'PUT',
      body: JSON.stringify({ isUpvoted: vote === 'up' }),
    },
  )
  return result.vote
}

export async function deleteMessageVote(messageId: string): Promise<null> {
  const response = await fetch(
    `${API_BASE}/messages/${encodeURIComponent(messageId)}/vote`,
    { method: 'DELETE', credentials: 'include' },
  )

  if (!response.ok) {
    throw await parseApiError(response)
  }

  return null
}

export function cancelGeneration(generationId: string) {
  return requestJson<GenerationDto>(
    `/generations/${encodeURIComponent(generationId)}/cancel`,
    {
      method: 'POST',
    },
  )
}

export function streamUrl(generationId: string) {
  return `${API_BASE}/generations/${encodeURIComponent(generationId)}/stream`
}
