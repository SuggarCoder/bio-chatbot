import OpenAI from 'openai'

import {
  advanceCachedChatContext,
  consumeGenerationRateLimit,
  getCachedChatContext,
  readMonthlyQuota,
  setCachedChatContext,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import { ArtifactStreamParser } from './artifacts/parser.js'
import {
  ArtifactCommitError,
  getArtifactForUser,
  listArtifactPromptCatalogForChat,
  type PreparedArtifactVersion,
} from './artifacts/repository.js'
import {
  ArtifactService,
  ArtifactServiceError,
  type CompletedArtifactDraft,
} from './artifacts/service.js'
import {
  buildArtifactSystemPrompt,
  type ArtifactPromptCatalogItem,
} from './artifacts/systemPrompt.js'
import {
  createGenerationStart,
  createRegenerationStart,
  findGenerationStart,
  getGenerationStartById,
  getChatContextRevision,
  getGeneration,
  isGenerationCancellationRequested,
  markGenerationStreaming,
  rebuildChatContext,
  requestGenerationCancellation,
  type Database,
  type ChatContext,
  type GenerationStart,
  type GenerationUsage,
} from './db.js'
import type {
  CancelSource,
  CurrentUser,
  GenerationDto,
  GenerationStartDto,
  MessageExecutionStep,
  StreamEvent,
} from './domain.js'
import {
  settleExecutionSteps,
  upsertExecutionStep,
} from './executionTrace.js'
import type { GenerationFinalizer } from './generationFinalizer.js'
import {
  GenerationCancellationError,
  GenerationExecutionContext,
} from './generationExecution.js'
import {
  GenerationRuntimeRegistry,
  type GenerationRuntime,
} from './generationRuntimeRegistry.js'
import {
  GenerationQueue,
  type GenerationWorkItem,
} from './generationQueue.js'
import { GenerationStreamStore } from './streamStore.js'

type StartGenerationInput = {
  user: CurrentUser
  chatId: string
  content: string
  clientMessageId: string
  ip: string
  model?: string
  artifactId?: string
  supersedesGenerationId?: string
  replacesMessageId?: string
}

type CompletedUsage = GenerationUsage

type StreamEventPayload = StreamEvent extends infer Event
  ? Event extends StreamEvent
    ? Omit<Event, 'generationId' | 'streamId' | 'messageId' | 'eventId'>
    : never
  : never

function appendContextMessage(
  context: ChatContext,
  revision: number,
  message: { seq: number; role: 'user' | 'assistant'; content: string },
): ChatContext {
  return {
    ...context,
    revision,
    lastSeq: message.seq,
    messages: [
      ...context.messages,
      { role: message.role, content: message.content },
    ].slice(-80),
  }
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

function extractUsage(response: unknown): CompletedUsage {
  const candidate = response as {
    usage?: {
      input_tokens?: unknown
      output_tokens?: unknown
      input_tokens_details?: { cached_tokens?: unknown }
      output_tokens_details?: { reasoning_tokens?: unknown }
    }
  }
  const usage = candidate.usage

  return {
    inputTokens: asNonNegativeInteger(usage?.input_tokens),
    outputTokens: asNonNegativeInteger(usage?.output_tokens),
    cachedInputTokens: asNonNegativeInteger(
      usage?.input_tokens_details?.cached_tokens,
    ),
    reasoningTokens: asNonNegativeInteger(
      usage?.output_tokens_details?.reasoning_tokens,
    ),
  }
}

export class GenerationRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'GenerationRejectedError'
  }
}

class GenerationLengthError extends Error {
  constructor() {
    super('Model output reached its configured token limit')
    this.name = 'GenerationLengthError'
  }
}

export function assertPersistableGenerationOutput(
  content: string,
  completedArtifactCount: number,
  preparedArtifactCount: number,
): void {
  if (content.trim() || preparedArtifactCount > 0) return

  if (completedArtifactCount > 0) {
    throw new ArtifactServiceError(
      'ARTIFACT_STORAGE_FAILED',
      'The generated Artifact could not be saved. Check object storage and retry.',
    )
  }

  throw new Error('Qwen returned an empty response')
}

export class GenerationService {
  private readonly qwen: OpenAI
  private readonly streams: GenerationStreamStore
  private readonly queue: GenerationQueue

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly redis: RedisClient,
    private readonly runtimes: GenerationRuntimeRegistry,
    private readonly finalizer: GenerationFinalizer,
    private readonly artifactService: ArtifactService | null = null,
  ) {
    this.qwen = new OpenAI({
      apiKey: config.qwenApiKey,
      baseURL: config.qwenBaseUrl,
      timeout: 5 * 60 * 1000,
      maxRetries: 0,
    })
    this.streams = new GenerationStreamStore(config, redis)
    this.queue = new GenerationQueue(config, redis)
  }

  async create(input: StartGenerationInput): Promise<GenerationStartDto> {
    const requestId = input.clientMessageId
    const existing = await findGenerationStart(
      this.database,
      input.user.id,
      requestId,
    )

    if (existing) {
      const generation = await getGeneration(
        this.database,
        input.user.id,
        existing.generationId,
      )

      if (!generation) {
        throw new Error('GENERATION_NOT_FOUND')
      }

      return {
        generation,
        userMessage: existing.userMessage,
        assistantMessageId: existing.assistantMessageId,
        replacesMessageId: existing.replacesMessageId ?? null,
      }
    }

    if (input.artifactId) {
      if (!this.config.artifactProtocolEnabled || !this.artifactService) {
        throw new GenerationRejectedError(
          'Artifact support is disabled',
          400,
          'artifact_disabled',
        )
      }
      const artifact = await getArtifactForUser(
        this.database,
        input.user.id,
        input.artifactId,
      )
      if (!artifact || artifact.chatId !== input.chatId) {
        throw new GenerationRejectedError(
          'Artifact not found',
          404,
          'artifact_not_found',
        )
      }
    }

    if (!this.redis.isReady) {
      throw new GenerationRejectedError(
        'Generation is temporarily unavailable',
        503,
        'redis_unavailable',
      )
    }

    const rateLimit = await consumeGenerationRateLimit(
      this.redis,
      this.config,
      input.user.id,
      input.ip,
    )
    if (!rateLimit.allowed) {
      throw new GenerationRejectedError(
        'Too many generation requests',
        429,
        'generation_rate_limited',
        rateLimit.retryAfterMs,
      )
    }

    const quota = await readMonthlyQuota(
      this.database,
      this.redis,
      this.config,
      input.user.id,
    )

    if (
      this.config.monthlyTokenLimit > 0 &&
      quota >= this.config.monthlyTokenLimit
    ) {
      throw new GenerationRejectedError(
        'Monthly token quota exceeded',
        429,
        'monthly_quota_exceeded',
      )
    }

    if (input.supersedesGenerationId) {
      await this.cancel(
        input.user.id,
        input.supersedesGenerationId,
        'superseded',
      )
    }

    const generationId = crypto.randomUUID()
    const streamId = `user:${input.user.id}:generation:${generationId}`

    let start: GenerationStart

    try {
      start = input.replacesMessageId
        ? await createRegenerationStart(this.database, {
            userId: input.user.id,
            chatId: input.chatId,
            replacesMessageId: input.replacesMessageId,
            generationId,
            streamId,
            requestId,
            provider: 'qwen',
            model: this.config.qwenModel,
            artifactId: input.artifactId,
          })
        : await createGenerationStart(this.database, {
            userId: input.user.id,
            chatId: input.chatId,
            clientMessageId: input.clientMessageId,
            content: input.content,
            generationId,
            streamId,
            requestId,
            provider: 'qwen',
            model: this.config.qwenModel,
            artifactId: input.artifactId,
          })
    } catch (error) {
      if (error instanceof Error && error.message === 'CHAT_NOT_FOUND') {
        throw new GenerationRejectedError(
          'Chat not found',
          404,
          'chat_not_found',
        )
      }

      if (
        error instanceof Error &&
        error.message === 'REGENERATION_TARGET_INVALID'
      ) {
        throw new GenerationRejectedError(
          'Only the latest assistant message can be regenerated',
          409,
          'regeneration_target_invalid',
        )
      }

      if (
        error instanceof Error &&
        error.message === 'QUEUE_LIMIT_EXCEEDED'
      ) {
        throw new GenerationRejectedError(
          'Too many generations are already queued',
          429,
          'generation_queue_limit_exceeded',
        )
      }

      const raced = await findGenerationStart(
        this.database,
        input.user.id,
        requestId,
      )

      if (raced) {
        const generation = await getGeneration(
          this.database,
          input.user.id,
          raced.generationId,
        )

        if (generation) {
          return {
            generation,
            userMessage: raced.userMessage,
            assistantMessageId: raced.assistantMessageId,
            replacesMessageId: raced.replacesMessageId ?? null,
          }
        }
      }

      throw error
    }

    const generation = await getGeneration(
      this.database,
      input.user.id,
      generationId,
    )
    if (!generation) throw new Error('GENERATION_NOT_FOUND')

    return {
      generation,
      userMessage: start.userMessage,
      assistantMessageId: start.assistantMessageId,
      replacesMessageId: start.replacesMessageId ?? null,
    }
  }

  async cancel(
    userId: string,
    generationId: string,
    source: CancelSource = 'user_stop',
  ): Promise<GenerationDto | null> {
    const generation = await requestGenerationCancellation(
      this.database,
      userId,
      generationId,
      source,
    )

    if (
      !generation ||
      ['completed', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(
        generation.status,
      )
    ) {
      return generation
    }

    this.runtimes.abort(generationId)
    await this.queue.requestCancellation(userId, generationId)

    return generation
  }

  async shutdown(): Promise<void> {
    const runtimes = this.runtimes.list()
    this.runtimes.abortAll('shutdown')
    await Promise.race([
      Promise.allSettled(
        runtimes
          .map((runtime) => runtime.completion)
          .filter(
            (completion): completion is Promise<void> =>
              Boolean(completion),
          ),
      ),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 15_000)
        timeout.unref()
      }),
    ])
  }

  async execute(item: GenerationWorkItem): Promise<void> {
    const start = await getGenerationStartById(
      this.database,
      item.user.id,
      item.generationId,
    )
    if (!start) throw new Error('GENERATION_NOT_FOUND')
    const input: StartGenerationInput = {
      user: item.user,
      chatId: item.conversationId,
      content: item.content,
      clientMessageId: item.generationId,
      ip: '',
      model: item.model,
      artifactId: item.artifactId,
      replacesMessageId: item.replacesMessageId,
    }
    const runtime: GenerationRuntime = {
      generationId: start.generationId,
      streamId: start.streamId,
      chatId: input.chatId,
      userId: input.user.id,
      controller: new AbortController(),
      partialOutput: '',
      executionSteps: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    }
    this.runtimes.register(runtime)
    runtime.completion = this.runProducer(input, start, runtime)
    await runtime.completion
  }

  private async checkpoint(
    runtime: GenerationRuntime,
    forceDatabasePoll = false,
  ): Promise<void> {
    const execution = runtime.execution ?? new GenerationExecutionContext(
      runtime.generationId,
      runtime.controller.signal,
      async () => (
        await this.queue.cancellationRequested(
          runtime.userId,
          runtime.generationId,
        ) || await isGenerationCancellationRequested(
          this.database,
          runtime.generationId,
        )
      ),
      this.config.generationCancelPollIntervalMs,
    )
    runtime.execution = execution

    try {
      await execution.checkpoint(forceDatabasePoll)
    } catch (error) {
      if (error instanceof GenerationCancellationError && !runtime.abortReason) {
        runtime.abortReason = 'cancel'
      }
      runtime.controller.abort()
      throw error
    }
  }

  private async runProducer(
    input: StartGenerationInput,
    start: GenerationStart,
    runtime: GenerationRuntime,
  ): Promise<void> {
    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    const messageId = start.assistantMessageId
    let eventId = 0
    let messageSequence = 0
    const messageParts: Array<
      | { type: 'text'; text: string }
      | { type: 'artifact_draft_ref'; streamArtifactId: string }
    > = []
    const completedDrafts: CompletedArtifactDraft[] = []
    const acceptedArtifactIds = new Set<string>()
    let preparedArtifacts: PreparedArtifactVersion[] = []
    let eventWrites = Promise.resolve()
    const snapshotTimer = setInterval(() => {
      void this.queue.saveSnapshot(
        input.user.id,
        start.generationId,
        {
          content: runtime.partialOutput,
          providerRequestId: runtime.providerRequestId,
          usage: runtime.usage,
          executionSteps: runtime.executionSteps,
          updatedAt: new Date().toISOString(),
        },
      ).catch(() => undefined)
    }, this.config.generationSnapshotIntervalMs)
    snapshotTimer.unref()

    const emit = (
      event: StreamEventPayload,
    ) => {
      eventId += 1
      const streamEvent = {
        ...event,
        generationId: start.generationId,
        streamId: start.streamId,
        messageId,
        eventId,
      } as StreamEvent
      eventWrites = eventWrites.then(() => this.streams.append(
        input.user.id,
        start.generationId,
        streamEvent,
      )).then(() => undefined).catch(() => undefined)
    }

    const updateStep = (step: MessageExecutionStep) => {
      const existing = runtime.executionSteps.find((item) => item.id === step.id)
      const now = new Date().toISOString()
      const nextStep: MessageExecutionStep = {
        ...existing,
        ...step,
        startedAt: step.startedAt ?? existing?.startedAt ?? now,
        ...(
          step.status === 'active'
            ? { completedAt: undefined }
            : { completedAt: step.completedAt ?? now }
        ),
      }
      runtime.executionSteps = upsertExecutionStep(
        runtime.executionSteps,
        nextStep,
      )
      const normalized = runtime.executionSteps.find(
        (item) => item.id === nextStep.id,
      )
      if (normalized) emit({ type: 'progress.step', step: normalized })
    }

    const completeStep = (id: string, detail?: string) => {
      const step = runtime.executionSteps.find((item) => item.id === id)
      if (!step || step.status !== 'active') return
      updateStep({
        ...step,
        status: 'completed',
        ...(detail ? { detail } : {}),
      })
    }

    const settleTrace = (completed: boolean) => {
      const previous = new Map(runtime.executionSteps.map((step) => [
        step.id,
        step.status,
      ]))
      runtime.executionSteps = settleExecutionSteps(
        runtime.executionSteps,
        completed,
      )
      for (const step of runtime.executionSteps) {
        if (previous.get(step.id) !== step.status) {
          emit({ type: 'progress.step', step })
        }
      }
    }

    let artifactStepSequence = 0
    const artifactStepIds = new Map<string, string>()
    let reasoningStepSequence = 0
    const reasoningStepIds = new Map<string, string>()
    let toolStepSequence = 0
    const toolStepIds = new Map<string, string>()
    const ensureResponseStep = () => {
      if (runtime.executionSteps.some((step) => step.id === 'response')) return
      updateStep({
        id: 'response',
        kind: 'response',
        label: '生成回答',
        status: 'active',
      })
    }

    const appendTextPart = (delta: string) => {
      if (!delta) return
      const previous = messageParts.at(-1)
      if (previous?.type === 'text') previous.text += delta
      else messageParts.push({ type: 'text', text: delta })
    }

    const artifactService = this.artifactService
    const artifactEnabled =
      this.config.artifactProtocolEnabled && artifactService !== null
    const parser = artifactEnabled
      ? new ArtifactStreamParser({
          onTextDelta: (delta) => {
            ensureResponseStep()
            const startIndex = runtime.partialOutput.length
            runtime.partialOutput += delta
            appendTextPart(delta)
            messageSequence += 1
            emit({
              type: 'message.delta',
              sequence: messageSequence,
              startIndex,
              delta,
            })
          },
          onArtifactStart: ({ streamArtifactId, metadata }) => {
            if (acceptedArtifactIds.size >= 1) {
              emit({
                type: 'artifact.error',
                artifactStreamId: streamArtifactId,
                code: 'ARTIFACT_LIMIT_EXCEEDED',
                message: 'Only one Artifact can be committed per assistant message.',
                recoverable: true,
              })
              return
            }
            acceptedArtifactIds.add(streamArtifactId)
            ensureResponseStep()
            artifactStepSequence += 1
            const artifactStepId = `artifact:${artifactStepSequence}`
            artifactStepIds.set(streamArtifactId, artifactStepId)
            updateStep({
              id: artifactStepId,
              kind: 'artifact',
              label: `生成 ${metadata.type} Artifact`,
              detail: metadata.title,
              status: 'active',
            })
            const partOrder = messageParts.length
            messageParts.push({ type: 'artifact_draft_ref', streamArtifactId })
            emit({
              type: 'artifact.start',
              artifactStreamId: streamArtifactId,
              logicalId: metadata.id,
              operation: metadata.op,
              artifactType: metadata.type,
              title: metadata.title,
              baseVersion: metadata.base_version ?? null,
              language: metadata.language ?? null,
              textStartIndex: runtime.partialOutput.length,
              partOrder,
            })
          },
          onArtifactDelta: ({ streamArtifactId, sequence, delta }) => {
            if (!acceptedArtifactIds.has(streamArtifactId)) return
            emit({
              type: 'artifact.delta',
              artifactStreamId: streamArtifactId,
              sequence,
              delta,
            })
          },
          onArtifactCommit: (draft) => {
            if (acceptedArtifactIds.has(draft.streamArtifactId)) {
              completedDrafts.push(draft)
            }
          },
          onArtifactError: ({ streamArtifactId, code, message, recoverable }) => {
            if (streamArtifactId) {
              const stepId = artifactStepIds.get(streamArtifactId)
              const step = stepId
                ? runtime.executionSteps.find((item) => item.id === stepId)
                : undefined
              if (step?.status === 'active') {
                updateStep({
                  ...step,
                  label: 'Artifact 生成已中断',
                  status: 'interrupted',
                })
              }
            }
            emit({
              type: 'artifact.error',
              artifactStreamId: streamArtifactId,
              code,
              message,
              recoverable,
            })
          },
        })
      : null

    try {
      await this.checkpoint(runtime, true)
      emit({
        type: 'message.start',
        userMessage: start.userMessage,
      })
      const producerStartedAt = new Date(startedAt).toISOString()
      updateStep({
        id: 'request',
        kind: 'request',
        label: '请求已接收',
        status: 'completed',
        startedAt: start.userMessage.createdAt,
        completedAt: start.userMessage.createdAt,
      })
      updateStep({
        id: 'queue',
        kind: 'queue',
        label: '任务排队',
        status: 'completed',
        startedAt: start.userMessage.createdAt,
        completedAt: producerStartedAt,
      })
      updateStep({
        id: 'context',
        kind: 'context',
        label: '加载会话上下文',
        status: 'active',
      })

      const revision = await getChatContextRevision(
        this.database,
        input.user.id,
        input.chatId,
      )

      if (revision === null) {
        throw new Error('Chat not found')
      }

      let context = start.contextMaxSeq === undefined
        ? await getCachedChatContext(
            this.redis,
            this.config,
            input.chatId,
          )
        : null

      if (
        context &&
        context.revision === revision - 1 &&
        start.contextMaxSeq === undefined &&
        start.userMessage.seq > context.lastSeq
      ) {
        const previousRevision = context.revision
        context = appendContextMessage(
          context,
          revision,
          start.userMessage,
        )
        const advanced = await advanceCachedChatContext(
          this.redis,
          this.config,
          previousRevision,
          context,
        )
        if (!advanced) context = null
      } else if (context?.revision !== revision) {
        context = null
      }

      if (!context) {
        context = await rebuildChatContext(
          this.database,
          input.user.id,
          input.chatId,
          start.contextMaxSeq,
        )

        if (!context) {
          throw new Error('Chat not found')
        }

        if (start.contextMaxSeq === undefined) {
          await setCachedChatContext(this.redis, this.config, context)
        }
      }

      completeStep('context', `已加载 ${context.messages.length} 条上下文消息`)

      await this.checkpoint(runtime, true)
      if (artifactEnabled) {
        updateStep({
          id: 'artifact-context',
          kind: 'artifact_context',
          label: '检查 Artifact 上下文',
          status: 'active',
        })
      }
      const artifactCatalog = artifactEnabled
        ? await listArtifactPromptCatalogForChat(
            this.database,
            input.user.id,
            input.chatId,
          )
        : []
      const artifactPromptCatalog = artifactCatalog.flatMap((artifact) =>
        artifact.logicalId && artifact.type
          ? [{
              artifactId: artifact.id,
              logicalId: artifact.logicalId,
              version: artifact.currentVersion,
              type: artifact.type,
              title: artifact.title,
            }]
          : [],
      )
      const promptText = (input.content || start.userMessage.content).toLocaleLowerCase()
      const referencedArtifacts = artifactPromptCatalog.filter((artifact) =>
        artifact.artifactId === input.artifactId ||
        promptText.includes(artifact.logicalId.toLocaleLowerCase()) ||
        (
          artifact.title.trim().length >= 2 &&
          promptText.includes(artifact.title.trim().toLocaleLowerCase())
        ),
      )
      const selectedArtifact = input.artifactId
        ? artifactPromptCatalog.find((artifact) => artifact.artifactId === input.artifactId)
        : referencedArtifacts.length === 1
          ? referencedArtifacts[0]
          : undefined
      let promptCatalog: ArtifactPromptCatalogItem[] = artifactPromptCatalog.map(
        ({ artifactId: _, ...artifact }) => artifact,
      )
      let artifactInstructions = buildArtifactSystemPrompt(promptCatalog)

      if (artifactEnabled && artifactService && selectedArtifact) {
        const content = await artifactService.readVersionContent(
          input.user.id,
          selectedArtifact.artifactId,
          selectedArtifact.version,
          32 * 1024,
          runtime.controller.signal,
        ).catch(() => null)
        promptCatalog = promptCatalog.map((artifact) =>
          artifact.logicalId === selectedArtifact.logicalId
            ? { ...artifact, content }
            : artifact,
        )
        const candidate = buildArtifactSystemPrompt(promptCatalog)
        artifactInstructions = Buffer.byteLength(candidate, 'utf8') <= 48 * 1024
          ? candidate
          : buildArtifactSystemPrompt(promptCatalog.map((artifact) => ({
              ...artifact,
              content: artifact.logicalId === selectedArtifact.logicalId
                ? null
                : artifact.content,
            })))
      }
      if (artifactEnabled) {
        completeStep(
          'artifact-context',
          selectedArtifact
            ? `已载入 ${selectedArtifact.type} Artifact`
            : `发现 ${artifactPromptCatalog.length} 个可用 Artifact`,
        )
      }
      updateStep({
        id: 'model',
        kind: 'model',
        label: '连接模型服务',
        status: 'active',
      })
      const markedRunning = await markGenerationStreaming(
        this.database,
        start.generationId,
      )
      if (!markedRunning) await this.checkpoint(runtime, true)
      const responseStream = await this.qwen.responses.create(
        {
          model: input.model ?? this.config.qwenModel,
          instructions: artifactEnabled
            ? artifactInstructions
            : undefined,
          input: context.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          max_output_tokens: this.config.qwenMaxOutputTokens,
          stream: true,
        },
        { signal: runtime.controller.signal },
      )
      await this.checkpoint(runtime, true)

      for await (const event of responseStream) {
        await this.checkpoint(runtime)
        const providerEvent = event as unknown as {
          type: string
          item?: { id?: string; type?: string; name?: string }
        }

        if (event.type === 'response.created') {
          completeStep('model', '模型服务已连接')
          runtime.providerRequestId = event.response.id
          const marked = await markGenerationStreaming(
            this.database,
            start.generationId,
            runtime.providerRequestId,
          )

          if (!marked) {
            await this.checkpoint(runtime, true)
          }
        } else if (providerEvent.type === 'response.output_item.added') {
          const item = providerEvent.item
          const itemType = item?.type ?? ''
          const itemKey = item?.id ?? `${itemType}:${eventId}`

          if (itemType === 'reasoning') {
            completeStep('model', '模型服务已连接')
            reasoningStepSequence += 1
            const stepId = `reasoning:${reasoningStepSequence}`
            reasoningStepIds.set(itemKey, stepId)
            updateStep({
              id: stepId,
              kind: 'reasoning',
              label: '分析并组织回答',
              status: 'active',
            })
          } else if (
            itemType === 'function_call' ||
            itemType.endsWith('_call')
          ) {
            toolStepSequence += 1
            const stepId = `tool:${toolStepSequence}`
            toolStepIds.set(itemKey, stepId)
            const toolName = itemType === 'web_search_call'
              ? 'web_search'
              : itemType === 'file_search_call'
                ? 'file_analysis'
                : item?.name === 'database_query'
                  ? 'database_query'
                  : 'tool'
            updateStep({
              id: stepId,
              kind: 'tool',
              label: toolName === 'web_search'
                ? '搜索相关信息'
                : toolName === 'file_analysis'
                  ? '分析文件'
                  : toolName === 'database_query'
                    ? '查询数据'
                    : '调用工具',
              status: 'active',
            })
            emit({
              type: 'tool.start',
              toolRunId: stepId,
              toolName,
            })
          }
        } else if (providerEvent.type === 'response.output_item.done') {
          const item = providerEvent.item
          const itemType = item?.type ?? ''
          const itemKey = item?.id ?? ''
          const reasoningStepId = reasoningStepIds.get(itemKey) ??
            [...runtime.executionSteps].reverse().find(
              (step) => step.kind === 'reasoning' && step.status === 'active',
            )?.id
          const toolStepId = toolStepIds.get(itemKey) ??
            [...runtime.executionSteps].reverse().find(
              (step) => step.kind === 'tool' && step.status === 'active',
            )?.id

          if (itemType === 'reasoning' && reasoningStepId) {
            completeStep(reasoningStepId)
          } else if (toolStepId) {
            completeStep(toolStepId)
            emit({
              type: 'tool.result',
              toolRunId: toolStepId,
              toolName: 'tool',
            })
          }
        } else if (event.type === 'response.output_text.delta') {
          completeStep('model', '模型服务已连接')
          for (const step of runtime.executionSteps) {
            if (step.kind === 'reasoning' && step.status === 'active') {
              completeStep(step.id)
            }
          }
          ensureResponseStep()
          if (firstTokenAt === null) {
            firstTokenAt = Date.now()
          }

          if (parser) {
            parser.push(event.delta)
          } else {
            const startIndex = runtime.partialOutput.length
            runtime.partialOutput += event.delta
            appendTextPart(event.delta)
            messageSequence += 1
            emit({
              type: 'message.delta',
              sequence: messageSequence,
              startIndex,
              delta: event.delta,
            })
          }
        } else if (event.type === 'response.completed') {
          runtime.providerRequestId = event.response.id
          runtime.usage = extractUsage(event.response)
        } else if (event.type === 'response.incomplete') {
          runtime.providerRequestId = event.response.id
          runtime.usage = extractUsage(event.response)
          throw new GenerationLengthError()
        } else if (event.type === 'response.failed') {
          throw new Error(
            event.response.error?.message || 'Qwen generation failed',
          )
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Qwen stream failed')
        }
      }

      await this.checkpoint(runtime, true)
      parser?.finish()

      if (this.artifactService) {
        for (const draft of completedDrafts) {
          try {
            preparedArtifacts.push(await this.artifactService.prepare(
              input.user.id,
              input.chatId,
              draft,
              runtime.controller.signal,
            ))
          } catch (error) {
            const failure = error instanceof ArtifactServiceError
              ? error
              : new ArtifactServiceError(
                  'ARTIFACT_STORAGE_FAILED',
                  'Artifact could not be prepared.',
                  { cause: error },
                )
            emit({
              type: 'artifact.error',
              artifactStreamId: draft.streamArtifactId,
              code: failure.code,
              message: failure.message,
              recoverable: true,
            })
            const stepId = artifactStepIds.get(draft.streamArtifactId)
            const step = stepId
              ? runtime.executionSteps.find((item) => item.id === stepId)
              : undefined
            if (step?.status === 'active') {
              updateStep({
                ...step,
                label: 'Artifact 保存已中断',
                status: 'interrupted',
              })
            }
          }
        }
      }

      assertPersistableGenerationOutput(
        runtime.partialOutput,
        completedDrafts.length,
        preparedArtifacts.length,
      )
      completeStep('model', '模型服务已连接')
      for (const step of [...runtime.executionSteps]) {
        if (step.kind === 'reasoning' && step.status === 'active') {
          completeStep(step.id)
        }
      }
      completeStep('response')

      await this.checkpoint(runtime, true)
      const result = await this.finalizer.finalize({
        generationId: start.generationId,
        userId: input.user.id,
        desiredStatus: 'completed',
        content: runtime.partialOutput,
        messageId,
        messageParts,
        preparedArtifacts,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: 'completed',
        executionSteps: runtime.executionSteps,
      })

      const previousStepStatuses = new Map(runtime.executionSteps.map((step) => [
        step.id,
        step.status,
      ]))
      runtime.executionSteps = result.assistantMessage?.executionSteps ??
        settleExecutionSteps(
          runtime.executionSteps,
          result.generation.status === 'completed',
        )
      for (const step of runtime.executionSteps) {
        if (previousStepStatuses.get(step.id) !== step.status) {
          emit({ type: 'progress.step', step })
        }
      }

      if (
        start.contextMaxSeq === undefined &&
        result.newlyFinalized &&
        result.generation.status === 'completed'
      ) {
        const finalRevision = await getChatContextRevision(
          this.database,
          input.user.id,
          input.chatId,
        )
        if (finalRevision !== null) {
          const nextContext = result.assistantMessage
            ? appendContextMessage(
                context,
                finalRevision,
                {
                  seq: result.assistantMessage.seq,
                  role: 'assistant',
                  content: result.assistantMessage.content,
                },
              )
            : { ...context, revision: finalRevision }
          await advanceCachedChatContext(
            this.redis,
            this.config,
            context.revision,
            nextContext,
          ).catch(() => false)
        }
      }

      if (
        result.generation.status !== 'completed' &&
        preparedArtifacts.length > 0
      ) {
        await this.artifactService?.cleanup(preparedArtifacts)
        preparedArtifacts = []
      }

      if (result.generation.status === 'completed') {
        for (const artifact of result.committedArtifacts) {
          emit({
            type: 'artifact.commit',
            artifactStreamId: artifact.streamArtifactId,
            artifactId: artifact.artifactId,
            logicalId: artifact.logicalId,
            version: artifact.version,
            sha256: artifact.sha256,
            byteLength: artifact.byteLength,
          })
        }
      }
      emit({
        type: 'message.finish',
        finishReason: result.generation.status === 'cancelled'
          ? 'cancelled'
          : 'stop',
        assistantMessage: result.assistantMessage,
      })
      await eventWrites
    } catch (error) {
      const timedOut = runtime.abortReason === 'timeout'
      const interrupted = ['lease_lost', 'shutdown'].includes(
        runtime.abortReason ?? '',
      )
      const cancelled = runtime.abortReason === 'cancel' ||
        (error instanceof GenerationCancellationError && !timedOut && !interrupted)
      const lengthLimited = error instanceof GenerationLengthError
      const message =
        error instanceof Error ? error.message : 'Generation failed'
      if (lengthLimited) parser?.finish()
      else parser?.abort(cancelled ? 'Artifact generation was stopped.' : message)
      settleTrace(false)
      if (preparedArtifacts.length > 0) {
        await this.artifactService?.cleanup(preparedArtifacts)
      }
      if (error instanceof ArtifactCommitError) {
        for (const prepared of preparedArtifacts) {
          emit({
            type: 'artifact.error',
            artifactStreamId: prepared.streamArtifactId,
            code: error.code,
            message: error.message,
            recoverable: true,
          })
        }
      }
      const result = await this.finalizer.finalize({
        generationId: start.generationId,
        userId: input.user.id,
        desiredStatus: timedOut
          ? 'timed_out'
          : interrupted
            ? 'interrupted'
            : 'failed',
        content: runtime.partialOutput,
        messageId,
        messageParts,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: timedOut
          ? 'timed_out'
          : interrupted
            ? 'interrupted'
            : cancelled
              ? 'cancelled'
              : lengthLimited
                ? 'length'
                : 'failed',
        errorCode: timedOut
          ? 'generation_timed_out'
          : interrupted
            ? 'generation_interrupted'
            : cancelled
              ? 'generation_cancelled'
              : lengthLimited
                ? 'generation_length'
                : error instanceof ArtifactServiceError
                  ? error.code.toLocaleLowerCase()
                  : 'generation_failed',
        errorMessage: message,
        executionSteps: runtime.executionSteps,
      })

      emit({
        type: 'message.finish',
        finishReason: result.generation.status === 'cancelled'
          ? 'cancelled'
          : lengthLimited
            ? 'length'
            : 'error',
        assistantMessage: result.assistantMessage,
        error: result.generation.status === 'cancelled'
          ? undefined
          : {
              code: result.generation.errorCode ?? 'generation_failed',
              message: result.generation.errorMessage ?? message,
        },
      })
      await eventWrites
    } finally {
      clearInterval(snapshotTimer)
      this.runtimes.delete(start.generationId)
    }
  }
}
