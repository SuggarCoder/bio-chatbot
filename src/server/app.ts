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
  getChatMessagesPage,
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
import { ARTIFACT_BODY_MAX_BYTES } from './artifacts/protocol.js'
import {
  getArtifactForUser,
  listArtifactsForChat,
  listArtifactVersionsForUser,
} from './artifacts/repository.js'
import { httpSchemas } from './httpSchemas.js'

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

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : null
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

async function readBoundedText(
  stream: Readable,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      stream.destroy()
      throw new Error('Stored Artifact exceeds the supported preview size')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function createStorageAbortScope(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const controller = new AbortController()
  const cleanup = () => {
    request.raw.removeListener('aborted', abort)
    reply.raw.removeListener('close', abort)
    reply.raw.removeListener('finish', cleanup)
  }
  const abort = () => {
    controller.abort()
    cleanup()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)
  reply.raw.once('finish', cleanup)
  return { signal: controller.signal, cleanup }
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
    trustProxy: config.trustedProxyCidrs,
    requestTimeout: 120_000,
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
    return user
  }

  const enforceGenerationRateLimit = async (
    request: FastifyRequest,
    reply: FastifyReply,
    user: CurrentUser,
  ): Promise<void> => {
    if (!redis.isReady) {
      throw new GenerationRejectedError(
        'Generation is temporarily unavailable',
        503,
        'redis_unavailable',
      )
    }

    const result = await consumeGenerationRateLimit(
      redis,
      config,
      user.id,
      request.ip,
    )

    if (!result.allowed) {
      reply.header(
        'Retry-After',
        String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))),
      )
      throw new GenerationRejectedError(
        'Too many generation requests',
        429,
        'generation_rate_limited',
      )
    }
  }

  app.get(
    `${API_BASE}/health`,
    { schema: httpSchemas.health },
    async (_request, reply) => {
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

    if (status !== 'ok') {
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
    },
  )

  app.get(`${API_BASE}/me`, { schema: httpSchemas.me }, async (request) => {
    return authenticate(request)
  })

  app.get<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId/artifacts`, {
    schema: {
      params: httpSchemas.chatIdParams,
      response: httpSchemas.artifactListResponse,
    },
  }, async (request, reply) => {
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
  }>(`${API_BASE}/artifacts/:artifactId`, {
    schema: {
      params: httpSchemas.artifactIdParams,
      response: httpSchemas.artifactDetailResponse,
    },
  }, async (request, reply) => {
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
      const abortScope = createStorageAbortScope(request, reply)
      try {
        const version = await artifactService.readVersion(
          user.id,
          artifactId,
          artifact.currentVersion,
          abortScope.signal,
        )
        if (version) {
          content = await readBoundedText(
            version.stored.body,
            ARTIFACT_BODY_MAX_BYTES,
          )
        }
      } finally {
        abortScope.cleanup()
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
  }>(`${API_BASE}/artifacts/:artifactId/versions`, {
    schema: {
      params: httpSchemas.artifactIdParams,
      response: httpSchemas.artifactVersionsResponse,
    },
  }, async (request, reply) => {
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

    const abortScope = createStorageAbortScope(request, reply)
    const version = await artifactService.readVersion(
      user.id,
      artifactId,
      versionNumber,
      abortScope.signal,
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

    if (version.record.byteLength > BigInt(ARTIFACT_BODY_MAX_BYTES)) {
      version.stored.body.destroy()
      return reply.code(413).send(
        errorBody(
          request,
          'artifact_preview_too_large',
          'Artifact is too large for JSON preview; use the download endpoint',
        ),
      )
    }
    const content = await readBoundedText(
      version.stored.body,
      ARTIFACT_BODY_MAX_BYTES,
    )
    abortScope.cleanup()
    const { storageKey: _storageKey, ...publicRecord } = version.record
    return {
      ...publicRecord,
      byteLength: Number(version.record.byteLength),
      createdAt: version.record.createdAt.toISOString(),
      content,
    }
  }

  app.get<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version`, {
    schema: {
      params: httpSchemas.artifactVersionParams,
      response: httpSchemas.artifactVersionResponse,
    },
  }, (request, reply) =>
    readArtifactVersion(request, reply, false),
  )

  app.get<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version/download`, {
    schema: { params: httpSchemas.artifactVersionParams },
  }, (request, reply) =>
    readArtifactVersion(request, reply, true),
  )

  app.get(`${API_BASE}/chats`, {
    schema: { response: httpSchemas.chatsResponse },
  }, async (request) => {
    const user = await authenticate(request)
    return {
      chats: await listChats(database, user.id),
    }
  })

  app.post(`${API_BASE}/chats`, {
    schema: httpSchemas.createChat,
  }, async (request, reply) => {
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
  }>(`${API_BASE}/chats/:chatId`, {
    schema: {
      params: httpSchemas.chatIdParams,
      response: httpSchemas.chatDetailResponse,
    },
  }, async (request, reply) => {
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

  app.get<{
    Params: { chatId: string }
    Querystring: { beforeSeq?: string; limit?: string }
  }>(`${API_BASE}/chats/:chatId/messages`, {
    schema: {
      params: httpSchemas.chatIdParams,
      querystring: httpSchemas.messagePageQuery,
      response: httpSchemas.messagePageResponse,
    },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(
      request,
      reply,
      request.params.chatId,
      'chatId',
    )
    const beforeSeq = parsePositiveInteger(
      request.query.beforeSeq,
      0,
      Number.MAX_SAFE_INTEGER,
    )
    const limit = parsePositiveInteger(request.query.limit, 50, 100)

    if (!chatId || beforeSeq === null || beforeSeq === 0 || limit === null) {
      if (chatId && (beforeSeq === null || beforeSeq === 0 || limit === null)) {
        return reply.code(400).send(
          errorBody(
            request,
            'invalid_request',
            'beforeSeq must be a positive integer and limit must be between 1 and 100',
          ),
        )
      }
      return
    }

    const page = await getChatMessagesPage(
      database,
      user.id,
      chatId,
      beforeSeq,
      limit,
    )
    if (!page) {
      return reply.code(404).send(
        errorBody(request, 'chat_not_found', 'Chat not found'),
      )
    }
    return page
  })

  app.patch<{
    Params: { chatId: string }
  }>(`${API_BASE}/chats/:chatId`, {
    schema: {
      params: httpSchemas.chatIdParams,
      body: httpSchemas.renameChat.body,
      response: httpSchemas.renameChat.response,
    },
  }, async (request, reply) => {
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
  }>(`${API_BASE}/chats/:chatId`, {
    schema: { params: httpSchemas.chatIdParams },
  }, async (request, reply) => {
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
  }>(`${API_BASE}/messages/:messageId/vote`, {
    schema: {
      params: httpSchemas.messageIdParams,
      body: httpSchemas.vote.body,
      response: httpSchemas.vote.response,
    },
  }, async (request, reply) => {
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
  }>(`${API_BASE}/messages/:messageId/vote`, {
    schema: { params: httpSchemas.messageIdParams },
  }, async (request, reply) => {
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
  }>(`${API_BASE}/messages/:messageId/regenerate`, {
    schema: {
      params: httpSchemas.messageIdParams,
      body: httpSchemas.regenerate.body,
      response: httpSchemas.regenerate.response,
    },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const body = readObjectBody(request)
    const messageId = requireUuid(
      request,
      reply,
      request.params.messageId,
      'messageId',
    )
    const requestId = requireUuid(
      request,
      reply,
      body.requestId,
      'requestId',
    )
    const artifactId = body.artifactId === undefined
      ? undefined
      : requireUuid(request, reply, body.artifactId, 'artifactId')

    if (
      !messageId ||
      !requestId ||
      (body.artifactId !== undefined && !artifactId)
    ) {
      return
    }

    const target = await getRegenerationTarget(database, user.id, messageId)

    if (!target) {
      return reply.code(404).send(
        errorBody(request, 'message_not_found', 'Assistant message not found'),
      )
    }


    await enforceGenerationRateLimit(request, reply, user)

    const started = await generations.create({
      user,
      chatId: target.chatId,
      content: '',
      clientMessageId: requestId,
      ip: request.ip,
      artifactId: artifactId || undefined,
      replacesMessageId: messageId,
    })

    return reply.code(201).send(started)
  })

  app.post<{
    Params: { chatId: string }
  }>(
    `${API_BASE}/chats/:chatId/generations`,
    {
      schema: {
        params: httpSchemas.chatIdParams,
        body: httpSchemas.createGeneration.body,
        response: httpSchemas.createGeneration.response,
      },
    },
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
      const artifactId = body.artifactId === undefined
        ? undefined
        : requireUuid(request, reply, body.artifactId, 'artifactId')

      if (
        !content ||
        !clientMessageId ||
        (body.artifactId !== undefined && !artifactId)
      ) {
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

      await enforceGenerationRateLimit(request, reply, user)

      const started = await generations.create({
        user,
        chatId,
        content,
        clientMessageId,
        ip: request.ip,
        artifactId: artifactId || undefined,
        supersedesGenerationId: supersedesGenerationId || undefined,
      })

      return reply.code(201).send(started)
    },
  )

  app.get<{
    Params: { generationId: string }
    Querystring: { resumeAt?: string }
  }>(`${API_BASE}/generations/:generationId/stream`, {
    schema: {
      params: httpSchemas.generationIdParams,
      querystring: httpSchemas.streamQuery,
    },
  }, async (request, reply) => {
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

    const releaseSubscriber = generations.trackSubscriber(generationId)
    reply.raw.once('close', releaseSubscriber)

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
    {
      schema: {
        params: httpSchemas.generationIdParams,
        response: httpSchemas.generationResponse,
      },
    },
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
    {
      schema: {
        params: httpSchemas.generationIdParams,
        response: httpSchemas.generationResponse,
      },
    },
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
