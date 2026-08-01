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
}

export type ChatMessageDto = {
  id: string
  seq: number
  role: 'user' | 'assistant'
  status: 'completed' | 'cancelled' | 'failed'
  content: string
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
  chatId: string | null
  streamId: string | null
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  effectiveStatus:
    | 'pending'
    | 'streaming'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
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
  activeGeneration: {
    id: string
    streamId: string
    status: 'pending' | 'streaming' | 'cancelling'
    replacesMessageId: string | null
  } | null
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
  const result = await requestJson<{ chats: ChatSummaryDto[] }>('/chats')
  return result.chats
}

export function createChat(title: string) {
  return requestJson<ChatSummaryDto>('/chats', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function fetchChat(chatId: string) {
  return requestJson<ChatDetailDto>(
    `/chats/${encodeURIComponent(chatId)}`,
  )
}

export function renameChat(chatId: string, title: string) {
  return requestJson<ChatSummaryDto>(
    `/chats/${encodeURIComponent(chatId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    },
  )
}

export async function deleteChat(chatId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/chats/${encodeURIComponent(chatId)}`,
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
  return `${API_BASE}/chats/${encodeURIComponent(chatId)}/generations`
}

export function createGeneration(
  chatId: string,
  input: {
    content: string
    clientMessageId: string
    supersedesGenerationId?: string
  },
) {
  return requestJson<{
    generation: GenerationDto
    userMessage: ChatMessageDto
    replacesMessageId: string | null
  }>(
    `/chats/${encodeURIComponent(chatId)}/generations`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export function regenerateMessage(messageId: string, requestId: string) {
  return requestJson<{
    generation: GenerationDto
    userMessage: ChatMessageDto
    replacesMessageId: string | null
  }>(`/messages/${encodeURIComponent(messageId)}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ requestId }),
  })
}

export function setMessageVote(messageId: string, isUpvoted: boolean) {
  return requestJson<{ vote: 'up' | 'down' }>(
    `/messages/${encodeURIComponent(messageId)}/vote`,
    {
      method: 'PUT',
      body: JSON.stringify({ isUpvoted }),
    },
  )
}

export async function deleteMessageVote(messageId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/messages/${encodeURIComponent(messageId)}/vote`,
    { method: 'DELETE', credentials: 'include' },
  )

  if (!response.ok) {
    throw await parseApiError(response)
  }
}

export function cancelGeneration(generationId: string) {
  return requestJson<GenerationDto>(
    `/generations/${encodeURIComponent(generationId)}/cancel`,
    {
      method: 'POST',
    },
  )
}

export function streamUrl(generationId: string, resumeAt: number) {
  const params = new URLSearchParams({
    resumeAt: String(resumeAt),
  })
  return `${API_BASE}/generations/${encodeURIComponent(generationId)}/stream?${params}`
}
