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

function serializeEvent(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
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

export class GenerationService {
  private readonly qwen: OpenAI
  private readonly streamContext: ResumableStreamContext

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly redis: RedisClient,
    private readonly runtimes: GenerationRuntimeRegistry,
    private readonly finalizer: GenerationFinalizer,
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

    const emit = (event: StreamEvent) => {
      controller.enqueue(serializeEvent(event))
    }

    emit({
      type: 'generation.start',
      generationId: start.generationId,
      streamId: start.streamId,
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
      const responseStream = await this.qwen.responses.create(
        {
          model: this.config.qwenModel,
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

          const startIndex = runtime.partialOutput.length
          runtime.partialOutput += event.delta
          emit({
            type: 'text.delta',
            generationId: start.generationId,
            streamId: start.streamId,
            startIndex,
            delta: event.delta,
          })
        } else if (event.type === 'response.completed') {
          runtime.providerRequestId = event.response.id
          runtime.usage = extractUsage(event.response)
        } else if (event.type === 'response.failed') {
          throw new Error(
            event.response.error?.message || 'Qwen generation failed',
          )
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Qwen stream failed')
        }
      }

      await this.checkpoint(runtime)

      if (!runtime.partialOutput.trim()) {
        throw new Error('Qwen returned an empty response')
      }

      const result = await this.finalizer.finalize({
        generationId: start.generationId,
        userId: input.user.id,
        desiredStatus: 'completed',
        content: runtime.partialOutput,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: 'completed',
      })

      if (result.generation.status === 'cancelled') {
        emit({
          type: 'generation.cancelled',
          generationId: start.generationId,
          streamId: start.streamId,
          assistantMessage: result.assistantMessage,
        })
      } else if (result.assistantMessage) {
        emit({
          type: 'generation.completed',
          generationId: start.generationId,
          streamId: start.streamId,
          assistantMessage: result.assistantMessage,
        })
      }
      controller.close()
    } catch (error) {
      const cancelled =
        error instanceof GenerationCancellationError ||
        runtime.controller.signal.aborted
      const message =
        error instanceof Error ? error.message : 'Generation failed'
      const result = await this.finalizer.finalize({
        generationId: start.generationId,
        userId: input.user.id,
        desiredStatus: 'failed',
        content: runtime.partialOutput,
        providerRequestId: runtime.providerRequestId,
        usage: runtime.usage,
        latencyMs: Date.now() - startedAt,
        timeToFirstTokenMs:
          firstTokenAt === null ? null : firstTokenAt - startedAt,
        finishReason: cancelled ? 'cancelled' : 'failed',
        errorCode: cancelled
          ? 'generation_cancelled'
          : 'generation_failed',
        errorMessage: message,
      })

      if (result.generation.status === 'cancelled') {
        emit({
          type: 'generation.cancelled',
          generationId: start.generationId,
          streamId: start.streamId,
          assistantMessage: result.assistantMessage,
        })
      } else {
        emit({
          type: 'generation.failed',
          generationId: start.generationId,
          streamId: start.streamId,
          code: result.generation.errorCode ?? 'generation_failed',
          message: result.generation.errorMessage ?? message,
          assistantMessage: result.assistantMessage,
        })
      }
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
