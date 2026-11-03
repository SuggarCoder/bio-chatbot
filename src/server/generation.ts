import { modelBudgetFetch } from './modelBudget.js'
import { assertTokenQuota } from './tokenQuota.js'
import OpenAI from 'openai'

import {
  advanceCachedChatContext,
  consumeGenerationRateLimit,
  getCachedBudgetedChatContext,
  getCachedChatContext,
  setCachedChatContext,
  setCachedBudgetedChatContext,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import { buildBudgetedChatContext } from './conversationMemory.js'
import { enqueueBackgroundJob } from './backgroundJobs.js'
import {
  buildUserMemoryInstructions,
  resolveMemoryAccess,
} from './userMemory.js'
import { createMemoryToolRunner } from './agent/memoryTools.js'
import { createEmbedder, type Embedder } from './embeddings.js'
import {
  assembleArtifactContext,
  type AssembledArtifactContext,
} from './artifacts/context.js'
import { createPatchedArtifactDraft } from './artifacts/patch.js'
import { ArtifactStreamParser } from './artifacts/parser.js'
import { createModelSectionSelector } from './artifacts/sectionSelector.js'
import type { ArtifactMimeType } from './artifacts/protocol.js'
import {
  ArtifactCommitError,
  getArtifactForUser,
  type PreparedArtifactVersion,
} from './artifacts/repository.js'
import {
  ArtifactService,
  ArtifactServiceError,
  type CompletedArtifactDraft,
} from './artifacts/service.js'
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
  recordToolRun,
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
import { fitInputBudget, QwenTokenCounter, type TokenCounter } from './tokenBudget.js'
import { metrics } from './metrics.js'
import {
  GenerationByteBudget,
  GenerationByteLimitError,
  utf8Bytes,
} from './generationBytes.js'
import {
  addBusinessPart,
  AgentSession,
  bindToolSet,
  combineToolRunners,
  type AgentFunctionCall,
  type AgentToolbox,
} from './agent/tools.js'
import type { GpasDetailRequest, GpasPart, GpasUploadBatch } from './gpasContracts.js'
import { openCredential, sealCredential } from './ingress.js'

type StartGenerationInput = {
  user: CurrentUser
  chatId: string
  content: string
  clientMessageId: string
  model?: string
  artifactId?: string
  supersedesGenerationId?: string
  replacesMessageId?: string
  /** Client-reported GPAS upload results attached to the user message. */
  uploads?: GpasUploadBatch
  /** Analysis detail request from a card; the task id stays out of the visible text. */
  detail?: GpasDetailRequest
  /** Agent mode (create): tool ids selected at ingress and the raw GPAS cookie. */
  agentToolIds?: string[]
  cookie?: string
  /** Agent mode (execute): sealed cookie loaded from the generation row. */
  sealedCredential?: string
}

/** AAD binds a sealed GPAS session to one user's one generation. */
function generationCredentialAad(userId: string, generationId: string): string {
  return `${userId}:${generationId}:generation`
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

function addUsage(
  left: CompletedUsage,
  right: CompletedUsage,
): CompletedUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

function escapeArtifactAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
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

/** Added to the model input for the last agent round, which gets no tools. */
export const AGENT_FINAL_ROUND_INPUT: OpenAI.Responses.ResponseInputItem = {
  role: 'user',
  content: '（系统提示）本次回答的工具调用次数已用完，不能再调用工具。请基于已有结果直接回答；已有结果不足以回答时如实说明，并提示完整数据可在界面中查看。',
}

/** Shown when an agent run queried data but the model wrote no answer. */
export const AGENT_EMPTY_ANSWER_FALLBACK =
  '已完成数据查询，但未能基于查询结果生成文字回答。完整结果可在界面中查看，也可以缩小问题范围（如指定类别）后重新提问。'

/**
 * Tool options for one agent round. The last round gets no tools at all:
 * providers may ignore tool_choice 'none' and end the round with a call.
 */
export function agentRoundTools(
  tools: OpenAI.Responses.FunctionTool[] | undefined,
  exhausted: boolean,
) {
  return tools && !exhausted ? { tools, tool_choice: 'auto' as const } : {}
}

/** Text to answer with when a run queried data but the model wrote nothing. */
export function agentAnswerFallback(toolCallsUsed: number, answerText: string): string | null {
  return toolCallsUsed > 0 && !answerText.trim() ? AGENT_EMPTY_ANSWER_FALLBACK : null
}

/** Deltas are merged for at most this long before being written to the stream. */
const STREAM_COALESCE_MS = 60
/** ... or until this many characters are pending. */
const STREAM_COALESCE_CHARS = 512

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
  private readonly tokenCounter: TokenCounter
  private readonly embedder: Embedder | null

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly redis: RedisClient,
    private readonly runtimes: GenerationRuntimeRegistry,
    private readonly finalizer: GenerationFinalizer,
    private readonly artifactService: ArtifactService | null = null,
    tokenCounter?: TokenCounter,
    private readonly agent: AgentToolbox | null = null,
  ) {
    this.qwen = new OpenAI({
      fetch: modelBudgetFetch(config, redis),
      apiKey: config.qwenApiKey,
      baseURL: config.qwenBaseUrl,
      timeout: 5 * 60 * 1000,
      maxRetries: 0,
    })
    this.streams = new GenerationStreamStore(config, redis)
    this.queue = new GenerationQueue(config, redis)
    this.tokenCounter = tokenCounter ?? new QwenTokenCounter(config)
    this.embedder = createEmbedder(config)
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
    )
    if (!rateLimit.allowed) {
      throw new GenerationRejectedError(
        'Too many generation requests',
        429,
        'generation_rate_limited',
        rateLimit.retryAfterMs,
      )
    }

    await assertTokenQuota(this.database, this.redis, this.config, input.user)

    if (input.supersedesGenerationId) {
      await this.cancel(
        input.user.id,
        input.supersedesGenerationId,
        'superseded',
      )
    }

    const generationId = crypto.randomUUID()
    const streamId = `user:${input.user.id}:generation:${generationId}`
    const agentToolIds = input.agentToolIds?.length ? input.agentToolIds : undefined
    const credential = agentToolIds && input.cookie !== undefined
      ? sealCredential(
          input.cookie,
          this.config.requestEncryptionKey,
          generationCredentialAad(input.user.id, generationId),
        )
      : undefined

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
            contextMemoryEnabled: this.config.contextMemoryEnabled,
            agentToolIds,
            credential,
          })
        : await createGenerationStart(this.database, {
            userId: input.user.id,
            chatId: input.chatId,
            clientMessageId: input.clientMessageId,
            content: input.content,
            uploads: input.uploads,
            detail: input.detail,
            generationId,
            streamId,
            requestId,
            provider: 'qwen',
            model: this.config.qwenModel,
            artifactId: input.artifactId,
            contextMemoryEnabled: this.config.contextMemoryEnabled,
            agentToolIds,
            credential,
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
    // The cancellation is already durable in PostgreSQL, and the worker polls
    // it; the Redis signal only makes it faster, so its failure is not fatal.
    await this.queue.requestCancellation(userId, generationId).catch((error: unknown) => {
      console.warn('Cancel signal not published; the worker will see it from PostgreSQL', {
        generationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })

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
      model: item.model,
      artifactId: item.artifactId,
      replacesMessageId: item.replacesMessageId,
      agentToolIds: item.agentToolIds,
      sealedCredential: item.credential,
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
    metrics.generationsStarted.inc()
    metrics.generationsActive.inc()
    const stopTimer = metrics.generationDuration.startTimer()
    try {
      runtime.completion = this.runProducer(input, start, runtime)
      await runtime.completion
    } finally {
      stopTimer()
      metrics.generationsActive.dec()
    }
  }

  private async checkpoint(
    runtime: GenerationRuntime,
    forceDatabasePoll = false,
  ): Promise<void> {
    const execution = runtime.execution ?? new GenerationExecutionContext(
      runtime.generationId,
      runtime.controller.signal,
      () => isGenerationCancellationRequested(this.database, runtime.generationId),
      // Pub/Sub + one batched worker poll cover streaming. Individual DB checks
      // only at forced side-effect/finalization boundaries (and the first call).
      Number.POSITIVE_INFINITY,
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
    // Text parts are ranges of runtime.partialOutput rather than a second
    // copy of the answer; materializeParts() builds them at finalize.
    const messageParts: Array<
      | { type: 'text'; start: number; end: number }
      | { type: 'artifact_draft_ref'; streamArtifactId: string }
    > = []
    const materializeParts = () => messageParts.map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: runtime.partialOutput.slice(part.start, part.end) }
        : part)
    const bytes = new GenerationByteBudget(this.config.generationMaxBytes)
    const completedDrafts: CompletedArtifactDraft[] = []
    // Confirmation forms from agent tools, appended after the answer text.
    const businessParts: GpasPart[] = []
    const acceptedArtifactIds = new Set<string>()
    let preparedArtifacts: PreparedArtifactVersion[] = []
    let eventWrites = Promise.resolve()
    let pendingEventWrites = 0
    let streamWritesStopped = false
    let snapshotPending = false

    const emitNow = (
      event: StreamEventPayload,
    ) => {
      // Bound buffered deltas when Redis is slow; final content is durable.
      if (pendingEventWrites >= 256 && event.type !== 'message.finish') return
      pendingEventWrites += 1
      eventId += 1
      const streamEvent = {
        ...event,
        generationId: start.generationId,
        streamId: start.streamId,
        messageId,
        eventId,
      } as StreamEvent
      eventWrites = eventWrites.then(() => streamWritesStopped ? undefined : this.streams.append(
        input.user.id,
        start.generationId,
        streamEvent,
      )).then(() => undefined).catch(() => undefined)
        .finally(() => { pendingEventWrites -= 1 })
    }

    // Consecutive deltas are merged for up to STREAM_COALESCE_MS (or
    // STREAM_COALESCE_CHARS): one Redis stream entry per token cost ~355 bytes,
    // mostly envelope, and dominated Redis memory. Clients place text by
    // startIndex, so a merged delta is equivalent. Any other event flushes
    // first, so ordering is unchanged.
    type DeltaPayload = Extract<StreamEventPayload, { type: 'message.delta' | 'artifact.delta' }>
    let pendingDelta: DeltaPayload | null = null
    let pendingDeltaTimer: NodeJS.Timeout | undefined
    const flushPendingDelta = () => {
      if (pendingDeltaTimer) clearTimeout(pendingDeltaTimer)
      pendingDeltaTimer = undefined
      const delta = pendingDelta
      pendingDelta = null
      if (delta) emitNow(delta)
    }
    const emit = (
      event: StreamEventPayload,
    ) => {
      if (event.type !== 'message.delta' && event.type !== 'artifact.delta') {
        flushPendingDelta()
        emitNow(event)
        return
      }
      const next = event as DeltaPayload
      const pending = pendingDelta
      const extends_ = pending !== null && (
        pending.type === 'message.delta' && next.type === 'message.delta'
          ? pending.startIndex + pending.delta.length === next.startIndex
          : pending.type === 'artifact.delta' && next.type === 'artifact.delta' &&
            pending.artifactStreamId === next.artifactStreamId
      )
      if (pending && extends_) {
        pendingDelta = { ...pending, sequence: next.sequence, delta: pending.delta + next.delta } as DeltaPayload
      } else {
        flushPendingDelta()
        pendingDelta = next
      }
      if (pendingDelta!.delta.length >= STREAM_COALESCE_CHARS) {
        flushPendingDelta()
      } else if (!pendingDeltaTimer) {
        pendingDeltaTimer = setTimeout(flushPendingDelta, STREAM_COALESCE_MS)
        pendingDeltaTimer.unref()
      }
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

    /** Records that `delta` was just appended to runtime.partialOutput. */
    const appendTextPart = (delta: string) => {
      if (!delta) return
      const end = runtime.partialOutput.length
      const start = end - delta.length
      const previous = messageParts.at(-1)
      if (previous?.type === 'text' && previous.end === start) previous.end = end
      else messageParts.push({ type: 'text', start, end })
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

    // Created right before the try whose finally clears it, so nothing in
    // between can throw and leave it running.
    const snapshotTimer = setInterval(() => {
      if (snapshotPending) return
      snapshotPending = true
      void this.queue.saveSnapshot(
        input.user.id,
        start.generationId,
        {
          content: runtime.partialOutput,
          providerRequestId: runtime.providerRequestId,
          usage: runtime.usage,
          executionSteps: runtime.executionSteps,
          // Kept for runs that a worker restart finalizes from the snapshot.
          memory: bytes.report(),
          updatedAt: new Date().toISOString(),
        },
      ).catch(() => undefined).finally(() => { snapshotPending = false })
    }, this.config.generationSnapshotIntervalMs)
    snapshotTimer.unref()

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
        // Caches are an optimization: on a Redis error, read PostgreSQL.
        ? await getCachedChatContext(
            this.redis,
            this.config,
            input.chatId,
          ).catch(() => null)
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
          { ...start.userMessage, content: start.userContextContent ?? start.userMessage.content },
        )
        const advanced = await advanceCachedChatContext(
          this.redis,
          this.config,
          previousRevision,
          context,
        ).catch(() => false)
        if (!advanced) context = null
      } else if (context?.revision !== revision) {
        context = null
      }

      if (this.config.contextMemoryEnabled && start.contextMaxSeq !== undefined) {
        await this.tokenCounter.initialize()
        const cacheInput = {
          chatId: input.chatId,
          contextMaxSeq: start.contextMaxSeq,
          summaryVersion: start.summaryVersion,
          policyFingerprint: this.tokenCounter.policyFingerprint,
        }
        context = await getCachedBudgetedChatContext(
          this.redis,
          this.config,
          cacheInput,
        ).catch(() => null)
        if (!context) {
          const budgetedContext = await buildBudgetedChatContext(this.database, {
            userId: input.user.id,
            chatId: input.chatId,
            contextMaxSeq: start.contextMaxSeq,
            summaryVersion: start.summaryVersion,
            historyTokenBudget: this.config.chatHistoryTokenBudget,
            summaryTokenBudget: this.config.chatSummaryTokenBudget,
            tokenCounter: this.tokenCounter,
          })
          if (budgetedContext) {
            context = budgetedContext
            if (budgetedContext.omittedUnsummarized) {
              // The summary lags behind the history window, so the turns in
              // between are not in this context. Ask for a catch-up summary.
              console.warn('Chat context omitted unsummarized turns', {
                chatId: input.chatId,
                summaryCoveredMaxSeq: budgetedContext.summaryCoveredMaxSeq,
                rawMinSeq: budgetedContext.rawMinSeq,
              })
              await enqueueBackgroundJob(this.database, {
                userId: input.user.id,
                type: 'chat.summary',
                dedupeKey: `chat.summary:catchup:${input.chatId}:${budgetedContext.summaryVersion ?? 0}`,
                chatId: input.chatId,
                payload: { assistantSeq: start.contextMaxSeq },
              }).catch(() => undefined)
            }
            await setCachedBudgetedChatContext(
              this.redis,
              this.config,
              cacheInput,
              budgetedContext,
            ).catch(() => undefined)
          }
        }
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
          await setCachedChatContext(this.redis, this.config, context).catch(() => undefined)
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
      const promptText = input.content || start.userMessage.content
      await this.tokenCounter.initialize()
      const memoryAccess = await resolveMemoryAccess(this.database, {
        userId: input.user.id,
        chatId: input.chatId,
        userMemoryEnabled: this.config.userMemoryEnabled,
        chatSearchEnabled: this.config.chatSearchEnabled,
      })
      // Memory is fixed-size; Artifacts get the instruction budget it leaves.
      const userMemoryInstructions = memoryAccess.readMemory
        ? await buildUserMemoryInstructions(this.database, input.user.id, {
            tokenBudget: this.config.userMemoryTokenBudget,
            maxItems: this.config.userMemoryMaxItems,
            tokenCounter: this.tokenCounter,
            chatId: input.chatId,
          })
        : ''
      let artifactCount = 0
      let artifactInstructions = ''
      let selectedArtifact: AssembledArtifactContext['selectedArtifact']
      if (artifactEnabled && artifactService) {
        const assembled = await assembleArtifactContext(this.database, {
          config: this.config,
          artifactService,
          tokenCounter: this.tokenCounter,
          selectSections: createModelSectionSelector({
            client: this.qwen,
            model: this.config.backgroundModel,
            onResponse: (response) => {
              runtime.usage = addUsage(runtime.usage, extractUsage(response))
            },
          }),
          userId: input.user.id,
          chatId: input.chatId,
          prompt: promptText,
          artifactId: input.artifactId,
          tokenBudget: this.config.instructionsTokenBudget -
            (userMemoryInstructions ? this.tokenCounter.countText(userMemoryInstructions) + 8 : 0),
          signal: runtime.controller.signal,
        })
        artifactInstructions = assembled.instructions
        selectedArtifact = assembled.selectedArtifact
        artifactCount = (artifactInstructions.match(/^- id=/gm) ?? []).length
        completeStep(
          'artifact-context',
          selectedArtifact
            ? `已载入 ${selectedArtifact.type} Artifact`
            : `发现 ${artifactCount} 个可用 Artifact`,
        )
      }
      const combinedInstructions = [
        artifactEnabled ? artifactInstructions : '',
        userMemoryInstructions,
      ].filter(Boolean).join('\n\n')
      context = { ...context, messages: await fitInputBudget(
        this.tokenCounter, context.messages, combinedInstructions, this.config,
      ) }
      const patchMode = Boolean(
        this.config.artifactPatchEnabled &&
        selectedArtifact?.edit === 'patch',
      )
      let patchOutput = ''
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
      // Agent mode: only tools chosen server-side at ingress are offered, and
      // identity comes from the run's own sealed session, never the model.
      const agentTools = !patchMode && input.agentToolIds?.length
        ? this.agent?.select(input.agentToolIds) ?? null
        : null
      const agentSession = agentTools
        ? new AgentSession(
            this.config,
            input.user,
            input.sealedCredential
              ? openCredential(
                  input.sealedCredential,
                  this.config.requestEncryptionKey,
                  generationCredentialAad(input.user.id, start.generationId),
                )
              : undefined,
            runtime.controller.signal,
          )
        : null
      const toolRunner = combineToolRunners(
        agentTools && agentSession ? bindToolSet(agentTools, agentSession) : null,
        patchMode
          ? null
          : createMemoryToolRunner(
              {
                database: this.database,
                userId: input.user.id,
                chatId: input.chatId,
                embedder: this.embedder,
                minSimilarity: this.config.chatSearchMinSimilarity,
                signal: runtime.controller.signal,
              },
              memoryAccess,
            ),
      )
      // Most stable text first (tool rules, then memory, then this turn's
      // Artifacts), so the provider's prefix cache survives across turns.
      const modelInstructions = [
        toolRunner?.instructions(),
        userMemoryInstructions,
        artifactEnabled ? artifactInstructions : '',
      ].filter(Boolean).join('\n\n')
      const modelInput: OpenAI.Responses.ResponseInputItem[] =
        context.messages.map((message) => ({
          role: message.role,
          content: message.content,
        }))
      bytes.charge('input', utf8Bytes(modelInstructions) +
        context.messages.reduce((total, message) => total + utf8Bytes(message.content), 0))
      let toolCallsUsed = 0
      // Only agent runs need the text: tool rounds resend it, and the
      // fallback checks whether any was produced.
      let answeredWithText = false
      const pushOutputText = (delta: string) => {
        if (patchMode) {
          patchOutput += delta
        } else if (parser) {
          parser.push(delta)
        } else {
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
        }
      }

      // One model call in flight per run: the generation lease bounds total
      // upstream concurrency (generation + background <= upstream).
      for (;;) {
        const toolsExhausted = toolCallsUsed >= this.config.agentMaxToolCalls
        // The last round gets no tools at all (providers may ignore
        // tool_choice 'none') and must answer from the results it has.
        if (toolRunner && toolsExhausted) modelInput.push(AGENT_FINAL_ROUND_INPUT)
        const responseStream = await this.qwen.responses.create(
          {
            model: input.model ?? this.config.qwenModel,
            instructions: modelInstructions || undefined,
            input: modelInput,
            max_output_tokens: this.config.qwenMaxOutputTokens,
            stream: true,
            ...agentRoundTools(toolRunner?.tools, toolsExhausted),
          },
          { signal: runtime.controller.signal },
        )
        await this.checkpoint(runtime, true)
        const functionCalls: AgentFunctionCall[] = []
        const collectFunctionCall = (item: { call_id?: string; name?: string; arguments?: string }) => {
          if (!item.call_id || !item.name) return
          if (functionCalls.some((call) => call.call_id === item.call_id)) return
          functionCalls.push({
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments ?? '',
          })
        }
        let roundText = ''

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
            } else if (toolRunner && itemType === 'function_call') {
              // Agent tools are executed and traced after this round's stream.
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
          } else if (
            toolRunner &&
            providerEvent.type === 'response.output_item.done' &&
            providerEvent.item?.type === 'function_call'
          ) {
            collectFunctionCall(providerEvent.item)
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
            bytes.charge('output', utf8Bytes(event.delta))
            if (toolRunner) roundText += event.delta
            pushOutputText(event.delta)
          } else if (event.type === 'response.completed') {
            runtime.providerRequestId = event.response.id
            // Agent runs make several model calls; usage accumulates.
            runtime.usage = addUsage(runtime.usage, extractUsage(event.response))
            if (toolRunner) {
              for (const item of event.response.output ?? []) {
                if (item.type === 'function_call') collectFunctionCall(item)
              }
            }
          } else if (event.type === 'response.incomplete') {
            runtime.providerRequestId = event.response.id
            runtime.usage = addUsage(runtime.usage, extractUsage(event.response))
            throw new GenerationLengthError()
          } else if (event.type === 'response.failed') {
            throw new Error(
              event.response.error?.message || 'Qwen generation failed',
            )
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Qwen stream failed')
          }
        }

        if (roundText.trim()) answeredWithText = true

        if (!toolRunner || functionCalls.length === 0 || toolsExhausted) break
        await this.checkpoint(runtime, true)
        if (roundText) modelInput.push({ role: 'assistant', content: roundText })
        for (const call of functionCalls) {
          modelInput.push({
            type: 'function_call',
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments,
          })
          if (toolCallsUsed >= this.config.agentMaxToolCalls) {
            modelInput.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify({ error: '本次回答的工具调用次数已达上限，请基于已有结果回答。' }),
            })
            continue
          }
          toolCallsUsed += 1
          toolStepSequence += 1
          const stepId = `tool:${toolStepSequence}`
          updateStep({
            id: stepId,
            kind: 'tool',
            label: toolRunner.label(call.name),
            status: 'active',
          })
          emit({ type: 'tool.start', toolRunId: stepId, toolName: call.name })
          const toolStartedAt = new Date()
          const result = await toolRunner.execute(call)
          metrics.toolCalls.inc({ tool: result.toolId ?? call.name, outcome: result.ok ? 'ok' : 'error' })
          await this.checkpoint(runtime, true)
          bytes.charge('tool', utf8Bytes(result.output))
          await recordToolRun(this.database, {
            userId: input.user.id,
            generationId: start.generationId,
            toolCallId: call.call_id,
            toolName: result.toolId ?? call.name,
            ok: result.ok,
            args: result.args,
            outputBytes: Buffer.byteLength(result.output, 'utf8'),
            rawOutputBytes: result.rawOutputBytes,
            truncated: result.truncated,
            error: result.error,
            startedAt: toolStartedAt,
          }).catch(() => undefined)
          completeStep(stepId, result.ok ? undefined : '未能完成')
          emit({ type: 'tool.result', toolRunId: stepId, toolName: call.name })
          if (result.part) addBusinessPart(businessParts, result.part)
          modelInput.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: result.output,
          })
        }
      }

      // A run that already queried data must not fail for an empty last round.
      const fallback = toolRunner ? agentAnswerFallback(toolCallsUsed, answeredWithText ? 'answered' : '') : null
      if (fallback) {
        ensureResponseStep()
        pushOutputText(fallback)
      }

      await this.checkpoint(runtime, true)
      if (patchMode && selectedArtifact && parser && artifactService) {
        const baseContent = await artifactService.readVersionContent(
          input.user.id,
          selectedArtifact.artifactId,
          selectedArtifact.version,
          1024 * 1024,
          runtime.controller.signal,
        )
        if (baseContent === null) {
          throw new Error('ARTIFACT_PATCH_BASE_UNAVAILABLE')
        }
        bytes.charge('artifact', utf8Bytes(baseContent))
        const buildDraft = (output: string) => createPatchedArtifactDraft({
          output,
          logicalId: selectedArtifact!.logicalId,
          title: selectedArtifact!.title,
          type: selectedArtifact!.type as ArtifactMimeType,
          baseVersion: selectedArtifact!.version,
          content: baseContent,
        })
        let draft: CompletedArtifactDraft
        try {
          draft = buildDraft(patchOutput)
        } catch (firstError) {
          const correction = [
            combinedInstructions,
            'The previous patch was rejected by the server.',
            `Validation error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
            'Return one corrected artifact_edit block only. Reuse exact SEARCH text from the attached content or fragments.',
          ].filter(Boolean).join('\n\n')
          const retryResponse = await this.qwen.responses.create(
            {
              model: input.model ?? this.config.qwenModel,
              instructions: correction,
              input: context.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              max_output_tokens: this.config.qwenMaxOutputTokens,
            },
            { signal: runtime.controller.signal },
          )
          runtime.providerRequestId = retryResponse.id
          runtime.usage = addUsage(
            runtime.usage,
            extractUsage(retryResponse),
          )
          bytes.charge('output', utf8Bytes(retryResponse.output_text))
          draft = buildDraft(retryResponse.output_text)
        }
        const escapedContent = draft.content.replaceAll(
          '</artifact>',
          '\\</artifact>',
        )
        parser.push(
          `<artifact v="1" id="${selectedArtifact.logicalId}" op="replace" type="${selectedArtifact.type}" title="${escapeArtifactAttribute(selectedArtifact.title)}" base_version="${selectedArtifact.version}">\n${escapedContent}\n</artifact>`,
        )
      }
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
        messageParts: [
          ...materializeParts(),
          ...businessParts.map((part) => ({ type: 'gpas' as const, part })),
        ],
        memory: bytes.report(),
        preparedArtifacts,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: 'completed',
        executionSteps: runtime.executionSteps,
      }, runtime)

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
      await Promise.race([
        eventWrites,
        new Promise<void>(resolve => {
          const timer = setTimeout(() => { streamWritesStopped = true; resolve() }, 2_500)
          timer.unref()
          void eventWrites.finally(() => clearTimeout(timer))
        }),
      ])
    } catch (error) {
      const timedOut = runtime.abortReason === 'timeout'
      const interrupted = ['lease_lost', 'shutdown'].includes(
        runtime.abortReason ?? '',
      )
      const cancelled = runtime.abortReason === 'cancel' ||
        (error instanceof GenerationCancellationError && !timedOut && !interrupted)
      const byteLimited = error instanceof GenerationByteLimitError
      const lengthLimited = error instanceof GenerationLengthError || byteLimited
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
        messageParts: materializeParts(),
        memory: bytes.report(),
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
              : byteLimited
                ? 'generation_byte_limit'
                : lengthLimited
                  ? 'generation_length'
                  : error instanceof ArtifactServiceError
                  ? error.code.toLocaleLowerCase()
                  : 'generation_failed',
        errorMessage: message,
        executionSteps: runtime.executionSteps,
      }, runtime)

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
      await Promise.race([
        eventWrites,
        new Promise<void>(resolve => {
          const timer = setTimeout(() => { streamWritesStopped = true; resolve() }, 2_500)
          timer.unref()
          void eventWrites.finally(() => clearTimeout(timer))
        }),
      ])
    } finally {
      flushPendingDelta()
      clearInterval(snapshotTimer)
      this.runtimes.delete(start.generationId, runtime)
      // The run is final in PostgreSQL; the recovery snapshot is no longer needed.
      void this.queue.deleteSnapshot(input.user.id, start.generationId).catch(() => undefined)
      const memory = bytes.report()
      metrics.generationBytes.observe(memory.totalBytes)
      if (firstTokenAt !== null) metrics.generationFirstToken.observe((firstTokenAt - startedAt) / 1_000)
      if (memory.limited || memory.totalBytes >= memory.capBytes / 2) {
        console.warn('Generation used a large share of GENERATION_MAX_BYTES', {
          generationId: start.generationId,
          ...memory,
        })
      }
    }
  }
}
