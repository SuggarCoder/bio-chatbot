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
import type { ObjectStore } from './storage/objectStore.js'
import {
  ArtifactService,
  ArtifactServiceError,
} from './artifacts/service.js'
import {
  getArtifactForUser,
  listArtifactsForChat,
  listArtifactVersionsForUser,
} from './artifacts/repository.js'

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
  objectStore: ObjectStore | null
  artifactService: ArtifactService | null
}

export async function buildApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const {
    config,
    database,
    redis,
    generations,
    objectStore,
    artifactService,
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

    if (error instanceof ArtifactServiceError) {
      return reply.code(503).send(
        errorBody(request, 'artifact_storage_unavailable', error.message),
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
    let objectStorage = objectStore ? 'ok' : 'disabled'

    await Promise.all([
      checkDatabase(database).catch(() => {
        postgres = 'unavailable'
      }),
      objectStore?.healthCheck().catch(() => {
        objectStorage = 'unavailable'
      }),
    ])

    const redisStatus = redis.isReady ? 'ok' : 'unavailable'
    const status =
      postgres === 'ok' && redisStatus === 'ok'
        && objectStorage !== 'unavailable'
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
        objectStorage,
      },
      time: new Date().toISOString(),
    }
  })

  app.get(`${API_BASE}/me`, async (request) => {
    return authenticate(request)
  })

  app.get<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId/artifacts`, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(request, reply, request.params.chatId, 'chatId')
    if (!chatId) return

    const rows = await listArtifactsForChat(database, user.id, chatId)
    return {
      artifacts: rows.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      })),
    }
  })

  app.get<{
    Params: { artifactId: string }
  }>(`${API_BASE}/artifacts/:artifactId`, async (request, reply) => {
    const user = await authenticate(request)
    const artifactId = requireUuid(
      request,
      reply,
      request.params.artifactId,
      'artifactId',
    )
    if (!artifactId) return

    const artifact = await getArtifactForUser(database, user.id, artifactId)
    if (!artifact) {
      return reply.code(404).send(
        errorBody(request, 'artifact_not_found', 'Artifact not found'),
      )
    }

    let content: string | undefined
    if (artifactService && artifact.currentVersion > 0) {
      const version = await artifactService.readVersion(
        user.id,
        artifactId,
        artifact.currentVersion,
      )
      if (version) {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of version.stored.body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += bytes.length
          if (total > 1024 * 1024) {
            version.stored.body.destroy()
            throw new Error('Stored Artifact exceeds the v1 size limit')
          }
          chunks.push(bytes)
        }
        content = Buffer.concat(chunks).toString('utf8')
      }
    }

    return {
      ...artifact,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
      content,
    }
  })

  app.get<{
    Params: { artifactId: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions`, async (request, reply) => {
    const user = await authenticate(request)
    const artifactId = requireUuid(
      request,
      reply,
      request.params.artifactId,
      'artifactId',
    )
    if (!artifactId) return

    const artifact = await getArtifactForUser(database, user.id, artifactId)
    if (!artifact) {
      return reply.code(404).send(
        errorBody(request, 'artifact_not_found', 'Artifact not found'),
      )
    }
    const versions = await listArtifactVersionsForUser(
      database,
      user.id,
      artifactId,
    )
    return {
      versions: versions.map((version) => ({
        ...version,
        byteLength: Number(version.byteLength),
        createdAt: version.createdAt.toISOString(),
      })),
    }
  })

  const readArtifactVersion = async (
    request: FastifyRequest<{
      Params: { artifactId: string; version: string }
    }>,
    reply: FastifyReply,
    download: boolean,
  ) => {
    const user = await authenticate(request)
    const artifactId = requireUuid(
      request,
      reply,
      request.params.artifactId,
      'artifactId',
    )
    const versionNumber = Number(request.params.version)
    if (!artifactId) return
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      return reply.code(400).send(
        errorBody(request, 'invalid_request', 'version must be a positive integer'),
      )
    }
    if (!artifactService) {
      return reply.code(503).send(
        errorBody(request, 'artifact_storage_unavailable', 'Artifact storage is unavailable'),
      )
    }

    const version = await artifactService.readVersion(
      user.id,
      artifactId,
      versionNumber,
    )
    if (!version) {
      return reply.code(404).send(
        errorBody(request, 'artifact_version_not_found', 'Artifact version not found'),
      )
    }

    if (download) {
      const extension = {
        'text/markdown': '.md',
        'text/plain': '.txt',
        'text/html': '.html',
        'image/svg+xml': '.svg',
        'application/vnd.artifact.code': '.txt',
        'application/vnd.artifact.mermaid': '.mmd',
      }[version.record.type] ?? '.txt'
      const encodedTitle = encodeURIComponent(
        `${version.record.title}${extension}`,
      ).replaceAll("'", '%27')
      reply.headers({
        'content-type': version.record.type,
        'content-length': String(version.record.byteLength),
        'content-disposition': `attachment; filename="artifact-v${versionNumber}${extension}"; filename*=UTF-8''${encodedTitle}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      })
      return reply.send(version.stored.body)
    }

    const chunks: Buffer[] = []
    for await (const chunk of version.stored.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const { storageKey: _storageKey, ...publicRecord } = version.record
    return {
      ...publicRecord,
      byteLength: Number(version.record.byteLength),
      createdAt: version.record.createdAt.toISOString(),
      content: Buffer.concat(chunks).toString('utf8'),
    }
  }

  app.get<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version`, (request, reply) =>
    readArtifactVersion(request, reply, false),
  )

  app.get<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version/download`, (request, reply) =>
    readArtifactVersion(request, reply, true),
  )

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
