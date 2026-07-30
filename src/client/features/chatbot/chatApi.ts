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
  content: string
  createdAt: string
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
    status: 'pending' | 'streaming'
  } | null
}

type ApiErrorBody = {
  error?: {
    code?: string
    message?: string
  }
}

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

  return new ChatApiError(
    response.status,
    payload.error?.code || 'request_failed',
    payload.error?.message || `HTTP ${response.status}`,
  )
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
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

export function streamUrl(streamId: string, resumeAt: number) {
  const params = new URLSearchParams({
    resumeAt: String(resumeAt),
  })
  return `${API_BASE}/streams/${encodeURIComponent(streamId)}?${params}`
}
