import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AuthenticationError, resolveCurrentUser } from './auth.js'
import {
  cacheUserProfile,
  consumeGenerationRateLimit,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import {
  createChat,
  checkDatabase,
  deleteMessageVote,
  deleteChat,
  getChatDetail,
  getGeneration,
  getRegenerationTarget,
  listChats,
  renameChat,
  setMessageVote,
  type Database,
} from './db.js'
import type { CurrentUser } from './domain.js'
import {
  GenerationRejectedError,
  GenerationService,
} from './generation.js'

const APP_BASE = '/ai-chatbot/'
const API_BASE = '/ai-chatbot/api'
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ErrorBody = {
  error: {
    code: string
    message: string
    requestId: string
  }
}

function errorBody(
  request: FastifyRequest,
  code: string,
  message: string,
): ErrorBody {
  return {
    error: {
      code,
      message,
      requestId: request.id,
    },
  }
}

function readObjectBody(request: FastifyRequest): Record<string, unknown> {
  if (
    !request.body ||
    typeof request.body !== 'object' ||
    Array.isArray(request.body)
  ) {
    return {}
  }

  return request.body as Record<string, unknown>
}

function requireUuid(
  request: FastifyRequest,
  reply: FastifyReply,
  value: unknown,
  name: string,
): string | null {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    void reply.code(400).send(
      errorBody(request, 'invalid_request', `${name} must be a UUID`),
    )
    return null
  }

  return value
}

function requireText(
  request: FastifyRequest,
  reply: FastifyReply,
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''

  if (!normalized || normalized.length > maxLength) {
    void reply.code(400).send(
      errorBody(
        request,
        'invalid_request',
        `${name} must be between 1 and ${maxLength} characters`,
      ),
    )
    return null
  }

  return normalized
}

function sendStringStream(
  reply: FastifyReply,
  stream: ReadableStream<string>,
  generationId: string,
  streamId: string,
) {
  reply.headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-generation-id': generationId,
    'x-stream-id': streamId,
  })

  return reply.send(
    Readable.from(stream as unknown as AsyncIterable<string>),
  )
}

export type AppDependencies = {
  config: AppConfig
  database: Database
  redis: RedisClient
  generations: GenerationService
}

export async function buildApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const {
    config,
    database,
    redis,
    generations,
  } = dependencies
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError) {
      return reply.code(error.statusCode).send(
        errorBody(request, error.code, error.message),
      )
    }

    if (error instanceof GenerationRejectedError) {
      return reply.code(error.statusCode).send(
        errorBody(request, error.code, error.message),
      )
    }

    const httpError = error as {
      statusCode?: unknown
      message?: unknown
    }
    const statusCode =
      typeof httpError.statusCode === 'number'
        ? httpError.statusCode
        : 500

    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(
        errorBody(
          request,
          'invalid_request',
          typeof httpError.message === 'string'
            ? httpError.message
            : 'Invalid request',
        ),
      )
    }

    request.log.error({ err: error }, 'Request failed')
    return reply.code(500).send(
      errorBody(request, 'internal_error', 'Internal server error'),
    )
  })

  const authenticate = async (
    request: FastifyRequest,
  ): Promise<CurrentUser> => {
    const user = await resolveCurrentUser(
      request,
      config,
      database,
    )
    void cacheUserProfile(redis, config, user).catch(() => undefined)
    return user
  }

  app.get(`${API_BASE}/health`, async (_request, reply) => {
    let postgres = 'ok'

    try {
      await checkDatabase(database)
    } catch {
      postgres = 'unavailable'
    }

    const redisStatus = redis.isReady ? 'ok' : 'unavailable'
    const status =
      postgres === 'ok' && redisStatus === 'ok'
        ? 'ok'
        : postgres === 'ok'
          ? 'degraded'
          : 'unavailable'

    if (postgres !== 'ok') {
      reply.code(503)
    }

    return {
      status,
      service: 'ai-chatbot',
      commit: process.env.APP_COMMIT ?? 'local',
      authMode: config.gpas2AuthMode,
      dependencies: {
        postgres,
        redis: redisStatus,
      },
      time: new Date().toISOString(),
    }
  })

  app.get(`${API_BASE}/me`, async (request) => {
    return authenticate(request)
  })

  app.get(`${API_BASE}/chats`, async (request) => {
    const user = await authenticate(request)
    return {
      chats: await listChats(database, user.id),
    }
  })

  app.post(`${API_BASE}/chats`, async (request, reply) => {
    const user = await authenticate(request)
    const body = readObjectBody(request)
    const title = requireText(
      request,
      reply,
      body.title,
      'title',
      200,
    )

    if (!title) {
      return
    }

    return reply.code(201).send(
      await createChat(database, user.id, title),
    )
  })

  app.get<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId`, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(
      request,
      reply,
      request.params.chatId,
      'chatId',
    )

    if (!chatId) {
      return
    }

    const chat = await getChatDetail(database, user.id, chatId)

    if (!chat) {
      return reply.code(404).send(
        errorBody(request, 'chat_not_found', 'Chat not found'),
      )
    }

    return chat
  })

  app.patch<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId`, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(
      request,
      reply,
      request.params.chatId,
      'chatId',
    )

    if (!chatId) {
      return
    }

    const title = requireText(
      request,
      reply,
      readObjectBody(request).title,
      'title',
      200,
    )

    if (!title) {
      return
    }

    const chat = await renameChat(
      database,
      user.id,
      chatId,
      title,
    )

    if (!chat) {
      return reply.code(404).send(
        errorBody(request, 'chat_not_found', 'Chat not found'),
      )
    }

    return chat
  })

  app.delete<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId`, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(
      request,
      reply,
      request.params.chatId,
      'chatId',
    )

    if (!chatId) {
      return
    }

    if (!(await deleteChat(database, user.id, chatId))) {
      return reply.code(404).send(
        errorBody(request, 'chat_not_found', 'Chat not found'),
      )
    }

    return reply.code(204).send()
  })

  app.put<{
    Params: { messageId: string }
  }>(`${API_BASE}/messages/:messageId/vote`, async (request, reply) => {
    const user = await authenticate(request)
    const messageId = requireUuid(
      request,
      reply,
      request.params.messageId,
      'messageId',
    )

    if (!messageId) {
      return
    }

    const isUpvoted = readObjectBody(request).isUpvoted

    if (typeof isUpvoted !== 'boolean') {
      return reply.code(400).send(
        errorBody(request, 'invalid_is_upvoted', 'isUpvoted must be a boolean'),
      )
    }

    const vote = await setMessageVote(database, user.id, messageId, isUpvoted)

    if (!vote) {
      return reply.code(404).send(
        errorBody(request, 'message_not_found', 'Assistant message not found'),
      )
    }

    return { vote }
  })

  app.delete<{
    Params: { messageId: string }
  }>(`${API_BASE}/messages/:messageId/vote`, async (request, reply) => {
    const user = await authenticate(request)
    const messageId = requireUuid(
      request,
      reply,
      request.params.messageId,
      'messageId',
    )

    if (!messageId) {
      return
    }

    await deleteMessageVote(database, user.id, messageId)
    return reply.code(204).send()
  })

  app.post<{
    Params: { messageId: string }
  }>(`${API_BASE}/messages/:messageId/regenerate`, async (request, reply) => {
    const user = await authenticate(request)
    const messageId = requireUuid(
      request,
      reply,
      request.params.messageId,
      'messageId',
    )
    const requestId = requireUuid(
      request,
      reply,
      readObjectBody(request).requestId,
      'requestId',
    )

    if (!messageId || !requestId) {
      return
    }

    const target = await getRegenerationTarget(database, user.id, messageId)

    if (!target) {
      return reply.code(404).send(
        errorBody(request, 'message_not_found', 'Assistant message not found'),
      )
    }


    const withinLimit = await consumeGenerationRateLimit(
      redis,
      config,
      user.id,
      request.ip,
    )

    if (!withinLimit) {
      throw new GenerationRejectedError(
        'Too many generation requests',
        429,
        'generation_rate_limited',
      )
    }

    const started = await generations.create({
      user,
      chatId: target.chatId,
      content: '',
      clientMessageId: requestId,
      ip: request.ip,
      replacesMessageId: messageId,
    })

    return reply.code(201).send(started)
  })

  app.post<{
    Params: { chatId: string }
  }>(
    `${API_BASE}/chats/:chatId/generations`,
    async (request, reply) => {
      const user = await authenticate(request)
      const chatId = requireUuid(
        request,
        reply,
        request.params.chatId,
        'chatId',
      )

      if (!chatId) {
        return
      }

      const body = readObjectBody(request)
      const content = requireText(
        request,
        reply,
        body.content,
        'content',
        32_000,
      )
      const clientMessageId = requireUuid(
        request,
        reply,
        body.clientMessageId,
        'clientMessageId',
      )

      if (!content || !clientMessageId) {
        return
      }
      const supersedesGenerationId =
        body.supersedesGenerationId === undefined
          ? undefined
          : requireUuid(
              request,
              reply,
              body.supersedesGenerationId,
              'supersedesGenerationId',
            )

      if (
        body.supersedesGenerationId !== undefined &&
        !supersedesGenerationId
      ) {
        return
      }

      if (!redis.isReady) {
        throw new GenerationRejectedError(
          'Generation is temporarily unavailable',
          503,
          'redis_unavailable',
        )
      }

      const withinLimit = await consumeGenerationRateLimit(
        redis,
        config,
        user.id,
        request.ip,
      )

      if (!withinLimit) {
        throw new GenerationRejectedError(
          'Too many generation requests',
          429,
          'generation_rate_limited',
        )
      }

      const started = await generations.create({
        user,
        chatId,
        content,
        clientMessageId,
        ip: request.ip,
        supersedesGenerationId: supersedesGenerationId || undefined,
      })

      return reply.code(201).send(started)
    },
  )

  app.get<{
    Params: { generationId: string }
    Querystring: { resumeAt?: string }
  }>(`${API_BASE}/generations/:generationId/stream`, async (request, reply) => {
    const user = await authenticate(request)
    const generationId = requireUuid(
      request,
      reply,
      request.params.generationId,
      'generationId',
    )

    if (!generationId) {
      return
    }

    const generation = await getGeneration(
      database,
      user.id,
      generationId,
    )

    if (!generation?.streamId) {
      return reply.code(404).send(
        errorBody(
          request,
          'generation_not_found',
          'Generation not found',
        ),
      )
    }

    const resumeAtRaw = request.query.resumeAt ?? '0'
    const resumeAt = Number(resumeAtRaw)

    if (
      !Number.isSafeInteger(resumeAt) ||
      resumeAt < 0
    ) {
      return reply.code(400).send(
        errorBody(
          request,
          'invalid_request',
          'resumeAt must be a non-negative integer',
        ),
      )
    }

    if (!redis.isReady) {
      return reply.code(503).send(
        errorBody(
          request,
          'redis_unavailable',
          'Stream resume is temporarily unavailable',
        ),
      )
    }

    const stream = await generations.resume(
      generation.streamId,
      resumeAt,
    )

    if (stream === undefined) {
      return reply.code(404).send(
        errorBody(request, 'stream_not_found', 'Stream not found'),
      )
    }

    if (stream === null) {
      return reply.code(410).send(
        errorBody(
          request,
          'stream_completed',
          'Generation is complete; refetch the chat',
        ),
      )
    }

    return sendStringStream(
      reply,
      stream,
      generationId,
      generation.streamId,
    )
  })

  app.get<{
    Params: { generationId: string }
  }>(
    `${API_BASE}/generations/:generationId`,
    async (request, reply) => {
      const user = await authenticate(request)
      const generationId = requireUuid(
        request,
        reply,
        request.params.generationId,
        'generationId',
      )

      if (!generationId) {
        return
      }

      const generation = await getGeneration(
        database,
        user.id,
        generationId,
      )

      if (!generation) {
        return reply.code(404).send(
          errorBody(
            request,
            'generation_not_found',
            'Generation not found',
          ),
        )
      }

      return generation
    },
  )

  app.post<{
    Params: { generationId: string }
  }>(
    `${API_BASE}/generations/:generationId/cancel`,
    async (request, reply) => {
      const user = await authenticate(request)
      const generationId = requireUuid(
        request,
        reply,
        request.params.generationId,
        'generationId',
      )

      if (!generationId) {
        return
      }

      const generation = await generations.cancel(
        user.id,
        generationId,
      )

      if (!generation) {
        return reply.code(404).send(
          errorBody(
            request,
            'generation_not_found',
            'Generation not found',
          ),
        )
      }

      return reply
        .code(generation.effectiveStatus === 'cancelling' ? 202 : 200)
        .send(generation)
    },
  )

  if (config.serveClient) {
    const currentDirectory = path.dirname(
      fileURLToPath(import.meta.url),
    )
    const clientDirectory = path.resolve(
      currentDirectory,
      '../client',
    )

    await app.register(fastifyStatic, {
      root: clientDirectory,
      prefix: APP_BASE,
      maxAge: '30d',
      immutable: true,
      setHeaders(reply, filePath) {
        if (filePath.endsWith('index.html')) {
          reply.header(
            'Cache-Control',
            'no-cache, no-store, must-revalidate',
          )
        }
      },
    })

    app.get('/ai-chatbot', async (_request, reply) => {
      return reply.redirect(APP_BASE)
    })

    app.setNotFoundHandler(async (request, reply) => {
      const acceptsHtml =
        request.headers.accept?.includes('text/html') ?? false
      const isClientRoute =
        request.method === 'GET' &&
        request.url.startsWith(APP_BASE)
      const isApiRoute = request.url.startsWith(`${API_BASE}/`)

      if (isClientRoute && !isApiRoute && acceptsHtml) {
        return reply
          .type('text/html; charset=utf-8')
          .sendFile('index.html', {
            maxAge: 0,
            immutable: false,
          })
      }

      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'Not Found',
          requestId: request.id,
        },
      })
    })
  }

  return app
}
