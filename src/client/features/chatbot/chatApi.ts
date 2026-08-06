const API_BASE = `${import.meta.env.BASE_URL}api`

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
    label: string
    status: 'active' | 'completed' | 'interrupted'
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

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ChatApiError'
    this.status = status
    this.code = code
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

export async function fetchChats() {
  const result = await requestJson<{ conversations: ChatSummaryDto[] }>(
    '/conversations',
  )
  return result.conversations
}

export function createChat(title: string) {
  return requestJson<ChatSummaryDto>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function fetchChat(chatId: string) {
  return requestJson<ChatDetailDto>(
    `/conversations/${encodeURIComponent(chatId)}`,
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

export function createGeneration(
  chatId: string,
  input: {
    content: string
    clientMessageId: string
    artifactId?: string
    supersedesGenerationId?: string
  },
) {
  return requestJson<{
    generation: GenerationDto
    userMessage: ChatMessageDto
    assistantMessageId: string
    replacesMessageId: string | null
  }>(
    `/conversations/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': input.clientMessageId },
      body: JSON.stringify({
        content: input.content,
        artifactId: input.artifactId,
        supersedesGenerationId: input.supersedesGenerationId,
      }),
    },
  )
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
