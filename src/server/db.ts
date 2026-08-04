import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import {
  commitPreparedArtifact,
  materializeMessageParts,
  type CommittedArtifactVersion,
  type PreparedArtifactVersion,
} from './artifacts/repository.js'

import type {
  ActiveGenerationDto,
  ChatDetailDto,
  ChatMessagePageDto,
  ChatMessageDto,
  ChatSummaryDto,
  CurrentUser,
  GenerationDto,
  Gpas2UserInfo,
} from './domain.js'
import {
  chats,
  generations,
  messages,
  streams,
  usageEvents,
  users,
  votes,
} from './db/schema.js'
import type { MessagePart } from './db/schema.js'
import type { Database } from './db/client.js'

export {
  checkDatabase,
  closeDatabase,
  createDatabase,
  migrateDatabase,
  verifyCoreSchema,
} from './db/client.js'
export type { Database } from './db/client.js'

type MessageRow = {
  id: string
  seq: bigint
  role: string
  status: string
  parts: MessagePart[]
  createdAt: Date
  isUpvoted?: boolean | null
}

type GenerationRow = {
  id: string
  chatId: string | null
  streamId: string | null
  status: string
  provider: string
  model: string
  inputTokens: bigint
  outputTokens: bigint
  errorCode: string | null
  errorMessage: string | null
  startedAt: Date | null
  cancelRequestedAt: Date | null
  cancelSource: string | null
  createdAt: Date
  finishedAt: Date | null
}

const chatSelection = {
  id: chats.id,
  title: chats.title,
  chatType: chats.chatType,
  status: chats.status,
  createdAt: chats.createdAt,
  updatedAt: chats.updatedAt,
}

const generationColumns = {
  id: generations.id,
  chatId: generations.chatId,
  status: generations.status,
  provider: generations.provider,
  model: generations.model,
  inputTokens: generations.inputTokens,
  outputTokens: generations.outputTokens,
  errorCode: generations.errorCode,
  errorMessage: generations.errorMessage,
  startedAt: generations.startedAt,
  cancelRequestedAt: generations.cancelRequestedAt,
  cancelSource: generations.cancelSource,
  createdAt: generations.createdAt,
  finishedAt: generations.finishedAt,
}

function asIso(value: Date): string {
  return value.toISOString()
}

function toSafeNumber(value: bigint | number | string, field: string): number {
  const result = typeof value === 'number' ? value : Number(value)

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${field} exceeds the JavaScript safe integer range`)
  }

  return result
}

export async function syncUser(
  database: Database,
  profile: Gpas2UserInfo,
): Promise<CurrentUser> {
  const values = {
    externalUserId: profile.userId,
    externalTeamId: profile.ownteamId || null,
    realName: profile.realName || null,
    userName: profile.userName || null,
    jobTitle: profile.jobTitle || null,
    researchField: profile.researchField || null,
    phone: profile.phone || null,
    gpas2Role: profile.role ?? null,
    email: profile.email || null,
    name: profile.realName || null,
    image: profile.image || null,
    deletedAt: null,
  }
  const [row] = await database
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.externalUserId,
      set: values,
    })
    .returning({
      id: users.id,
      externalUserId: users.externalUserId,
      externalTeamId: users.externalTeamId,
      realName: users.realName,
      userName: users.userName,
      jobTitle: users.jobTitle,
      researchField: users.researchField,
      email: users.email,
      name: users.name,
      image: users.image,
      gpas2Role: users.gpas2Role,
    })

  return row
}

function mapChat(row: typeof chats.$inferSelect): ChatSummaryDto {
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
  const rows = await database
    .select(chatSelection)
    .from(chats)
    .where(and(eq(chats.userId, userId), isNull(chats.deletedAt)))
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(100)

  return rows.map((row) => mapChat(row as typeof chats.$inferSelect))
}

export async function createChat(
  database: Database,
  userId: string,
  title: string,
): Promise<ChatSummaryDto> {
  const [row] = await database
    .insert(chats)
    .values({ userId, title })
    .returning(chatSelection)

  return mapChat(row as typeof chats.$inferSelect)
}

export async function renameChat(
  database: Database,
  userId: string,
  chatId: string,
  title: string,
): Promise<ChatSummaryDto | null> {
  const [row] = await database
    .update(chats)
    .set({ title })
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .returning(chatSelection)

  return row ? mapChat(row as typeof chats.$inferSelect) : null
}

export async function deleteChat(
  database: Database,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await database
    .update(chats)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .returning({ id: chats.id })

  return rows.length > 0
}

export function mapMessage(row: MessageRow): ChatMessageDto {
  const parts: ChatMessageDto['parts'] = []
  if (Array.isArray(row.parts)) {
    row.parts.forEach((part, index) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          parts.push({
            type: 'text' as const,
            order: typeof part.order === 'number' ? part.order : index,
            text: part.text,
          })
          return
        }
        if (
          part?.type === 'artifact_ref' &&
          typeof part.artifactId === 'string' &&
          typeof part.logicalId === 'string' &&
          typeof part.version === 'number'
        ) {
          parts.push({
            type: 'artifact_ref' as const,
            order: typeof part.order === 'number' ? part.order : index,
            artifactId: part.artifactId,
            logicalId: part.logicalId,
            version: part.version,
          })
        }
      })
  }
  parts.sort((left, right) => left.order - right.order)
  const content = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  return {
    id: row.id,
    seq: toSafeNumber(row.seq, 'Message.seq'),
    role: row.role as ChatMessageDto['role'],
    status: row.status as ChatMessageDto['status'],
    content,
    parts,
    createdAt: asIso(row.createdAt),
    vote:
      row.isUpvoted === true
        ? 'up'
        : row.isUpvoted === false
          ? 'down'
          : null,
    executionSteps:
      row.role === 'assistant'
        ? [
            { id: 'received', label: '接收问题', status: 'completed' },
            { id: 'analysis', label: '分析并组织回答', status: 'completed' },
            {
              id: 'response',
              label: row.status === 'completed' ? '生成回答' : '生成回答已中断',
              status: row.status === 'completed' ? 'completed' : 'interrupted',
            },
          ]
        : [],
  }
}

function mapGeneration(row: GenerationRow): GenerationDto {
  const status = row.status as GenerationDto['status']

  return {
    id: row.id,
    chatId: row.chatId,
    streamId: row.streamId,
    status,
    effectiveStatus:
      !['completed', 'failed', 'cancelled'].includes(status) &&
      row.cancelRequestedAt
        ? 'cancelling'
        : status,
    provider: row.provider,
    model: row.model,
    inputTokens: toSafeNumber(row.inputTokens, 'Generation.inputTokens'),
    outputTokens: toSafeNumber(row.outputTokens, 'Generation.outputTokens'),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt ? asIso(row.startedAt) : null,
    cancelRequestedAt: row.cancelRequestedAt
      ? asIso(row.cancelRequestedAt)
      : null,
    cancelSource: row.cancelSource as GenerationDto['cancelSource'],
    createdAt: asIso(row.createdAt),
    finishedAt: row.finishedAt ? asIso(row.finishedAt) : null,
  }
}

export async function getChatDetail(
  database: Database,
  userId: string,
  chatId: string,
): Promise<ChatDetailDto | null> {
  const [chat] = await database
    .select(chatSelection)
    .from(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  if (!chat) {
    return null
  }

  const replaced = alias(generations, 'replaced')

  const [messagePage, activeRows] = await Promise.all([
    queryChatMessagesPage(database, userId, chatId, undefined, 50),
    database
      .select({
        id: generations.id,
        streamId: streams.id,
        status: generations.status,
        replacesMessageId: replaced.assistantMessageId,
      })
      .from(generations)
      .innerJoin(streams, eq(streams.generationId, generations.id))
      .leftJoin(replaced, eq(replaced.id, generations.supersedesGenerationId))
      .where(
        and(
          eq(generations.chatId, chatId),
          eq(generations.userId, userId),
          inArray(generations.status, ['pending', 'streaming']),
          isNull(generations.cancelRequestedAt),
        ),
      )
      .orderBy(desc(generations.createdAt))
      .limit(1),
  ])
  const active = activeRows[0]
  const activeGeneration: ActiveGenerationDto | null = active
    ? {
        id: active.id,
        streamId: active.streamId,
        status: active.status as ActiveGenerationDto['status'],
        replacesMessageId: active.replacesMessageId,
      }
    : null

  return {
    ...mapChat(chat as typeof chats.$inferSelect),
    ...messagePage,
    activeGeneration,
  }
}

async function queryChatMessagesPage(
  database: Database,
  userId: string,
  chatId: string,
  beforeSeq: number | undefined,
  limit: number,
): Promise<ChatMessagePageDto> {
  const original = alias(generations, 'original')
  const replacement = alias(generations, 'replacement')
  const supersededMessageIds = database
    .select({ id: original.assistantMessageId })
    .from(original)
    .innerJoin(
      replacement,
      eq(replacement.supersedesGenerationId, original.id),
    )
    .where(
      and(
        eq(original.chatId, chatId),
        isNotNull(original.assistantMessageId),
        eq(replacement.status, 'completed'),
      ),
    )
  const conditions = [
    eq(messages.chatId, chatId),
    inArray(messages.role, ['user', 'assistant']),
    notInArray(messages.id, supersededMessageIds),
  ]
  if (beforeSeq !== undefined) {
    conditions.push(lt(messages.seq, BigInt(beforeSeq)))
  }

  const rows = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      parts: messages.parts,
      createdAt: messages.createdAt,
      isUpvoted: votes.isUpvoted,
    })
    .from(messages)
    .leftJoin(
      votes,
      and(eq(votes.messageId, messages.id), eq(votes.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit).reverse()
  const mapped = pageRows.map((row) => mapMessage(row))

  return {
    messages: mapped,
    pageInfo: {
      hasMore,
      beforeSeq: hasMore ? mapped[0]?.seq ?? null : null,
    },
  }
}

export async function getChatMessagesPage(
  database: Database,
  userId: string,
  chatId: string,
  beforeSeq: number,
  limit: number,
): Promise<ChatMessagePageDto | null> {
  const [chat] = await database
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)
  return chat
    ? queryChatMessagesPage(database, userId, chatId, beforeSeq, limit)
    : null
}

export async function setMessageVote(
  database: Database,
  userId: string,
  messageId: string,
  isUpvoted: boolean,
): Promise<'up' | 'down' | null> {
  const authorizedMessage = database
    .select({
      messageId: messages.id,
      userId: sql<string>`${userId}`.as('userId'),
      isUpvoted: sql<boolean>`${isUpvoted}`.as('isUpvoted'),
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.role, 'assistant'),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
  const [row] = await database
    .insert(votes)
    .select(authorizedMessage)
    .onConflictDoUpdate({
      target: [votes.messageId, votes.userId],
      set: { isUpvoted, updatedAt: sql`now()` },
    })
    .returning({ isUpvoted: votes.isUpvoted })

  return row ? row.isUpvoted ? 'up' : 'down' : null
}

export async function deleteMessageVote(
  database: Database,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const ownedMessage = database
    .select({ value: sql`1` })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.id, votes.messageId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
  const rows = await database
    .delete(votes)
    .where(
      and(
        eq(votes.messageId, messageId),
        eq(votes.userId, userId),
        exists(ownedMessage),
      ),
    )
    .returning({ messageId: votes.messageId })

  return rows.length > 0
}

export async function getRegenerationTarget(
  database: Database,
  userId: string,
  messageId: string,
): Promise<{ chatId: string } | null> {
  const [row] = await database
    .select({ chatId: messages.chatId })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.role, 'assistant'),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  return row ?? null
}

export async function ownsStream(
  database: Database,
  userId: string,
  streamId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: streams.id })
    .from(streams)
    .innerJoin(generations, eq(generations.id, streams.generationId))
    .innerJoin(chats, eq(chats.id, generations.chatId))
    .where(
      and(
        eq(streams.id, streamId),
        eq(generations.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  return rows.length > 0
}

export type GenerationStart = {
  generationId: string
  streamId: string
  userMessage: ChatMessageDto
  reused: boolean
  status: GenerationDto['status']
  replacesMessageId?: string
  contextMaxSeq?: number
}

export async function findGenerationStart(
  database: Database,
  userId: string,
  chatId: string,
  requestId: string,
): Promise<GenerationStart | null> {
  const [row] = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      parts: messages.parts,
      createdAt: messages.createdAt,
      generationId: generations.id,
      generationStatus: generations.status,
      streamId: streams.id,
    })
    .from(generations)
    .innerJoin(chats, eq(chats.id, generations.chatId))
    .innerJoin(messages, eq(messages.id, generations.userMessageId))
    .innerJoin(streams, eq(streams.generationId, generations.id))
    .where(
      and(
        eq(generations.requestId, requestId),
        eq(generations.chatId, chatId),
        eq(generations.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  return row
    ? {
        generationId: row.generationId,
        streamId: row.streamId,
        userMessage: mapMessage(row),
        reused: true,
        status: row.generationStatus as GenerationDto['status'],
      }
    : null
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
    supersedesGenerationId?: string
  },
): Promise<GenerationStart> {
  return database.transaction(async (transaction) => {
    if (input.supersedesGenerationId) {
      await transaction
        .update(generations)
        .set({
          cancelRequestedAt: sql`coalesce(${generations.cancelRequestedAt}, now())`,
          cancelSource: sql`coalesce(${generations.cancelSource}, 'superseded')`,
        })
        .where(
          and(
            eq(generations.id, input.supersedesGenerationId),
            eq(generations.chatId, input.chatId),
            eq(generations.userId, input.userId),
            inArray(generations.status, ['pending', 'streaming']),
          ),
        )
    }

    const [sequence] = await transaction
      .update(chats)
      .set({
        nextMessageSeq: sql`${chats.nextMessageSeq} + 1`,
        contextRevision: sql`${chats.contextRevision} + 1`,
      })
      .where(
        and(
          eq(chats.id, input.chatId),
          eq(chats.userId, input.userId),
          isNull(chats.deletedAt),
        ),
      )
      .returning({
        seq: sql`${chats.nextMessageSeq} - 1`.mapWith(chats.nextMessageSeq),
      })

    if (!sequence) {
      throw new Error('CHAT_NOT_FOUND')
    }

    const [messageRow] = await transaction
      .insert(messages)
      .values({
        chatId: input.chatId,
        seq: sequence.seq,
        role: 'user',
        status: 'completed',
        parts: [{ type: 'text', text: input.content }],
        sharedText: input.content,
        clientMessageId: input.clientMessageId,
      })
      .returning({
        id: messages.id,
        seq: messages.seq,
        role: messages.role,
        status: messages.status,
        parts: messages.parts,
        createdAt: messages.createdAt,
      })
    const userMessage = mapMessage(messageRow)

    await transaction.insert(generations).values({
      id: input.generationId,
      chatId: input.chatId,
      userId: input.userId,
      userMessageId: userMessage.id,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      status: 'pending',
    })
    await transaction.insert(streams).values({
      id: input.streamId,
      generationId: input.generationId,
    })

    return {
      generationId: input.generationId,
      streamId: input.streamId,
      userMessage,
      reused: false,
      status: 'pending',
    }
  })
}

export async function createRegenerationStart(
  database: Database,
  input: {
    userId: string
    chatId: string
    replacesMessageId: string
    generationId: string
    streamId: string
    requestId: string
    provider: string
    model: string
  },
): Promise<GenerationStart> {
  return database.transaction(async (transaction) => {
    const original = alias(generations, 'original')
    const assistantMessage = alias(messages, 'assistant_message')
    const userMessage = alias(messages, 'user_message')
    const active = alias(generations, 'active')
    const later = alias(messages, 'later')
    const oldGeneration = alias(generations, 'old_generation')
    const replacement = alias(generations, 'replacement')

    const [target] = await transaction
      .select({
        id: userMessage.id,
        seq: userMessage.seq,
        role: userMessage.role,
        status: userMessage.status,
        parts: userMessage.parts,
        createdAt: userMessage.createdAt,
        originalGenerationId: original.id,
      })
      .from(original)
      .innerJoin(
        assistantMessage,
        eq(assistantMessage.id, original.assistantMessageId),
      )
      .innerJoin(userMessage, eq(userMessage.id, original.userMessageId))
      .innerJoin(chats, eq(chats.id, original.chatId))
      .where(
        and(
          eq(assistantMessage.id, input.replacesMessageId),
          eq(original.chatId, input.chatId),
          eq(original.userId, input.userId),
          isNull(chats.deletedAt),
          notExists(
            transaction
              .select({ value: sql`1` })
              .from(active)
              .where(
                and(
                  eq(active.chatId, original.chatId),
                  inArray(active.status, ['pending', 'streaming']),
                ),
              ),
          ),
          notExists(
            transaction
              .select({ value: sql`1` })
              .from(later)
              .where(
                and(
                  eq(later.chatId, assistantMessage.chatId),
                  eq(later.role, 'assistant'),
                  sql`${later.seq} > ${assistantMessage.seq}`,
                  notExists(
                    transaction
                      .select({ value: sql`1` })
                      .from(oldGeneration)
                      .innerJoin(
                        replacement,
                        eq(
                          replacement.supersedesGenerationId,
                          oldGeneration.id,
                        ),
                      )
                      .where(
                        and(
                          eq(oldGeneration.assistantMessageId, later.id),
                          eq(replacement.status, 'completed'),
                        ),
                      ),
                  ),
                ),
              ),
          ),
        ),
      )
      .for('update', { of: chats })
      .limit(1)

    if (!target) {
      throw new Error('REGENERATION_TARGET_INVALID')
    }

    await transaction.insert(generations).values({
      id: input.generationId,
      chatId: input.chatId,
      userId: input.userId,
      userMessageId: target.id,
      supersedesGenerationId: target.originalGenerationId,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      status: 'pending',
    })
    await transaction.insert(streams).values({
      id: input.streamId,
      generationId: input.generationId,
    })

    return {
      generationId: input.generationId,
      streamId: input.streamId,
      userMessage: mapMessage(target),
      reused: false,
      status: 'pending',
      replacesMessageId: input.replacesMessageId,
      contextMaxSeq: toSafeNumber(target.seq, 'Message.seq'),
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
  maxSeq?: number,
): Promise<ChatContext | null> {
  const [chat] = await database
    .select({ contextRevision: chats.contextRevision })
    .from(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  if (!chat) {
    return null
  }

  const original = alias(generations, 'original')
  const replacement = alias(generations, 'replacement')
  const conditions = [
    eq(messages.chatId, chatId),
    or(
      eq(messages.role, 'user'),
      and(eq(messages.role, 'assistant'), eq(messages.status, 'completed')),
    ),
    notExists(
      database
        .select({ value: sql`1` })
        .from(original)
        .innerJoin(
          replacement,
          eq(replacement.supersedesGenerationId, original.id),
        )
        .where(
          and(
            eq(original.assistantMessageId, messages.id),
            eq(replacement.status, 'completed'),
          ),
        ),
    ),
  ]

  if (maxSeq !== undefined) {
    conditions.push(lte(messages.seq, BigInt(maxSeq)))
  }

  const rows = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      parts: messages.parts,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(80)
  const mappedMessages = rows.reverse().map((row) => mapMessage(row))

  return {
    chatId,
    revision: toSafeNumber(chat.contextRevision, 'Chat.contextRevision'),
    lastSeq: mappedMessages.at(-1)?.seq ?? 0,
    messages: mappedMessages.map((message) => ({
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
  const [row] = await database
    .select({ contextRevision: chats.contextRevision })
    .from(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  return row
    ? toSafeNumber(row.contextRevision, 'Chat.contextRevision')
    : null
}

export async function markGenerationStreaming(
  database: Database,
  generationId: string,
  providerRequestId?: string,
): Promise<boolean> {
  const rows = await database
    .update(generations)
    .set({
      status: 'streaming',
      startedAt: sql`coalesce(${generations.startedAt}, now())`,
      ...(providerRequestId ? { providerRequestId } : {}),
    })
    .where(
      and(
        eq(generations.id, generationId),
        eq(generations.status, 'pending'),
        isNull(generations.cancelRequestedAt),
      ),
    )
    .returning({ id: generations.id })

  return rows.length > 0
}

export async function isGenerationCancellationRequested(
  database: Database,
  generationId: string,
): Promise<boolean> {
  const [row] = await database
    .select({
      cancelRequestedAt: generations.cancelRequestedAt,
      status: generations.status,
    })
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1)

  return row
    ? row.cancelRequestedAt !== null || row.status === 'cancelled'
    : true
}

export async function getGeneration(
  database: Database,
  userId: string,
  generationId: string,
): Promise<GenerationDto | null> {
  const [row] = await database
    .select({ ...generationColumns, streamId: streams.id })
    .from(generations)
    .leftJoin(streams, eq(streams.generationId, generations.id))
    .where(
      and(
        eq(generations.id, generationId),
        eq(generations.userId, userId),
      ),
    )
    .limit(1)

  return row ? mapGeneration(row) : null
}

export async function requestGenerationCancellation(
  database: Database,
  userId: string,
  generationId: string,
  source: NonNullable<GenerationDto['cancelSource']> = 'user_stop',
): Promise<GenerationDto | null> {
  await database
    .update(generations)
    .set({
      cancelRequestedAt: sql`coalesce(${generations.cancelRequestedAt}, now())`,
      cancelSource: sql`coalesce(${generations.cancelSource}, ${source})`,
    })
    .where(
      and(
        eq(generations.id, generationId),
        eq(generations.userId, userId),
        inArray(generations.status, ['pending', 'streaming']),
      ),
    )

  return getGeneration(database, userId, generationId)
}

export type GenerationUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

export type FinalizeGenerationInput = {
  generationId: string
  userId: string
  desiredStatus: 'completed' | 'failed'
  content: string
  messageId?: string
  messageParts?: Array<
    | { type: 'text'; text: string }
    | { type: 'artifact_draft_ref'; streamArtifactId: string }
  >
  preparedArtifacts?: PreparedArtifactVersion[]
  providerRequestId?: string
  usage: GenerationUsage
  latencyMs: number
  timeToFirstTokenMs: number | null
  finishReason: string
  errorCode?: string
  errorMessage?: string
}

export type FinalizedGeneration = {
  generation: GenerationDto
  assistantMessage: ChatMessageDto | null
  newlyFinalized: boolean
  committedArtifacts: CommittedArtifactVersion[]
}

export function decideGenerationTerminalStatus(
  currentStatus: GenerationDto['status'],
  cancelRequestedAt: Date | string | null,
  desiredStatus: 'completed' | 'failed',
): 'completed' | 'failed' | 'cancelled' {
  if (['completed', 'failed', 'cancelled'].includes(currentStatus)) {
    return currentStatus as 'completed' | 'failed' | 'cancelled'
  }

  return cancelRequestedAt ? 'cancelled' : desiredStatus
}

export async function finalizeGeneration(
  database: Database,
  input: FinalizeGenerationInput,
): Promise<FinalizedGeneration> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        ...generationColumns,
        streamId: streams.id,
        assistantMessageId: generations.assistantMessageId,
      })
      .from(generations)
      .leftJoin(streams, eq(streams.generationId, generations.id))
      .where(
        and(
          eq(generations.id, input.generationId),
          eq(generations.userId, input.userId),
        ),
      )
      .for('update', { of: generations })
      .limit(1)

    if (!row) {
      throw new Error('GENERATION_NOT_FOUND')
    }

    if (['completed', 'failed', 'cancelled'].includes(row.status)) {
      const [existingMessage] = row.assistantMessageId
        ? await transaction
            .select({
              id: messages.id,
              seq: messages.seq,
              role: messages.role,
              status: messages.status,
              parts: messages.parts,
              createdAt: messages.createdAt,
            })
            .from(messages)
            .where(eq(messages.id, row.assistantMessageId))
            .limit(1)
        : []

      return {
        generation: mapGeneration(row),
        assistantMessage: existingMessage ? mapMessage(existingMessage) : null,
        newlyFinalized: false,
        committedArtifacts: [],
      }
    }

    const finalStatus = decideGenerationTerminalStatus(
      row.status as GenerationDto['status'],
      row.cancelRequestedAt,
      input.desiredStatus,
    )
    let assistantMessage: ChatMessageDto | null = null
    let committedArtifacts: CommittedArtifactVersion[] = []
    const preparedArtifacts = finalStatus === 'completed'
      ? input.preparedArtifacts ?? []
      : []
    const messageParts = input.messageParts ?? [
      { type: 'text' as const, text: input.content },
    ]

    if ((input.content.trim() || preparedArtifacts.length > 0) && row.chatId) {
      const [sequence] = await transaction
        .update(chats)
        .set({
          nextMessageSeq: sql`${chats.nextMessageSeq} + 1`,
          contextRevision: sql`${chats.contextRevision} + 1`,
        })
        .where(
          and(
            eq(chats.id, row.chatId),
            eq(chats.userId, input.userId),
            isNull(chats.deletedAt),
          ),
        )
        .returning({
          seq: sql`${chats.nextMessageSeq} - 1`.mapWith(chats.nextMessageSeq),
        })

      if (sequence) {
        const messageId = input.messageId ?? crypto.randomUUID()
        const expectedArtifacts = preparedArtifacts.map((prepared) => ({
          streamArtifactId: prepared.streamArtifactId,
          artifactId: prepared.artifactId,
          logicalId: prepared.metadata.id,
          version: prepared.version,
          sha256: prepared.contentHash,
          byteLength: prepared.byteLength,
        }))
        const persistedParts = materializeMessageParts(
          messageParts,
          expectedArtifacts,
        )
        const [messageRow] = await transaction
          .insert(messages)
          .values({
            id: messageId,
            chatId: row.chatId,
            seq: sequence.seq,
            role: 'assistant',
            status: finalStatus,
            parts: persistedParts,
            sharedText: finalStatus === 'completed' ? input.content : null,
          })
          .returning({
            id: messages.id,
            seq: messages.seq,
            role: messages.role,
            status: messages.status,
            parts: messages.parts,
            createdAt: messages.createdAt,
          })
        assistantMessage = mapMessage(messageRow)

        for (const prepared of preparedArtifacts) {
          committedArtifacts.push(await commitPreparedArtifact(transaction, {
            userId: input.userId,
            chatId: row.chatId,
            messageId,
            generationId: input.generationId,
            prepared,
          }))
        }
      }
    }

    const [updated] = await transaction
      .update(generations)
      .set({
        assistantMessageId: assistantMessage?.id ?? null,
        ...(input.providerRequestId
          ? { providerRequestId: input.providerRequestId }
          : {}),
        status: finalStatus,
        inputTokens: BigInt(input.usage.inputTokens),
        outputTokens: BigInt(input.usage.outputTokens),
        cachedInputTokens: BigInt(input.usage.cachedInputTokens),
        reasoningTokens: BigInt(input.usage.reasoningTokens),
        latencyMs: input.latencyMs,
        timeToFirstTokenMs: input.timeToFirstTokenMs,
        finishReason:
          finalStatus === 'cancelled' ? 'cancelled' : input.finishReason,
        errorCode:
          finalStatus === 'cancelled'
            ? 'generation_cancelled'
            : input.errorCode || null,
        errorMessage:
          finalStatus === 'cancelled'
            ? 'Generation stopped'
            : input.errorMessage || null,
        finishedAt: sql`now()`,
      })
      .where(eq(generations.id, input.generationId))
      .returning(generationColumns)

    await transaction
      .insert(usageEvents)
      .values({
        userId: input.userId,
        generationId: input.generationId,
        inputTokens: BigInt(input.usage.inputTokens),
        outputTokens: BigInt(input.usage.outputTokens),
      })
      .onConflictDoNothing({
        target: usageEvents.generationId,
        where: isNotNull(usageEvents.generationId),
      })

    return {
      generation: mapGeneration({ ...updated, streamId: row.streamId }),
      assistantMessage,
      newlyFinalized: true,
      committedArtifacts,
    }
  })
}

export async function getMonthlyTokenUsage(
  database: Database,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const [row] = await database
    .select({
      total: sql`coalesce(sum(${usageEvents.totalTokens}), 0)`.mapWith(
        usageEvents.totalTokens,
      ),
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        sql`${usageEvents.createdAt} >= ${periodStart}`,
        sql`${usageEvents.createdAt} < ${periodEnd}`,
      ),
    )

  return toSafeNumber(row?.total ?? 0n, 'UsageEvent.totalTokens')
}
