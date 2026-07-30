export type Gpas2UserInfo = {
  userId: string
  realName?: string
  userName?: string
  ownteamId?: string
  ownteamName?: string
  email?: string
  phone?: string
  status?: number
  jobTitle?: string
  researchField?: string
  role?: number
  image?: string
  [key: string]: unknown
}

export type CurrentUser = {
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

export type ActiveGenerationDto = {
  id: string
  streamId: string
  status: 'pending' | 'streaming'
}

export type GenerationDto = {
  id: string
  chatId: string | null
  streamId: string | null
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  finishedAt: string | null
}

export type ChatDetailDto = ChatSummaryDto & {
  messages: ChatMessageDto[]
  activeGeneration: ActiveGenerationDto | null
}

export type StreamEvent =
  | {
      type: 'start'
      generationId: string
      streamId: string
      userMessage: ChatMessageDto
    }
  | {
      type: 'text-delta'
      delta: string
    }
  | {
      type: 'done'
      generationId: string
      assistantMessage: ChatMessageDto
    }
  | {
      type: 'error'
      generationId: string
      code: string
      message: string
    }
