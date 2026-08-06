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
  serviceTier: 'free' | 'pro' | 'enterprise'
  schedulingWeight: number
  generationConcurrencyLimit: number
  maxQueuedGenerations: number
}

export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed'
export type GenerationStatus =
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
export type EffectiveGenerationStatus = GenerationStatus
export type CancelSource =
  | 'user_stop'
  | 'superseded'
  | 'timeout'
  | 'server_shutdown'
  | 'system'

export type ExecutionStepKind =
  | 'request'
  | 'queue'
  | 'context'
  | 'artifact_context'
  | 'model'
  | 'reasoning'
  | 'tool'
  | 'artifact'
  | 'response'

export type MessageExecutionStep = {
  id: string
  kind?: ExecutionStepKind
  label: string
  status: 'active' | 'completed' | 'interrupted'
  detail?: string
  startedAt?: string
  completedAt?: string
}

export type ChatMessageDto = {
  id: string
  seq: number
  role: 'user' | 'assistant'
  status: MessageStatus
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
  executionSteps: MessageExecutionStep[]
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
  status: 'created' | 'queued' | 'scheduled' | 'running' | 'cancelling'
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
  assistantMessageId: string
  replacesMessageId: string | null
}

export type ChatDetailDto = ChatSummaryDto & {
  messages: ChatMessageDto[]
  pageInfo: ChatMessagePageInfo
  activeGeneration: ActiveGenerationDto | null
}

export type ChatMessagePageInfo = {
  hasMore: boolean
  beforeSeq: number | null
}

export type ChatMessagePageDto = {
  messages: ChatMessageDto[]
  pageInfo: ChatMessagePageInfo
}

type StreamIdentity = {
  generationId: string
  streamId: string
  messageId: string
  eventId: number
}

export type StreamEvent =
  | StreamIdentity & {
      type: 'message.start'
      userMessage: ChatMessageDto
    }
  | StreamIdentity & {
      type: 'message.delta'
      sequence: number
      startIndex: number
      delta: string
    }
  | StreamIdentity & {
      type: 'artifact.start'
      artifactStreamId: string
      logicalId: string
      operation: 'create' | 'replace'
      artifactType: string
      title: string
      baseVersion: number | null
      language: string | null
      textStartIndex: number
      partOrder: number
    }
  | StreamIdentity & {
      type: 'artifact.delta'
      artifactStreamId: string
      sequence: number
      delta: string
    }
  | StreamIdentity & {
      type: 'artifact.commit'
      artifactStreamId: string
      artifactId: string
      logicalId: string
      version: number
      sha256: string
      byteLength: number
    }
  | StreamIdentity & {
      type: 'artifact.error'
      artifactStreamId?: string
      code: string
      message: string
      recoverable: boolean
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
      type: 'progress.step'
      step: MessageExecutionStep
    }
  | StreamIdentity & {
      type: 'message.finish'
      finishReason: 'stop' | 'cancelled' | 'error' | 'length'
      assistantMessage: ChatMessageDto | null
      error?: { code: string; message: string }
    }
