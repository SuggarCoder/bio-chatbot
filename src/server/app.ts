import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AuthenticationError, loadProfile, resolveCurrentUser } from './auth.js'
import { GpasService, GpasUpstreamError, profileReply } from './gpas.js'
import { SemanticIntentRouter } from './gpasIntent.js'
import { LocalEmbeddingService } from './embedding.js'
import { projectInputSchema } from './gpasContracts.js'
import {
  redisKey,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import {
  createChat,
  createBusinessExchange,
  syncUser,
  checkDatabase,
  deleteMessageVote,
  deleteChat,
  getChatDetail,
  getChatMessagesPage,
  getGeneration,
  getGenerationAssistantMessage,
  getRegenerationTarget,
  getSharedChat,
  listChats,
  renameChat,
  setMessageVote,
  shareChat,
  unshareChat,
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
import {
  generationStreamKey,
  type GenerationStreamHub,
} from './streamStore.js'

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
  intentRouter?: SemanticIntentRouter
  config: AppConfig
  database: Database
  redis: RedisClient
  generations: GenerationService
  streamHub: GenerationStreamHub
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
    streamHub,
    objectStore,
    artifactService,
  } = dependencies
  const app = Fastify({
    logger: true,
    requestTimeout: 120_000,
    bodyLimit: 64 * 1024,
  })
  const gpas = new GpasService(config)
  const intentRouter = dependencies.intentRouter ?? new SemanticIntentRouter(new LocalEmbeddingService(config))

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GpasUpstreamError) {
      request.log.warn({ gpas: error.diagnostics }, 'GPAS upstream request failed')
    }
    if (error instanceof AuthenticationError) {
      return reply.code(error.statusCode).send(
        errorBody(request, error.code, error.message),
      )
    }

    if (error instanceof GenerationRejectedError) {
      if (error.retryAfterMs) {
        reply.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
        )
      }
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
    const worker = redis.isReady && await redis.exists(
      redisKey(config, 'worker:heartbeat'),
    ) > 0 ? 'ok' : 'unavailable'
    const tokenizerRequired = config.contextMemoryEnabled ||
      config.userMemoryEnabled ||
      config.artifactContextV2Enabled
    const tokenizer = !tokenizerRequired
      ? 'disabled'
      : existsSync(path.resolve(config.qwenTokenizerPath, 'tokenizer.json'))
        ? 'ok'
        : 'unavailable'
    const embeddings = intentRouter.ready
        ? 'ok'
        : 'unavailable'
    const status =
      postgres === 'ok' && redisStatus === 'ok'
        && objectStorage !== 'unavailable' && worker === 'ok'
        && tokenizer !== 'unavailable' && embeddings !== 'unavailable'
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
        worker,
        tokenizer,
        embeddings,
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
  }>(`${API_BASE}/conversations/:chatId/artifacts`, {
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
        'text/html': '.html',
        'image/svg+xml': '.svg',
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

  app.post<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version/restore`, {
    schema: {
      params: httpSchemas.artifactVersionParams,
      response: httpSchemas.restoreArtifactVersionResponse,
    },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const artifactId = requireUuid(
      request,
      reply,
      request.params.artifactId,
      'artifactId',
    )
    const restoreRequestId = requireUuid(
      request,
      reply,
      request.headers['idempotency-key'],
      'Idempotency-Key',
    )
    const sourceVersion = Number(request.params.version)
    if (!artifactId || !restoreRequestId) return
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      return reply.code(400).send(
        errorBody(request, 'invalid_request', 'version must be a positive integer'),
      )
    }
    if (!artifactService) {
      return reply.code(503).send(
        errorBody(
          request,
          'artifact_storage_unavailable',
          'Artifact storage is unavailable',
        ),
      )
    }
    try {
      const restored = await artifactService.restoreVersion(
        user.id,
        artifactId,
        sourceVersion,
        restoreRequestId,
      )
      return reply.code(restored.created ? 201 : 200).send({
        artifactId: restored.artifactId,
        version: restored.version,
      })
    } catch (error) {
      if (error instanceof ArtifactServiceError) {
        const status = error.code === 'ARTIFACT_NOT_FOUND'
          ? 404
          : error.code === 'ARTIFACT_VERSION_CONFLICT'
            ? 409
            : 503
        return reply.code(status).send(errorBody(
          request,
          error.code.toLocaleLowerCase(),
          error.message,
        ))
      }
      throw error
    }
  })

  app.get<{
    Params: { artifactId: string; version: string }
  }>(`${API_BASE}/artifacts/:artifactId/versions/:version/download`, {
    schema: { params: httpSchemas.artifactVersionParams },
  }, (request, reply) =>
    readArtifactVersion(request, reply, true),
  )

  app.get(`${API_BASE}/conversations`, {
    schema: { response: httpSchemas.chatsResponse },
  }, async (request) => {
    const user = await authenticate(request)
    return {
      conversations: await listChats(database, user.id),
    }
  })

  app.post(`${API_BASE}/conversations`, {
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
  }>(`${API_BASE}/conversations/:chatId`, {
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
  }>(`${API_BASE}/conversations/:chatId/messages`, {
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
  }>(`${API_BASE}/conversations/:chatId`, {
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
  }>(`${API_BASE}/conversations/:chatId`, {
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

  app.post<{
    Params: { chatId: string }
  }>(`${API_BASE}/conversations/:chatId/share`, {
    schema: {
      params: httpSchemas.chatIdParams,
      body: httpSchemas.shareChat.body,
      response: httpSchemas.shareChat.response,
    },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(request, reply, request.params.chatId, 'chatId')
    if (!chatId) return
    const mode = readObjectBody(request).mode
    if (mode !== 'snapshot' && mode !== 'live') {
      return reply.code(400).send(
        errorBody(request, 'invalid_share_mode', 'mode must be snapshot or live'),
      )
    }
    const shared = await shareChat(database, user.id, chatId, mode)
    if (!shared) {
      return reply.code(404).send(
        errorBody(request, 'conversation_not_found', 'Conversation not found'),
      )
    }
    return {
      ...shared,
      sharePath: `${APP_BASE}shared/${shared.shareSlug}`,
    }
  })

  app.delete<{
    Params: { chatId: string }
  }>(`${API_BASE}/conversations/:chatId/share`, {
    schema: { params: httpSchemas.chatIdParams },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const chatId = requireUuid(request, reply, request.params.chatId, 'chatId')
    if (!chatId) return
    if (!await unshareChat(database, user.id, chatId)) {
      return reply.code(404).send(
        errorBody(request, 'conversation_not_found', 'Conversation not found'),
      )
    }
    return reply.code(204).send()
  })

  app.get<{
    Params: { shareSlug: string }
  }>(`${API_BASE}/shared/conversations/:shareSlug`, {
    schema: {
      params: httpSchemas.shareSlugParams,
      response: httpSchemas.sharedConversationResponse,
    },
  }, async (request, reply) => {
    const user = await authenticate(request)
    const shareSlug = request.params.shareSlug
    if (!/^[A-Za-z0-9_-]{32}$/.test(shareSlug)) {
      return reply.code(400).send(
        errorBody(request, 'invalid_share_slug', 'Invalid share identifier'),
      )
    }
    const shared = await getSharedChat(database, user.id, shareSlug)
    if (!shared) {
      return reply.code(404).send(
        errorBody(request, 'shared_conversation_not_found', 'Shared conversation not found'),
      )
    }
    return shared
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
  }>(`${API_BASE}/messages/:messageId/regenerations`, {
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
      request.headers['idempotency-key'],
      'Idempotency-Key',
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


    const started = await generations.create({
      user,
      chatId: target.chatId,
      content: '',
      clientMessageId: requestId,
      artifactId: artifactId || undefined,
      replacesMessageId: messageId,
    })

    return reply.code(201).send(started)
  })

  app.post<{
    Params: { chatId: string }
  }>(
    `${API_BASE}/conversations/:chatId/messages`,
    {
      schema: {
        params: httpSchemas.chatIdParams,
        body: httpSchemas.createGeneration.body,
        response: httpSchemas.createGeneration.response,
      },
    },
    async (request, reply) => {
      const profile = await loadProfile(request, config)
      const user = await syncUser(database, profile)
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
        request.headers['idempotency-key'],
        'Idempotency-Key',
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

      const projectInput = body.projectInput === undefined ? undefined : projectInputSchema.parse(body.projectInput)
      const decision = projectInput ? undefined : await intentRouter.classify(content)
      const intent = decision?.intent
      if (decision) request.log.info({ intent: decision.intent, scores: decision.scores, margin: decision.margin }, 'Semantic business intent classified')
      if (projectInput || intent) {
        const result = await createBusinessExchange(database, {
          userId: user.id, chatId, clientMessageId,
          content: projectInput ? '确认初始化项目' : content,
          teamId: profile.ownteamId, sourceMessageId: projectInput?.sourceMessageId,
        }, async (form) => {
          if (projectInput) return gpas.create(profile, request.headers.cookie, projectInput, form!)
          if (intent === 'profile') return { content: profileReply(profile), part: { type: 'gpas', order: 1 } }
          return gpas.progress(profile, request.headers.cookie)
        })
        return reply.code(201).send(result)
      }

      const started = await generations.create({
        user,
        chatId,
        content,
        clientMessageId,
        artifactId: artifactId || undefined,
        supersedesGenerationId: supersedesGenerationId || undefined,
      })

      return reply.code(201).send(started)
    },
  )

  app.get<{
    Params: { generationId: string }
  }>(`${API_BASE}/generations/:generationId/stream`, {
    schema: {
      params: httpSchemas.generationIdParams,
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

    if ([
      'completed', 'cancelled', 'failed', 'interrupted', 'timed_out',
    ].includes(generation.status)) {
      const assistantMessage = await getGenerationAssistantMessage(
        database,
        user.id,
        generationId,
      )
      const payload = {
        type: 'message.finish',
        generationId,
        streamId: generation.streamId,
        messageId: assistantMessage?.id ?? generationId,
        eventId: 1,
        finishReason: generation.status === 'completed'
          ? 'stop'
          : generation.status === 'cancelled'
            ? 'cancelled'
            : 'error',
        assistantMessage,
        ...(generation.status === 'completed' || generation.status === 'cancelled'
          ? {}
          : {
              error: {
                code: generation.errorCode ?? `generation_${generation.status}`,
                message: generation.errorMessage ?? 'Generation did not complete',
              },
            }),
      }
      const body = `id: 0-1\nevent: message.finish\ndata: ${JSON.stringify(payload)}\n\n`
      return sendStringStream(
        reply,
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue(body)
            controller.close()
          },
        }),
        generationId,
        generation.streamId,
      )
    }

    const cursor = request.headers['last-event-id'] ?? '0-0'

    if (typeof cursor !== 'string' || !/^\d+-\d+$/.test(cursor)) {
      return reply.code(400).send(
        errorBody(
          request,
          'invalid_request',
          'Last-Event-ID must be a Redis Stream ID',
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

    const stream = streamHub.subscribe(user.id, generationId, cursor)

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
        response: httpSchemas.generationStatusResponse,
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

      const [assistantMessage, streamAvailable] = await Promise.all([
        getGenerationAssistantMessage(database, user.id, generationId),
        redis.isReady
          ? redis.exists(generationStreamKey(config, user.id, generationId))
              .then((count) => count > 0)
              .catch(() => false)
          : Promise.resolve(false),
      ])

      return { ...generation, streamAvailable, assistantMessage }
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
