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

export type MessageStatus = 'completed' | 'cancelled' | 'failed'
export type GenerationStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type EffectiveGenerationStatus =
  | GenerationStatus
  | 'cancelling'
export type CancelSource =
  | 'user_stop'
  | 'superseded'
  | 'timeout'
  | 'server_shutdown'
  | 'system'

export type ChatMessageDto = {
  id: string
  seq: number
  role: 'user' | 'assistant'
  status: MessageStatus
  content: string
  createdAt: string
  vote: 'up' | 'down' | null
  executionSteps: Array<{
    id: string
    label: string
    status: 'active' | 'completed' | 'interrupted'
  }>
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
  status: 'pending' | 'streaming' | 'cancelling'
  replacesMessageId: string | null
}

export type GenerationDto = {
  id: string
  chatId: string | null
  streamId: string | null
  status: GenerationStatus
  effectiveStatus: EffectiveGenerationStatus
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  cancelRequestedAt: string | null
  cancelSource: CancelSource | null
  createdAt: string
  finishedAt: string | null
}

export type GenerationStartDto = {
  generation: GenerationDto
  userMessage: ChatMessageDto
  replacesMessageId: string | null
}

export type ChatDetailDto = ChatSummaryDto & {
  messages: ChatMessageDto[]
  activeGeneration: ActiveGenerationDto | null
}

type StreamIdentity = {
  generationId: string
  streamId: string
}

export type StreamEvent =
  | StreamIdentity & {
      type: 'generation.start'
      userMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'text.delta'
      startIndex: number
      delta: string
    }
  | StreamIdentity & {
      type: 'tool.start'
      toolRunId: string
      toolName: string
    }
  | StreamIdentity & {
      type: 'tool.result'
      toolRunId: string
      toolName: string
    }
  | StreamIdentity & {
      type: 'generation.completed'
      assistantMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'generation.cancelled'
      assistantMessage: ChatMessageDto | null
    }
  | StreamIdentity & {
      type: 'generation.failed'
      code: string
      message: string
      assistantMessage: ChatMessageDto | null
    }
