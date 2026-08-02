import OpenAI from 'openai'
import { createResumableStreamContext } from 'resumable-stream'
import type { ResumableStreamContext } from 'resumable-stream'

import {
  acquireGenerationLease,
  getCachedChatContext,
  getGenerationRunnerId,
  publishGenerationCancellation,
  readMonthlyQuota,
  releaseGenerationLease,
  renewGenerationLease,
  setCachedChatContext,
  setGenerationRealtimeState,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import { ArtifactStreamParser } from './artifacts/parser.js'
import {
  ArtifactCommitError,
  listArtifactsForChat,
  type PreparedArtifactVersion,
} from './artifacts/repository.js'
import {
  ArtifactService,
  ArtifactServiceError,
  type CompletedArtifactDraft,
} from './artifacts/service.js'
import { buildArtifactSystemPrompt } from './artifacts/systemPrompt.js'
import {
  createGenerationStart,
  createRegenerationStart,
  findGenerationStart,
  getChatContextRevision,
  getGeneration,
  isGenerationCancellationRequested,
  markGenerationStreaming,
  rebuildChatContext,
  requestGenerationCancellation,
  type Database,
  type GenerationStart,
  type GenerationUsage,
} from './db.js'
import type {
  CancelSource,
  CurrentUser,
  GenerationDto,
  GenerationStartDto,
  StreamEvent,
} from './domain.js'
import type { GenerationFinalizer } from './generationFinalizer.js'
import {
  GenerationCancellationError,
  GenerationExecutionContext,
} from './generationExecution.js'
import {
  GenerationRuntimeRegistry,
  type GenerationRuntime,
} from './generationRuntimeRegistry.js'

type StartGenerationInput = {
  user: CurrentUser
  chatId: string
  content: string
  clientMessageId: string
  ip: string
  supersedesGenerationId?: string
  replacesMessageId?: string
}

type CompletedUsage = GenerationUsage

type StreamEventPayload = StreamEvent extends infer Event
  ? Event extends StreamEvent
    ? Omit<Event, 'generationId' | 'streamId' | 'messageId' | 'eventId'>
    : never
  : never

function serializeEvent(event: StreamEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
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

async function drain(stream: ReadableStream<string>): Promise<void> {
  const reader = stream.getReader()

  try {
    while (!(await reader.read()).done) {
      // resumable-stream persists chunks while this internal reader drains.
    }
  } finally {
    reader.releaseLock()
  }
}

export class GenerationRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
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

export class GenerationService {
  private readonly qwen: OpenAI
  private readonly streamContext: ResumableStreamContext

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
      maxRetries: 1,
    })
    this.streamContext = createResumableStreamContext({
      keyPrefix: `${config.redisPrefix}stream`,
      waitUntil: null,
    })
  }

  async create(input: StartGenerationInput): Promise<GenerationStartDto> {
    const requestId = `${input.chatId}:${input.clientMessageId}`
    const existing = await findGenerationStart(
      this.database,
      input.user.id,
      input.chatId,
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
        replacesMessageId: input.replacesMessageId ?? null,
      }
    }

    if (input.supersedesGenerationId) {
      await this.cancel(
        input.user.id,
        input.supersedesGenerationId,
        'superseded',
      )
    }

    if (!this.redis.isReady) {
      throw new GenerationRejectedError(
        'Generation is temporarily unavailable',
        503,
        'redis_unavailable',
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

    const generationId = crypto.randomUUID()
    const streamId = crypto.randomUUID()
    const acquired = await acquireGenerationLease(
      this.redis,
      this.config,
      input.user.id,
      generationId,
    )

    if (!acquired) {
      throw new GenerationRejectedError(
        'Another generation is already running',
        429,
        'generation_concurrency_exceeded',
      )
    }

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
          })
    } catch (error) {
      await releaseGenerationLease(
        this.redis,
        this.config,
        input.user.id,
        generationId,
      ).catch(() => undefined)

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
        error.message.includes('uq_generation_chat_active')
      ) {
        throw new GenerationRejectedError(
          'Another generation is already active for this chat',
          409,
          'generation_already_active',
        )
      }

      const raced = await findGenerationStart(
        this.database,
        input.user.id,
        input.chatId,
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
            replacesMessageId: input.replacesMessageId ?? null,
          }
        }
      }

      throw error
    }

    await setGenerationRealtimeState(
      this.redis,
      this.config,
      generationId,
      {
        status: 'pending',
        chatId: input.chatId,
        userId: input.user.id,
        streamId,
        provider: 'qwen',
        model: this.config.qwenModel,
        runnerId: this.runtimes.runnerId,
      },
    )

    const internalStream = await this.streamContext.createNewResumableStream(
      streamId,
      () => this.createProducer(input, start),
    )
    if (!internalStream) {
      throw new Error('STREAM_CREATION_FAILED')
    }
    void drain(internalStream).catch(() => undefined)

    const generation = await getGeneration(
      this.database,
      input.user.id,
      generationId,
    )

    if (!generation) {
      throw new Error('GENERATION_NOT_FOUND')
    }

    return {
      generation,
      userMessage: start.userMessage,
      replacesMessageId: start.replacesMessageId ?? null,
    }
  }

  async resume(
    streamId: string,
    resumeAt: number,
  ): Promise<ReadableStream<string> | null | undefined> {
    return this.streamContext.resumeExistingStream(streamId, resumeAt)
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
      ['completed', 'failed', 'cancelled'].includes(generation.status)
    ) {
      return generation
    }

    const localAbort = this.runtimes.abort(generationId)
    const runnerId = await getGenerationRunnerId(
      this.redis,
      this.config,
      generationId,
    ).catch(() => null)
    const cancelRequestedAt =
      generation.cancelRequestedAt ?? new Date().toISOString()

    await Promise.allSettled([
      releaseGenerationLease(
        this.redis,
        this.config,
        userId,
        generationId,
      ),
      setGenerationRealtimeState(
        this.redis,
        this.config,
        generationId,
        {
          status: 'cancelling',
          cancelRequestedAt,
        },
      ),
      runnerId && !localAbort
        ? publishGenerationCancellation(
            this.redis,
            this.config,
            runnerId,
            generationId,
          )
        : Promise.resolve(),
    ])

    return generation
  }

  async shutdown(): Promise<void> {
    const runtimes = this.runtimes.list()
    await Promise.allSettled(
      runtimes.map(async (runtime) => {
        await this.cancel(
          runtime.userId,
          runtime.generationId,
          'server_shutdown',
        )
      }),
    )
    this.runtimes.abortAll()
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

  private createProducer(
    input: StartGenerationInput,
    start: GenerationStart,
  ): ReadableStream<string> {
    const runtime: GenerationRuntime = {
      generationId: start.generationId,
      streamId: start.streamId,
      chatId: input.chatId,
      userId: input.user.id,
      controller: new AbortController(),
      partialOutput: '',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    }
    this.runtimes.register(runtime)

    return new ReadableStream<string>({
      start: (controller) => {
        runtime.completion = this.runProducer(
          input,
          start,
          runtime,
          controller,
        ).catch(() => undefined)
      },
      cancel: () => {
        // Network/reader disconnect is resumable and never implies user Stop.
      },
    })
  }

  private async checkpoint(runtime: GenerationRuntime): Promise<void> {
    const execution = new GenerationExecutionContext(
      runtime.generationId,
      runtime.controller.signal,
      () => isGenerationCancellationRequested(
        this.database,
        runtime.generationId,
      ),
    )

    try {
      await execution.checkpoint()
    } catch (error) {
      runtime.controller.abort()
      throw error
    }
  }

  private async runProducer(
    input: StartGenerationInput,
    start: GenerationStart,
    runtime: GenerationRuntime,
    controller: ReadableStreamDefaultController<string>,
  ): Promise<void> {
    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    const messageId = crypto.randomUUID()
    let eventId = 0
    let messageSequence = 0
    const messageParts: Array<
      | { type: 'text'; text: string }
      | { type: 'artifact_draft_ref'; streamArtifactId: string }
    > = []
    const completedDrafts: CompletedArtifactDraft[] = []
    const acceptedArtifactIds = new Set<string>()
    let preparedArtifacts: PreparedArtifactVersion[] = []
    const leaseTimer = setInterval(() => {
      if (runtime.controller.signal.aborted) {
        return
      }

      void renewGenerationLease(
        this.redis,
        this.config,
        input.user.id,
        start.generationId,
      )
    }, Math.max(10_000, (this.config.generationLeaseSeconds * 1000) / 3))

    const emit = (
      event: StreamEventPayload,
    ) => {
      eventId += 1
      controller.enqueue(serializeEvent({
        ...event,
        generationId: start.generationId,
        streamId: start.streamId,
        messageId,
        eventId,
      } as StreamEvent))
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

    emit({
      type: 'message.start',
      userMessage: start.userMessage,
    })

    try {
      await this.checkpoint(runtime)

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
            revision,
          )
        : null

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

      await this.checkpoint(runtime)
      const artifactCatalog = artifactEnabled
        ? await listArtifactsForChat(this.database, input.user.id, input.chatId)
        : []
      const artifactPromptCatalog = artifactEnabled && artifactService
        ? await Promise.all(artifactCatalog.slice(0, 50).flatMap((artifact, index) =>
            artifact.logicalId && artifact.type
              ? [index < 5
                  ? artifactService.readVersionContent(
                      input.user.id,
                      artifact.id,
                      artifact.currentVersion,
                    ).catch(() => null).then((content) => ({
                      logicalId: artifact.logicalId!,
                      version: artifact.currentVersion,
                      type: artifact.type!,
                      title: artifact.title,
                      content,
                    }))
                  : Promise.resolve({
                      logicalId: artifact.logicalId,
                      version: artifact.currentVersion,
                      type: artifact.type,
                      title: artifact.title,
                    })]
              : [],
          ))
        : []
      const responseStream = await this.qwen.responses.create(
        {
          model: this.config.qwenModel,
          instructions: artifactEnabled
            ? buildArtifactSystemPrompt(artifactPromptCatalog)
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
      await this.checkpoint(runtime)

      for await (const event of responseStream) {
        await this.checkpoint(runtime)

        if (event.type === 'response.created') {
          runtime.providerRequestId = event.response.id
          const marked = await markGenerationStreaming(
            this.database,
            start.generationId,
            runtime.providerRequestId,
          )

          if (!marked) {
            await this.checkpoint(runtime)
          }

          await setGenerationRealtimeState(
            this.redis,
            this.config,
            start.generationId,
            {
              status: 'streaming',
              chatId: input.chatId,
              userId: input.user.id,
              streamId: start.streamId,
              provider: 'qwen',
              model: this.config.qwenModel,
              runnerId: this.runtimes.runnerId,
              startedAt: new Date().toISOString(),
            },
          )
        } else if (event.type === 'response.output_text.delta') {
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

      await this.checkpoint(runtime)
      parser?.finish()

      if (!runtime.partialOutput.trim() && completedDrafts.length === 0) {
        throw new Error('Qwen returned an empty response')
      }

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
          }
        }
      }

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
      })

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
      controller.close()
    } catch (error) {
      const cancelled =
        error instanceof GenerationCancellationError ||
        runtime.controller.signal.aborted
      const lengthLimited = error instanceof GenerationLengthError
      const message =
        error instanceof Error ? error.message : 'Generation failed'
      if (lengthLimited) parser?.finish()
      else parser?.abort(cancelled ? 'Artifact generation was stopped.' : message)
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
        desiredStatus: 'failed',
        content: runtime.partialOutput,
        messageId,
        messageParts,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: cancelled
          ? 'cancelled'
          : lengthLimited
            ? 'length'
            : 'failed',
        errorCode: cancelled
          ? 'generation_cancelled'
          : lengthLimited
            ? 'generation_length'
            : 'generation_failed',
        errorMessage: message,
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
      controller.close()
    } finally {
      clearInterval(leaseTimer)
      this.runtimes.delete(start.generationId)
      await releaseGenerationLease(
        this.redis,
        this.config,
        input.user.id,
        start.generationId,
      ).catch(() => undefined)
    }
  }
}
