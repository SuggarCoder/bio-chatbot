import OpenAI from 'openai'
import { createResumableStreamContext } from 'resumable-stream'
import type { ResumableStreamContext } from 'resumable-stream'

import {
  acquireGenerationLease,
  applyMonthlyQuota,
  getCachedChatContext,
  readMonthlyQuota,
  releaseGenerationLease,
  renewGenerationLease,
  setCachedChatContext,
  setGenerationRealtimeState,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import {
  completeGeneration,
  createGenerationStart,
  failGeneration,
  findGenerationStart,
  getChatContextRevision,
  markGenerationStreaming,
  rebuildChatContext,
  type Database,
  type GenerationStart,
} from './db.js'
import type { CurrentUser, StreamEvent } from './domain.js'

type StartGenerationInput = {
  user: CurrentUser
  chatId: string
  content: string
  clientMessageId: string
  ip: string
}

type PreparedGeneration = {
  start: GenerationStart
  stream: ReadableStream<string> | null
}

type CompletedUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

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
      input_tokens_details?: {
        cached_tokens?: unknown
      }
      output_tokens_details?: {
        reasoning_tokens?: unknown
      }
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
  statusCode: number
  code: string

  constructor(message: string, statusCode: number, code: string) {
    super(message)
    this.name = 'GenerationRejectedError'
    this.statusCode = statusCode
    this.code = code
  }
}

export class GenerationService {
  private config: AppConfig
  private database: Database
  private redis: RedisClient
  private qwen: OpenAI
  private streamContext: ResumableStreamContext
  private abortControllers = new Map<string, AbortController>()

  constructor(
    config: AppConfig,
    database: Database,
    redis: RedisClient,
  ) {
    this.config = config
    this.database = database
    this.redis = redis
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

  async prepare(input: StartGenerationInput): Promise<PreparedGeneration> {
    const requestId = `${input.chatId}:${input.clientMessageId}`
    const existing = await findGenerationStart(
      this.database,
      input.user.id,
      input.chatId,
      requestId,
    )

    if (existing) {
      if (existing.status !== 'pending' && existing.status !== 'streaming') {
        throw new GenerationRejectedError(
          'This message was already generated',
          409,
          'generation_already_finished',
        )
      }

      return {
        start: existing,
        stream:
          (await this.streamContext.resumeExistingStream(
            existing.streamId,
            0,
          )) ?? null,
      }
    }

    const generationId = crypto.randomUUID()
    const streamId = crypto.randomUUID()

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
      start = await createGenerationStart(this.database, {
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
      )

      if (error instanceof Error && error.message === 'CHAT_NOT_FOUND') {
        throw new GenerationRejectedError(
          'Chat not found',
          404,
          'chat_not_found',
        )
      }

      const raced = await findGenerationStart(
        this.database,
        input.user.id,
        input.chatId,
        requestId,
      )

      if (raced) {
        return {
          start: raced,
          stream:
            (await this.streamContext.resumeExistingStream(
              raced.streamId,
              0,
            )) ?? null,
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
      },
    )

    const stream = await this.streamContext.createNewResumableStream(
      streamId,
      () => this.createProducer(input, start),
    )

    return {
      start,
      stream,
    }
  }

  async resume(
    streamId: string,
    resumeAt: number,
  ): Promise<ReadableStream<string> | null | undefined> {
    return this.streamContext.resumeExistingStream(streamId, resumeAt)
  }

  abortAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
  }

  private createProducer(
    input: StartGenerationInput,
    start: GenerationStart,
  ): ReadableStream<string> {
    const controller = new AbortController()
    this.abortControllers.set(start.generationId, controller)

    return new ReadableStream<string>({
      start: (streamController) => {
        void this.runProducer(
          input,
          start,
          controller,
          streamController,
        )
      },
      cancel: () => {
        // resumable-stream owns consumer cancellation; the producer continues.
      },
    })
  }

  private async runProducer(
    input: StartGenerationInput,
    start: GenerationStart,
    abortController: AbortController,
    streamController: ReadableStreamDefaultController<string>,
  ): Promise<void> {
    const startedAt = Date.now()
    let firstTokenAt: number | null = null
    let providerRequestId: string | undefined
    let output = ''
    let usage: CompletedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    }
    const leaseTimer = setInterval(() => {
      void renewGenerationLease(
        this.redis,
        this.config,
        input.user.id,
        start.generationId,
      )
    }, Math.max(10_000, (this.config.generationLeaseSeconds * 1000) / 3))

    streamController.enqueue(
      serializeEvent({
        type: 'start',
        generationId: start.generationId,
        streamId: start.streamId,
        userMessage: start.userMessage,
      }),
    )

    try {
      const revision = await getChatContextRevision(
        this.database,
        input.user.id,
        input.chatId,
      )

      if (revision === null) {
        throw new Error('Chat not found')
      }

      let context = await getCachedChatContext(
        this.redis,
        this.config,
        input.chatId,
        revision,
      )

      if (!context) {
        context = await rebuildChatContext(
          this.database,
          input.user.id,
          input.chatId,
        )

        if (!context) {
          throw new Error('Chat not found')
        }

        await setCachedChatContext(
          this.redis,
          this.config,
          context,
        )
      }

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
        {
          signal: abortController.signal,
        },
      )

      for await (const event of responseStream) {
        if (event.type === 'response.created') {
          providerRequestId = event.response.id
          await markGenerationStreaming(
            this.database,
            start.generationId,
            providerRequestId,
          )
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
            },
          )
        } else if (event.type === 'response.output_text.delta') {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now()
          }

          output += event.delta
          streamController.enqueue(
            serializeEvent({
              type: 'text-delta',
              delta: event.delta,
            }),
          )
        } else if (event.type === 'response.completed') {
          providerRequestId = event.response.id
          usage = extractUsage(event.response)
        } else if (event.type === 'response.failed') {
          throw new Error(
            event.response.error?.message ||
              'Qwen generation failed',
          )
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Qwen stream failed')
        }
      }

      if (!output.trim()) {
        throw new Error('Qwen returned an empty response')
      }

      const assistantMessage = await completeGeneration(
        this.database,
        {
          generationId: start.generationId,
          userId: input.user.id,
          chatId: input.chatId,
          content: output,
          providerRequestId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          reasoningTokens: usage.reasoningTokens,
          latencyMs: Date.now() - startedAt,
          timeToFirstTokenMs:
            firstTokenAt === null
              ? null
              : firstTokenAt - startedAt,
          finishReason: 'completed',
        },
      )

      await Promise.allSettled([
        applyMonthlyQuota(
          this.redis,
          this.config,
          input.user.id,
          start.generationId,
          usage.inputTokens + usage.outputTokens,
        ),
        setGenerationRealtimeState(
          this.redis,
          this.config,
          start.generationId,
          {
            status: 'completed',
            chatId: input.chatId,
            userId: input.user.id,
            streamId: start.streamId,
            provider: 'qwen',
            model: this.config.qwenModel,
            inputTokens: String(usage.inputTokens),
            outputTokens: String(usage.outputTokens),
          },
        ),
      ])

      streamController.enqueue(
        serializeEvent({
          type: 'done',
          generationId: start.generationId,
          assistantMessage,
        }),
      )
      streamController.close()
    } catch (error) {
      const aborted = abortController.signal.aborted
      const code = aborted ? 'generation_cancelled' : 'generation_failed'
      const message =
        error instanceof Error
          ? error.message
          : 'Generation failed'

      await failGeneration(this.database, start.generationId, {
        status: aborted ? 'cancelled' : 'failed',
        errorCode: code,
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
      })
      await setGenerationRealtimeState(
        this.redis,
        this.config,
        start.generationId,
        {
          status: aborted ? 'cancelled' : 'failed',
          chatId: input.chatId,
          userId: input.user.id,
          streamId: start.streamId,
          provider: 'qwen',
          model: this.config.qwenModel,
        },
      ).catch(() => undefined)

      streamController.enqueue(
        serializeEvent({
          type: 'error',
          generationId: start.generationId,
          code,
          message,
        }),
      )
      streamController.close()
    } finally {
      clearInterval(leaseTimer)
      this.abortControllers.delete(start.generationId)
      await releaseGenerationLease(
        this.redis,
        this.config,
        input.user.id,
        start.generationId,
      ).catch(() => undefined)
    }
  }
}
