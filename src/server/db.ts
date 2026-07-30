import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PoolClient, QueryResultRow } from 'pg'
import pg from 'pg'

import type {
  ActiveGenerationDto,
  ChatDetailDto,
  ChatMessageDto,
  ChatSummaryDto,
  CurrentUser,
  GenerationDto,
  Gpas2UserInfo,
} from './domain.js'

const { Pool } = pg

export type Database = InstanceType<typeof Pool>

type UserRow = QueryResultRow & {
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
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function createDatabase(databaseUrl: string): Database {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
}

export async function withTransaction<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect()

  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function applySchema(database: Database, schemaPath?: string): Promise<void> {
  const targetPath =
    schemaPath ||
    path.resolve(process.cwd(), 'gpas2_chatbot_schema.sql')
  const schema = await readFile(targetPath, 'utf8')
  await database.query(schema)
}

export async function verifyCoreSchema(database: Database): Promise<void> {
  await database.query(
    `SELECT 1
       FROM "User" u
       LEFT JOIN "Chat" c ON false
       LEFT JOIN "Message_v2" m ON false
       LEFT JOIN "Generation" g ON false
       LEFT JOIN "UsageEvent" e ON false
      LIMIT 1`,
  )
}

export async function syncUser(
  database: Database,
  profile: Gpas2UserInfo,
): Promise<CurrentUser> {
  const result = await database.query<UserRow>(
    `INSERT INTO "User" (
       "externalUserId",
       "externalTeamId",
       "realName",
       "userName",
       "jobTitle",
       "researchField",
       "phone",
       "gpas2Role",
       "email",
       "name",
       "image",
       "deletedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $10, NULL)
     ON CONFLICT ("externalUserId")
     DO UPDATE SET
       "externalTeamId" = EXCLUDED."externalTeamId",
       "realName" = EXCLUDED."realName",
       "userName" = EXCLUDED."userName",
       "jobTitle" = EXCLUDED."jobTitle",
       "researchField" = EXCLUDED."researchField",
       "phone" = EXCLUDED."phone",
       "gpas2Role" = EXCLUDED."gpas2Role",
       "email" = EXCLUDED."email",
       "name" = EXCLUDED."name",
       "image" = EXCLUDED."image",
       "deletedAt" = NULL
     RETURNING
       "id",
       "externalUserId",
       "externalTeamId",
       "realName",
       "userName",
       "jobTitle",
       "researchField",
       "email",
       "name",
       "image",
       "gpas2Role"`,
    [
      profile.userId,
      profile.ownteamId || null,
      profile.realName || null,
      profile.userName || null,
      profile.jobTitle || null,
      profile.researchField || null,
      profile.phone || null,
      profile.role ?? null,
      profile.email || null,
      profile.image || null,
    ],
  )

  return result.rows[0] as CurrentUser
}

type ChatRow = QueryResultRow & {
  id: string
  title: string
  chatType: string
  status: string
  createdAt: Date | string
  updatedAt: Date | string
}

function mapChat(row: ChatRow): ChatSummaryDto {
  return {
    id: row.id,
    title: row.title,
    chatType: row.chatType,
    status: row.status,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  }
}

export async function listChats(
  database: Database,
  userId: string,
): Promise<ChatSummaryDto[]> {
  const result = await database.query<ChatRow>(
    `SELECT "id", "title", "chatType", "status", "createdAt", "updatedAt"
       FROM "Chat"
      WHERE "userId" = $1
        AND "deletedAt" IS NULL
      ORDER BY "updatedAt" DESC, "id" DESC
      LIMIT 100`,
    [userId],
  )

  return result.rows.map(mapChat)
}

export async function createChat(
  database: Database,
  userId: string,
  title: string,
): Promise<ChatSummaryDto> {
  const result = await database.query<ChatRow>(
    `INSERT INTO "Chat" ("userId", "title")
     VALUES ($1, $2)
     RETURNING "id", "title", "chatType", "status", "createdAt", "updatedAt"`,
    [userId, title],
  )

  return mapChat(result.rows[0])
}

export async function renameChat(
  database: Database,
  userId: string,
  chatId: string,
  title: string,
): Promise<ChatSummaryDto | null> {
  const result = await database.query<ChatRow>(
    `UPDATE "Chat"
        SET "title" = $3
      WHERE "id" = $1
        AND "userId" = $2
        AND "deletedAt" IS NULL
      RETURNING "id", "title", "chatType", "status", "createdAt", "updatedAt"`,
    [chatId, userId, title],
  )

  return result.rows[0] ? mapChat(result.rows[0]) : null
}

export async function deleteChat(
  database: Database,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE "Chat"
        SET "deletedAt" = now()
      WHERE "id" = $1
        AND "userId" = $2
        AND "deletedAt" IS NULL`,
    [chatId, userId],
  )

  return (result.rowCount ?? 0) > 0
}

type MessageRow = QueryResultRow & {
  id: string
  seq: string | number
  role: 'user' | 'assistant'
  parts: Array<{ type?: string; text?: string }>
  createdAt: Date | string
}

export function mapMessage(row: MessageRow): ChatMessageDto {
  const content = Array.isArray(row.parts)
    ? row.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    : ''

  return {
    id: row.id,
    seq: Number(row.seq),
    role: row.role,
    content,
    createdAt: asIso(row.createdAt),
  }
}

type ActiveGenerationRow = QueryResultRow & {
  id: string
  status: 'pending' | 'streaming'
  metadata: { streamId?: unknown }
}

export async function getChatDetail(
  database: Database,
  userId: string,
  chatId: string,
): Promise<ChatDetailDto | null> {
  const chatResult = await database.query<ChatRow>(
    `SELECT "id", "title", "chatType", "status", "createdAt", "updatedAt"
       FROM "Chat"
      WHERE "id" = $1
        AND "userId" = $2
        AND "deletedAt" IS NULL`,
    [chatId, userId],
  )

  if (!chatResult.rows[0]) {
    return null
  }

  const [messagesResult, generationResult] = await Promise.all([
    database.query<MessageRow>(
      `SELECT "id", "seq", "role", "parts", "createdAt"
         FROM "Message_v2"
        WHERE "chatId" = $1
          AND "role" IN ('user', 'assistant')
        ORDER BY "seq" ASC`,
      [chatId],
    ),
    database.query<ActiveGenerationRow>(
      `SELECT "id", "status", "metadata"
         FROM "Generation"
        WHERE "chatId" = $1
          AND "userId" = $2
          AND "status" IN ('pending', 'streaming')
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [chatId, userId],
    ),
  ])

  const generation = generationResult.rows[0]
  const streamId =
    generation &&
    typeof generation.metadata?.streamId === 'string'
      ? generation.metadata.streamId
      : null
  const activeGeneration: ActiveGenerationDto | null =
    generation && streamId
      ? {
          id: generation.id,
          streamId,
          status: generation.status,
        }
      : null

  return {
    ...mapChat(chatResult.rows[0]),
    messages: messagesResult.rows.map(mapMessage),
    activeGeneration,
  }
}

export async function ownsStream(
  database: Database,
  userId: string,
  streamId: string,
): Promise<boolean> {
  const result = await database.query(
    `SELECT 1
       FROM "Stream" s
       JOIN "Chat" c ON c."id" = s."chatId"
      WHERE s."id" = $1
        AND c."userId" = $2
        AND c."deletedAt" IS NULL`,
    [streamId, userId],
  )

  return Boolean(result.rows[0])
}

export type GenerationStart = {
  generationId: string
  streamId: string
  userMessage: ChatMessageDto
  reused: boolean
  status: string
}

export async function findGenerationStart(
  database: Database,
  userId: string,
  chatId: string,
  requestId: string,
): Promise<GenerationStart | null> {
  const result = await database.query<
    MessageRow & {
      generationId: string
      generationStatus: string
      metadata: { streamId?: unknown }
    }
  >(
    `SELECT
       m."id",
       m."seq",
       m."role",
       m."parts",
       m."createdAt",
       g."id" AS "generationId",
       g."status" AS "generationStatus",
       g."metadata"
     FROM "Generation" g
     JOIN "Chat" c
       ON c."id" = g."chatId"
     JOIN "Message_v2" m
       ON m."id" = g."userMessageId"
    WHERE g."requestId" = $1
      AND g."chatId" = $2
      AND g."userId" = $3
      AND c."deletedAt" IS NULL`,
    [requestId, chatId, userId],
  )
  const row = result.rows[0]
  const streamId =
    row && typeof row.metadata?.streamId === 'string'
      ? row.metadata.streamId
      : null

  if (!row || !streamId) {
    return null
  }

  return {
    generationId: row.generationId,
    streamId,
    userMessage: mapMessage(row),
    reused: true,
    status: row.generationStatus,
  }
}

export async function createGenerationStart(
  database: Database,
  input: {
    userId: string
    chatId: string
    clientMessageId: string
    content: string
    generationId: string
    streamId: string
    requestId: string
    provider: string
    model: string
  },
): Promise<GenerationStart> {
  return withTransaction(database, async (client) => {
    const sequenceResult = await client.query<{ seq: string }>(
      `UPDATE "Chat"
          SET "nextMessageSeq" = "nextMessageSeq" + 1,
              "contextRevision" = "contextRevision" + 1
        WHERE "id" = $1
          AND "userId" = $2
          AND "deletedAt" IS NULL
        RETURNING "nextMessageSeq" - 1 AS "seq"`,
      [input.chatId, input.userId],
    )

    if (!sequenceResult.rows[0]) {
      throw new Error('CHAT_NOT_FOUND')
    }

    const messageResult = await client.query<MessageRow>(
      `INSERT INTO "Message_v2" (
         "chatId",
         "seq",
         "role",
         "parts",
         "sharedText",
         "clientMessageId"
       )
       VALUES ($1, $2, 'user', $3::jsonb, $4, $5)
       RETURNING "id", "seq", "role", "parts", "createdAt"`,
      [
        input.chatId,
        sequenceResult.rows[0].seq,
        JSON.stringify([{ type: 'text', text: input.content }]),
        input.content,
        input.clientMessageId,
      ],
    )
    const userMessage = mapMessage(messageResult.rows[0])

    await client.query(
      `INSERT INTO "Stream" ("id", "chatId")
       VALUES ($1, $2)`,
      [input.streamId, input.chatId],
    )

    await client.query(
      `INSERT INTO "Generation" (
         "id",
         "chatId",
         "userId",
         "userMessageId",
         "provider",
         "model",
         "requestId",
         "status",
         "metadata"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb)`,
      [
        input.generationId,
        input.chatId,
        input.userId,
        userMessage.id,
        input.provider,
        input.model,
        input.requestId,
        JSON.stringify({ streamId: input.streamId }),
      ],
    )

    return {
      generationId: input.generationId,
      streamId: input.streamId,
      userMessage,
      reused: false,
      status: 'pending',
    }
  })
}

export type ContextMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ChatContext = {
  chatId: string
  revision: number
  lastSeq: number
  messages: ContextMessage[]
}

export async function rebuildChatContext(
  database: Database,
  userId: string,
  chatId: string,
): Promise<ChatContext | null> {
  const chatResult = await database.query<{
    contextRevision: string | number
  }>(
    `SELECT "contextRevision"
       FROM "Chat"
      WHERE "id" = $1
        AND "userId" = $2
        AND "deletedAt" IS NULL`,
    [chatId, userId],
  )

  if (!chatResult.rows[0]) {
    return null
  }

  const messagesResult = await database.query<MessageRow>(
    `SELECT "id", "seq", "role", "parts", "createdAt"
       FROM "Message_v2"
      WHERE "chatId" = $1
        AND "role" IN ('user', 'assistant')
      ORDER BY "seq" DESC
      LIMIT 80`,
    [chatId],
  )
  const messages = messagesResult.rows.reverse().map(mapMessage)

  return {
    chatId,
    revision: Number(chatResult.rows[0].contextRevision),
    lastSeq: messages.at(-1)?.seq ?? 0,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  }
}

export async function getChatContextRevision(
  database: Database,
  userId: string,
  chatId: string,
): Promise<number | null> {
  const result = await database.query<{
    contextRevision: string | number
  }>(
    `SELECT "contextRevision"
       FROM "Chat"
      WHERE "id" = $1
        AND "userId" = $2
        AND "deletedAt" IS NULL`,
    [chatId, userId],
  )

  return result.rows[0]
    ? Number(result.rows[0].contextRevision)
    : null
}

export async function markGenerationStreaming(
  database: Database,
  generationId: string,
  providerRequestId?: string,
): Promise<void> {
  await database.query(
    `UPDATE "Generation"
        SET "status" = 'streaming',
            "providerRequestId" = COALESCE($2, "providerRequestId")
      WHERE "id" = $1
        AND "status" = 'pending'`,
    [generationId, providerRequestId || null],
  )
}

export async function completeGeneration(
  database: Database,
  input: {
    generationId: string
    userId: string
    chatId: string
    content: string
    providerRequestId?: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    reasoningTokens: number
    latencyMs: number
    timeToFirstTokenMs: number | null
    finishReason?: string
  },
): Promise<ChatMessageDto> {
  return withTransaction(database, async (client) => {
    const sequenceResult = await client.query<{ seq: string }>(
      `UPDATE "Chat"
          SET "nextMessageSeq" = "nextMessageSeq" + 1,
              "contextRevision" = "contextRevision" + 1
        WHERE "id" = $1
          AND "userId" = $2
          AND "deletedAt" IS NULL
        RETURNING "nextMessageSeq" - 1 AS "seq"`,
      [input.chatId, input.userId],
    )

    if (!sequenceResult.rows[0]) {
      throw new Error('CHAT_NOT_FOUND')
    }

    const messageResult = await client.query<MessageRow>(
      `INSERT INTO "Message_v2" (
         "chatId",
         "seq",
         "role",
         "parts",
         "sharedText"
       )
       VALUES ($1, $2, 'assistant', $3::jsonb, $4)
       RETURNING "id", "seq", "role", "parts", "createdAt"`,
      [
        input.chatId,
        sequenceResult.rows[0].seq,
        JSON.stringify([{ type: 'text', text: input.content }]),
        input.content,
      ],
    )
    const assistantMessage = mapMessage(messageResult.rows[0])

    await client.query(
      `UPDATE "Generation"
          SET "assistantMessageId" = $2,
              "providerRequestId" = COALESCE($3, "providerRequestId"),
              "status" = 'completed',
              "inputTokens" = $4,
              "outputTokens" = $5,
              "cachedInputTokens" = $6,
              "reasoningTokens" = $7,
              "latencyMs" = $8,
              "timeToFirstTokenMs" = $9,
              "finishReason" = $10,
              "finishedAt" = now()
        WHERE "id" = $1
          AND "userId" = $11`,
      [
        input.generationId,
        assistantMessage.id,
        input.providerRequestId || null,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens,
        input.reasoningTokens,
        input.latencyMs,
        input.timeToFirstTokenMs,
        input.finishReason || 'completed',
        input.userId,
      ],
    )

    await client.query(
      `INSERT INTO "UsageEvent" (
         "userId",
         "generationId",
         "inputTokens",
         "outputTokens"
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("generationId") WHERE "generationId" IS NOT NULL
       DO NOTHING`,
      [
        input.userId,
        input.generationId,
        input.inputTokens,
        input.outputTokens,
      ],
    )

    return assistantMessage
  })
}

export async function failGeneration(
  database: Database,
  generationId: string,
  input: {
    status: 'failed' | 'cancelled'
    errorCode: string
    errorMessage: string
    latencyMs: number
  },
): Promise<void> {
  await database.query(
    `UPDATE "Generation"
        SET "status" = $2,
            "errorCode" = $3,
            "errorMessage" = $4,
            "latencyMs" = $5,
            "finishedAt" = now()
      WHERE "id" = $1
        AND "status" IN ('pending', 'streaming')`,
    [
      generationId,
      input.status,
      input.errorCode,
      input.errorMessage,
      input.latencyMs,
    ],
  )
}

export async function getMonthlyTokenUsage(
  database: Database,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const result = await database.query<{ total: string }>(
    `SELECT COALESCE(SUM("totalTokens"), 0)::text AS "total"
       FROM "UsageEvent"
      WHERE "userId" = $1
        AND "createdAt" >= $2
        AND "createdAt" < $3`,
    [userId, periodStart, periodEnd],
  )

  return Number(result.rows[0]?.total ?? 0)
}

type GenerationRow = QueryResultRow & {
  id: string
  chatId: string | null
  status: GenerationDto['status']
  provider: string
  model: string
  inputTokens: string | number
  outputTokens: string | number
  errorCode: string | null
  errorMessage: string | null
  metadata: { streamId?: unknown }
  createdAt: Date | string
  finishedAt: Date | string | null
}

export async function getGeneration(
  database: Database,
  userId: string,
  generationId: string,
): Promise<GenerationDto | null> {
  const result = await database.query<GenerationRow>(
    `SELECT
       "id",
       "chatId",
       "status",
       "provider",
       "model",
       "inputTokens",
       "outputTokens",
       "errorCode",
       "errorMessage",
       "metadata",
       "createdAt",
       "finishedAt"
     FROM "Generation"
     WHERE "id" = $1
       AND "userId" = $2`,
    [generationId, userId],
  )
  const row = result.rows[0]

  if (!row) {
    return null
  }

  return {
    id: row.id,
    chatId: row.chatId,
    streamId:
      typeof row.metadata?.streamId === 'string'
        ? row.metadata.streamId
        : null,
    status: row.status,
    provider: row.provider,
    model: row.model,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: asIso(row.createdAt),
    finishedAt: row.finishedAt ? asIso(row.finishedAt) : null,
  }
}
