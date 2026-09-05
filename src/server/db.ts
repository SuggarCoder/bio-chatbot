import {
  and,
  asc,
  desc,
  eq,
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
  artifactMimeTypes,
} from './artifacts/protocol.js'
import { enqueueBackgroundJob } from './backgroundJobs.js'
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
  MessageExecutionStep,
} from './domain.js'
import {
  executionStepsFromMetadata,
  metadataWithExecutionSteps,
  normalizeExecutionSteps,
  settleExecutionSteps,
} from './executionTrace.js'
import {
  chats,
  chatSummaries,
  artifacts,
  auditLogs,
  generations,
  messages,
  outboxEvents,
  usageEvents,
  users,
  votes,
} from './db/schema.js'
import type { MessagePart } from './db/schema.js'
import type { Database } from './db/client.js'
import { AuthenticationError } from './auth.js'
import { gpasPartSchema, type GpasPart } from './gpasContracts.js'
import type { BusinessReply } from './gpas.js'

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
  content?: string | null
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
  metadata: Record<string, unknown>
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
  streamId: generations.streamId,
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
  metadata: generations.metadata,
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
      serviceTier: users.serviceTier,
      schedulingWeight: users.schedulingWeight,
      generationConcurrencyLimit: users.generationConcurrencyLimit,
      maxQueuedGenerations: users.maxQueuedGenerations,
    })

  return {
    ...row,
    serviceTier: row.serviceTier as CurrentUser['serviceTier'],
  }
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

export function mapMessage(
  row: MessageRow,
  visibleArtifactIds?: ReadonlySet<string>,
  executionSteps?: unknown,
): ChatMessageDto {
  const parts: ChatMessageDto['parts'] = []
  if (Array.isArray(row.parts)) {
    row.parts.forEach((part, index) => {
        if (part?.type === 'gpas') {
          const parsed = gpasPartSchema.safeParse(part)
          if (parsed.success) parts.push(parsed.data)
          return
        }
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
          typeof part.version === 'number' &&
          (visibleArtifactIds === undefined || visibleArtifactIds.has(part.artifactId))
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
  const content = row.content ?? parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  const normalizedExecutionSteps = normalizeExecutionSteps(executionSteps)

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
    executionSteps: row.role === 'assistant'
      ? normalizedExecutionSteps.length > 0
        ? normalizedExecutionSteps
        : [
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
    effectiveStatus: status,
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
        streamId: generations.streamId,
        status: generations.status,
        replacesMessageId: replaced.assistantMessageId,
      })
      .from(generations)
      .leftJoin(replaced, eq(replaced.id, generations.supersedesGenerationId))
      .where(
        and(
          eq(generations.chatId, chatId),
          eq(generations.userId, userId),
          inArray(generations.status, [
            'created',
            'queued',
            'scheduled',
            'running',
            'cancelling',
          ]),
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
        eq(original.userId, userId),
        isNotNull(original.assistantMessageId),
        eq(replacement.status, 'completed'),
      ),
    )
  const conditions = [
    eq(messages.chatId, chatId),
    eq(messages.userId, userId),
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
      generationMetadata: generations.metadata,
    })
    .from(messages)
    .leftJoin(generations, eq(generations.assistantMessageId, messages.id))
    .leftJoin(
      votes,
      and(eq(votes.messageId, messages.id), eq(votes.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit).reverse()
  const referencedArtifactIds = [...new Set(pageRows.flatMap((row) =>
    Array.isArray(row.parts)
      ? row.parts.flatMap((part) =>
          part?.type === 'artifact_ref' && typeof part.artifactId === 'string'
            ? [part.artifactId]
            : [])
      : []))]
  const visibleArtifactIds = new Set<string>()
  if (referencedArtifactIds.length > 0) {
    const visibleArtifacts = await database
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(
        eq(artifacts.userId, userId),
        eq(artifacts.chatId, chatId),
        inArray(artifacts.id, referencedArtifactIds),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ))
    visibleArtifacts.forEach((artifact) => visibleArtifactIds.add(artifact.id))
  }
  const mapped = pageRows.map((row) => mapMessage(
    row,
    visibleArtifactIds,
    executionStepsFromMetadata(row.generationMetadata),
  ))

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
  return database.transaction(async (transaction) => {
    const [authorizedMessage] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.userId, userId),
          eq(messages.role, 'assistant'),
          eq(chats.userId, userId),
          isNull(chats.deletedAt),
        ),
      )
      .limit(1)

    if (!authorizedMessage) {
      return null
    }

    const [row] = await transaction
      .insert(votes)
      .values({
        messageId: authorizedMessage.id,
        userId,
        isUpvoted,
      })
      .onConflictDoUpdate({
        target: [votes.messageId, votes.userId],
        set: { isUpvoted, updatedAt: sql`now()` },
      })
      .returning({ isUpvoted: votes.isUpvoted })

    return row.isUpvoted ? 'up' : 'down'
  })
}

export async function deleteMessageVote(
  database: Database,
  userId: string,
  messageId: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [authorizedMessage] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.userId, userId),
          eq(messages.role, 'assistant'),
          eq(chats.userId, userId),
          isNull(chats.deletedAt),
        ),
      )
      .limit(1)

    if (!authorizedMessage) {
      return false
    }

    const rows = await transaction
      .delete(votes)
      .where(
        and(
          eq(votes.messageId, authorizedMessage.id),
          eq(votes.userId, userId),
        ),
      )
      .returning({ messageId: votes.messageId })

    return rows.length > 0
  })
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
    .select({ id: generations.id })
    .from(generations)
    .innerJoin(chats, eq(chats.id, generations.chatId))
    .where(
      and(
        eq(generations.streamId, streamId),
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
  assistantMessageId: string
  userMessage: ChatMessageDto
  reused: boolean
  status: GenerationDto['status']
  replacesMessageId?: string
  contextMaxSeq?: number
  summaryVersion?: number
  summaryCoveredMaxSeq?: number
}

async function latestSummarySnapshot(
  database: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
  userId: string,
  chatId: string,
  maxSeq: bigint,
) {
  const [summary] = await database
    .select({
      version: chatSummaries.version,
      coveredMaxSeq: chatSummaries.coveredMaxSeq,
    })
    .from(chatSummaries)
    .where(and(
      eq(chatSummaries.userId, userId),
      eq(chatSummaries.chatId, chatId),
      lt(chatSummaries.coveredMaxSeq, maxSeq),
    ))
    .orderBy(desc(chatSummaries.coveredMaxSeq), desc(chatSummaries.version))
    .limit(1)
  return summary ?? null
}

export async function findGenerationStart(
  database: Database,
  userId: string,
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
      streamId: generations.streamId,
      assistantMessageId: generations.assistantMessageId,
      metadata: generations.metadata,
    })
    .from(generations)
    .innerJoin(messages, eq(messages.id, generations.userMessageId))
    .where(
      and(
        eq(generations.requestId, requestId),
        eq(generations.userId, userId),
      ),
    )
    .limit(1)

  if (!row) return null
  const metadata = row.metadata as Record<string, unknown>
  return {
    generationId: row.generationId,
    streamId: row.streamId,
    assistantMessageId: row.assistantMessageId,
    userMessage: mapMessage(row),
    reused: true,
    status: row.generationStatus as GenerationDto['status'],
    replacesMessageId: typeof metadata.replacesMessageId === 'string'
      ? metadata.replacesMessageId
      : undefined,
  }
}

export async function shareChat(
  database: Database,
  userId: string,
  chatId: string,
  mode: 'snapshot' | 'live',
): Promise<{ shareSlug: string; shareMode: 'snapshot' | 'live' } | null> {
  const shareSlug = Buffer.from(
    crypto.getRandomValues(new Uint8Array(24)),
  ).toString('base64url')
  const [row] = await database
    .update(chats)
    .set({
      shareScope: 'authenticated',
      shareMode: mode,
      sharedThroughSeq: mode === 'snapshot'
        ? sql`${chats.nextMessageSeq} - 1`
        : null,
      sharedAt: sql`now()`,
      shareSlug,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(chats.id, chatId),
      eq(chats.userId, userId),
      isNull(chats.deletedAt),
      sql`${chats.nextMessageSeq} > 1`,
    ))
    .returning({
      shareSlug: chats.shareSlug,
      shareMode: chats.shareMode,
    })
  return row?.shareSlug && (row.shareMode === 'snapshot' || row.shareMode === 'live')
    ? { shareSlug: row.shareSlug, shareMode: row.shareMode }
    : null
}

export async function unshareChat(
  database: Database,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await database
    .update(chats)
    .set({
      shareScope: 'private',
      shareMode: null,
      sharedThroughSeq: null,
      sharedAt: null,
      shareSlug: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(chats.id, chatId),
      eq(chats.userId, userId),
      isNull(chats.deletedAt),
    ))
    .returning({ id: chats.id })
  return rows.length > 0
}

export async function getSharedChat(
  database: Database,
  viewerUserId: string,
  shareSlug: string,
): Promise<{
  id: string
  title: string
  shareMode: 'snapshot' | 'live'
  messages: ChatMessageDto[]
} | null> {
  const [chat] = await database
    .select({
      id: chats.id,
      ownerUserId: chats.userId,
      title: chats.title,
      shareMode: chats.shareMode,
      sharedThroughSeq: chats.sharedThroughSeq,
    })
    .from(chats)
    .where(and(
      eq(chats.shareSlug, shareSlug),
      eq(chats.shareScope, 'authenticated'),
      isNull(chats.deletedAt),
    ))
    .limit(1)
  if (!chat || (chat.shareMode !== 'snapshot' && chat.shareMode !== 'live')) {
    return null
  }
  const rows = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      content: messages.sharedText,
      parts: messages.parts,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(
      eq(messages.chatId, chat.id),
      inArray(messages.role, ['user', 'assistant']),
      eq(messages.status, 'completed'),
      isNotNull(messages.sharedText),
      chat.shareMode === 'snapshot' && chat.sharedThroughSeq
        ? lte(messages.seq, chat.sharedThroughSeq)
        : undefined,
    ))
    .orderBy(messages.seq)
  await database.insert(auditLogs).values({
    actorUserId: viewerUserId,
    action: 'shared_conversation.read',
    resourceType: 'conversation',
    resourceId: chat.id,
    metadata: { shareSlug, ownerUserId: chat.ownerUserId },
  })
  return {
    id: chat.id,
    title: chat.title,
    shareMode: chat.shareMode,
    messages: rows.map((row) => mapMessage(row)),
  }
}

export async function getGenerationStartById(
  database: Database,
  userId: string,
  generationId: string,
): Promise<GenerationStart | null> {
  const [row] = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      content: messages.content,
      parts: messages.parts,
      createdAt: messages.createdAt,
      streamId: generations.streamId,
      assistantMessageId: generations.assistantMessageId,
      generationStatus: generations.status,
      metadata: generations.metadata,
    })
    .from(generations)
    .innerJoin(messages, eq(messages.id, generations.userMessageId))
    .where(and(
      eq(generations.id, generationId),
      eq(generations.userId, userId),
    ))
    .limit(1)
  if (!row) return null
  const metadata = row.metadata as Record<string, unknown>
  return {
    generationId,
    streamId: row.streamId,
    assistantMessageId: row.assistantMessageId,
    userMessage: mapMessage(row),
    reused: false,
    status: row.generationStatus as GenerationDto['status'],
    replacesMessageId: typeof metadata.replacesMessageId === 'string'
      ? metadata.replacesMessageId
      : undefined,
    contextMaxSeq: typeof metadata.contextMaxSeq === 'number'
      ? metadata.contextMaxSeq
      : undefined,
    summaryVersion: typeof metadata.summaryVersion === 'number'
      ? metadata.summaryVersion
      : undefined,
    summaryCoveredMaxSeq: typeof metadata.summaryCoveredMaxSeq === 'number'
      ? metadata.summaryCoveredMaxSeq
      : undefined,
  }
}

export async function createBusinessExchange(
  database: Database,
  input: {
    userId: string
    chatId: string
    clientMessageId: string
    content: string
    teamId?: string
    sourceMessageId?: string
  },
  execute: (form?: NonNullable<GpasPart['form']>) => Promise<BusinessReply>,
) {
  return database.transaction(async (transaction) => {
    // Serialize project creation across tabs, users in one team, and API replicas.
    if (input.sourceMessageId && input.teamId) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`gpas-project:${input.teamId}`}, 0))`)
    }
    const [chat] = await transaction.select().from(chats).where(and(
      eq(chats.id, input.chatId), eq(chats.userId, input.userId), isNull(chats.deletedAt),
    )).for('update')
    if (!chat) throw new AuthenticationError('会话不存在。', 404, 'chat_not_found')
    const [prior] = await transaction.select().from(messages).where(and(
      eq(messages.chatId, input.chatId), eq(messages.clientMessageId, input.clientMessageId),
    ))
    if (prior) {
      const [answer] = await transaction.select().from(messages).where(and(
        eq(messages.chatId, input.chatId), eq(messages.seq, prior.seq + 1n),
      ))
      if (!answer || !answer.parts.some((part) => part.type === 'gpas')) throw new AuthenticationError('请求标识已使用。', 409, 'request_conflict')
      return { kind: 'business' as const, userMessage: mapMessage(prior), assistantMessage: mapMessage(answer) }
    }
    const [active] = await transaction.select({ id: generations.id }).from(generations).where(and(
      eq(generations.chatId, input.chatId), inArray(generations.status, ['created', 'queued', 'scheduled', 'running', 'cancelling']),
    )).limit(1)
    if (active) throw new AuthenticationError('请等待当前回复完成后再查询项目。', 409, 'generation_active')
    let form: GpasPart['form']
    if (input.sourceMessageId) {
      const [source] = await transaction.select().from(messages).where(and(
        eq(messages.id, input.sourceMessageId), eq(messages.chatId, input.chatId), eq(messages.role, 'assistant'),
      ))
      const parsed = gpasPartSchema.safeParse(source?.parts.find((part) => part.type === 'gpas'))
      form = parsed.success ? parsed.data.form : undefined
      if (!form) throw new AuthenticationError('项目表单不存在，请重新查询任务进度。', 400, 'project_form_missing')
    }
    const result = await execute(form)
    const [question, answer] = await transaction.insert(messages).values([
      { userId: input.userId, chatId: input.chatId, seq: chat.nextMessageSeq, role: 'user',
        content: input.content, parts: [{ type: 'text', order: 0, text: input.content }], clientMessageId: input.clientMessageId },
      { userId: input.userId, chatId: input.chatId, seq: chat.nextMessageSeq + 1n, role: 'assistant',
        content: result.content, parts: [{ type: 'text', order: 0, text: result.content }, result.part] },
    ]).returning()
    await transaction.update(chats).set({
      nextMessageSeq: chat.nextMessageSeq + 2n, contextRevision: sql`${chats.contextRevision} + 1`, updatedAt: new Date(),
    }).where(eq(chats.id, chat.id))
    return { kind: 'business' as const, userMessage: mapMessage(question), assistantMessage: mapMessage(answer) }
  })
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
    artifactId?: string
    contextMemoryEnabled?: boolean
  },
): Promise<GenerationStart> {
  return database.transaction(async (transaction) => {
    const [owner] = await transaction
      .select({ maxQueuedGenerations: users.maxQueuedGenerations })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update')
      .limit(1)
    if (!owner) throw new Error('USER_NOT_FOUND')
    const [queue] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(generations)
      .where(and(
        eq(generations.userId, input.userId),
        inArray(generations.status, ['created', 'queued']),
      ))
    if ((queue?.count ?? 0) >= owner.maxQueuedGenerations) {
      throw new Error('QUEUE_LIMIT_EXCEEDED')
    }

    const [sequence] = await transaction
      .update(chats)
      .set({
        nextMessageSeq: sql`${chats.nextMessageSeq} + 2`,
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
        userSeq: sql`${chats.nextMessageSeq} - 2`.mapWith(chats.nextMessageSeq),
        assistantSeq: sql`${chats.nextMessageSeq} - 1`.mapWith(chats.nextMessageSeq),
      })

    if (!sequence) {
      throw new Error('CHAT_NOT_FOUND')
    }

    const [messageRow] = await transaction
      .insert(messages)
      .values({
        userId: input.userId,
        chatId: input.chatId,
        seq: sequence.userSeq,
        role: 'user',
        status: 'completed',
        content: input.content,
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
    const summary = input.contextMemoryEnabled
      ? await latestSummarySnapshot(
          transaction,
          input.userId,
          input.chatId,
          sequence.userSeq,
        )
      : null
    const assistantMessageId = crypto.randomUUID()
    await transaction.insert(messages).values({
      id: assistantMessageId,
      userId: input.userId,
      chatId: input.chatId,
      generationId: input.generationId,
      seq: sequence.assistantSeq,
      role: 'assistant',
      status: 'pending',
      parts: [],
    })

    await transaction.insert(generations).values({
      id: input.generationId,
      chatId: input.chatId,
      userId: input.userId,
      userMessageId: userMessage.id,
      assistantMessageId,
      provider: input.provider,
      model: input.model,
      streamId: input.streamId,
      requestId: input.requestId,
      status: 'created',
      metadata: {
        contextMaxSeq: toSafeNumber(sequence.userSeq, 'Message.seq'),
        ...(summary ? {
          summaryVersion: summary.version,
          summaryCoveredMaxSeq: toSafeNumber(
            summary.coveredMaxSeq,
            'ChatSummary.coveredMaxSeq',
          ),
        } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      },
    })
    await transaction.insert(outboxEvents).values({
      userId: input.userId,
      type: 'generation.created',
      aggregateId: input.generationId,
      payload: {
        generationId: input.generationId,
        userId: input.userId,
        conversationId: input.chatId,
        attempt: 0,
      },
    })

    return {
      generationId: input.generationId,
      streamId: input.streamId,
      assistantMessageId,
      userMessage,
      reused: false,
      status: 'created',
      contextMaxSeq: toSafeNumber(sequence.userSeq, 'Message.seq'),
      summaryVersion: summary?.version,
      summaryCoveredMaxSeq: summary
        ? toSafeNumber(summary.coveredMaxSeq, 'ChatSummary.coveredMaxSeq')
        : undefined,
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
    artifactId?: string
    contextMemoryEnabled?: boolean
  },
): Promise<GenerationStart> {
  return database.transaction(async (transaction) => {
    const [owner] = await transaction
      .select({ maxQueuedGenerations: users.maxQueuedGenerations })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update')
      .limit(1)
    if (!owner) throw new Error('USER_NOT_FOUND')
    const [queue] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(generations)
      .where(and(
        eq(generations.userId, input.userId),
        inArray(generations.status, ['created', 'queued']),
      ))
    if ((queue?.count ?? 0) >= owner.maxQueuedGenerations) {
      throw new Error('QUEUE_LIMIT_EXCEEDED')
    }

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
                  inArray(active.status, [
                    'created', 'queued', 'scheduled', 'running', 'cancelling',
                  ]),
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

    const [sequence] = await transaction
      .update(chats)
      .set({
        nextMessageSeq: sql`${chats.nextMessageSeq} + 1`,
        contextRevision: sql`${chats.contextRevision} + 1`,
      })
      .where(and(
        eq(chats.id, input.chatId),
        eq(chats.userId, input.userId),
        isNull(chats.deletedAt),
      ))
      .returning({
        seq: sql`${chats.nextMessageSeq} - 1`.mapWith(chats.nextMessageSeq),
      })
    if (!sequence) throw new Error('CHAT_NOT_FOUND')
    const assistantMessageId = crypto.randomUUID()
    const summary = input.contextMemoryEnabled
      ? await latestSummarySnapshot(
          transaction,
          input.userId,
          input.chatId,
          target.seq,
        )
      : null
    await transaction.insert(messages).values({
      id: assistantMessageId,
      userId: input.userId,
      chatId: input.chatId,
      generationId: input.generationId,
      seq: sequence.seq,
      role: 'assistant',
      status: 'pending',
      parts: [],
    })

    await transaction.insert(generations).values({
      id: input.generationId,
      chatId: input.chatId,
      userId: input.userId,
      userMessageId: target.id,
      assistantMessageId,
      supersedesGenerationId: target.originalGenerationId,
      provider: input.provider,
      model: input.model,
      streamId: input.streamId,
      requestId: input.requestId,
      status: 'created',
      metadata: {
        replacesMessageId: input.replacesMessageId,
        contextMaxSeq: toSafeNumber(target.seq, 'Message.seq'),
        ...(summary ? {
          summaryVersion: summary.version,
          summaryCoveredMaxSeq: toSafeNumber(
            summary.coveredMaxSeq,
            'ChatSummary.coveredMaxSeq',
          ),
        } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      },
    })
    await transaction.insert(outboxEvents).values({
      userId: input.userId,
      type: 'generation.created',
      aggregateId: input.generationId,
      payload: {
        generationId: input.generationId,
        userId: input.userId,
        conversationId: input.chatId,
        attempt: 0,
      },
    })

    return {
      generationId: input.generationId,
      streamId: input.streamId,
      assistantMessageId,
      userMessage: mapMessage(target),
      reused: false,
      status: 'created',
      replacesMessageId: input.replacesMessageId,
      contextMaxSeq: toSafeNumber(target.seq, 'Message.seq'),
      summaryVersion: summary?.version,
      summaryCoveredMaxSeq: summary
        ? toSafeNumber(summary.coveredMaxSeq, 'ChatSummary.coveredMaxSeq')
        : undefined,
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
    .transaction(async (transaction) => {
      const claimed = await transaction
        .update(generations)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${generations.startedAt}, now())`,
          providerRequestStartedAt:
            sql`coalesce(${generations.providerRequestStartedAt}, now())`,
          updatedAt: sql`now()`,
          ...(providerRequestId ? { providerRequestId } : {}),
        })
        .where(and(
          eq(generations.id, generationId),
          inArray(generations.status, ['scheduled', 'running']),
          isNull(generations.cancelRequestedAt),
        ))
        .returning({ assistantMessageId: generations.assistantMessageId })
      if (claimed[0]) {
        await transaction
          .update(messages)
          .set({ status: 'streaming', updatedAt: sql`now()` })
          .where(eq(messages.id, claimed[0].assistantMessageId))
      }
      return claimed
    })

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
    ? row.cancelRequestedAt !== null ||
      !['scheduled', 'running'].includes(row.status)
    : true
}

export async function getGeneration(
  database: Database,
  userId: string,
  generationId: string,
): Promise<GenerationDto | null> {
  const [row] = await database
    .select(generationColumns)
    .from(generations)
    .where(
      and(
        eq(generations.id, generationId),
        eq(generations.userId, userId),
      ),
    )
    .limit(1)

  return row ? mapGeneration(row) : null
}

export async function getGenerationAssistantMessage(
  database: Database,
  userId: string,
  generationId: string,
): Promise<ChatMessageDto | null> {
  const [row] = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      role: messages.role,
      status: messages.status,
      content: messages.content,
      parts: messages.parts,
      createdAt: messages.createdAt,
      isUpvoted: votes.isUpvoted,
    })
    .from(generations)
    .innerJoin(messages, eq(messages.id, generations.assistantMessageId))
    .leftJoin(
      votes,
      and(eq(votes.messageId, messages.id), eq(votes.userId, userId)),
    )
    .where(and(
      eq(generations.id, generationId),
      eq(generations.userId, userId),
    ))
    .limit(1)
  return row ? mapMessage(row) : null
}

export async function requestGenerationCancellation(
  database: Database,
  userId: string,
  generationId: string,
  source: NonNullable<GenerationDto['cancelSource']> = 'user_stop',
): Promise<GenerationDto | null> {
  await database.transaction(async (transaction) => {
    const [current] = await transaction
      .select({
        status: generations.status,
        assistantMessageId: generations.assistantMessageId,
      })
      .from(generations)
      .where(and(
        eq(generations.id, generationId),
        eq(generations.userId, userId),
      ))
      .for('update')
      .limit(1)
    if (!current || [
      'completed', 'failed', 'cancelled', 'interrupted', 'timed_out',
    ].includes(current.status)) return
    const queued = ['created', 'queued'].includes(current.status)
    await transaction
      .update(generations)
      .set({
        status: queued ? 'cancelled' : 'cancelling',
        cancelRequestedAt: sql`coalesce(${generations.cancelRequestedAt}, now())`,
        cancelSource: sql`coalesce(${generations.cancelSource}, ${source})`,
        updatedAt: sql`now()`,
        ...(queued ? { finishedAt: sql`now()`, finishReason: 'cancelled' } : {}),
      })
      .where(eq(generations.id, generationId))
    if (queued) {
      await transaction
        .update(messages)
        .set({ status: 'cancelled', updatedAt: sql`now()` })
        .where(eq(messages.id, current.assistantMessageId))
      await transaction
        .update(outboxEvents)
        .set({
          status: 'published',
          publishedAt: sql`now()`,
          lastError: 'generation_cancelled_before_dispatch',
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(outboxEvents.aggregateId, generationId),
          eq(outboxEvents.status, 'pending'),
        ))
    }
  })

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
  desiredStatus: 'completed' | 'failed' | 'interrupted' | 'timed_out'
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
  executionSteps?: MessageExecutionStep[]
  enqueueSummaryJob?: boolean
  enqueueUserMemoryJob?: boolean
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
  desiredStatus: 'completed' | 'failed' | 'interrupted' | 'timed_out',
): 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed_out' {
  if ([
    'completed', 'failed', 'cancelled', 'interrupted', 'timed_out',
  ].includes(currentStatus)) {
    return currentStatus as 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timed_out'
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
        assistantMessageId: generations.assistantMessageId,
        userMessageId: generations.userMessageId,
      })
      .from(generations)
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

    if ([
      'completed', 'failed', 'cancelled', 'interrupted', 'timed_out',
    ].includes(row.status)) {
      const [existingMessage] = row.assistantMessageId
        ? await transaction
            .select({
              id: messages.id,
              seq: messages.seq,
              role: messages.role,
              status: messages.status,
              content: messages.content,
              parts: messages.parts,
              createdAt: messages.createdAt,
            })
            .from(messages)
            .where(eq(messages.id, row.assistantMessageId))
            .limit(1)
        : []

      return {
        generation: mapGeneration(row),
        assistantMessage: existingMessage
          ? mapMessage(
              existingMessage,
              undefined,
              executionStepsFromMetadata(row.metadata),
            )
          : null,
        newlyFinalized: false,
        committedArtifacts: [],
      }
    }

    const finalStatus = decideGenerationTerminalStatus(
      row.status as GenerationDto['status'],
      row.cancelRequestedAt,
      input.desiredStatus,
    )
    const finalExecutionSteps = settleExecutionSteps(
      input.executionSteps ?? executionStepsFromMetadata(row.metadata),
      finalStatus === 'completed',
    )
    let assistantMessage: ChatMessageDto | null = null
    let committedArtifacts: CommittedArtifactVersion[] = []
    const preparedArtifacts = finalStatus === 'completed'
      ? input.preparedArtifacts ?? []
      : []
    const messageParts = input.messageParts ?? [
      { type: 'text' as const, text: input.content },
    ]

    if (row.chatId) {
        const messageId = row.assistantMessageId
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
        const messageStatus = finalStatus === 'completed'
          ? 'completed'
          : finalStatus === 'cancelled'
            ? 'cancelled'
            : 'failed'
        const [messageRow] = await transaction
          .update(messages)
          .set({
            status: messageStatus,
            content: input.content || null,
            parts: persistedParts,
            sharedText: finalStatus === 'completed' ? input.content : null,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(messages.id, messageId),
            eq(messages.userId, input.userId),
          ))
          .returning({
            id: messages.id,
            seq: messages.seq,
            role: messages.role,
            status: messages.status,
            content: messages.content,
            parts: messages.parts,
            createdAt: messages.createdAt,
          })
        assistantMessage = mapMessage(
          messageRow,
          undefined,
          finalExecutionSteps,
        )

        for (const prepared of preparedArtifacts) {
          committedArtifacts.push(await commitPreparedArtifact(transaction, {
            userId: input.userId,
            chatId: row.chatId,
            messageId,
            generationId: input.generationId,
            prepared,
          }))
        }

        if (finalStatus === 'completed' && input.enqueueSummaryJob) {
          await enqueueBackgroundJob(transaction, {
            userId: input.userId,
            type: 'chat.summary',
            dedupeKey: `chat.summary:${input.generationId}`,
            chatId: row.chatId,
            payload: {
              generationId: input.generationId,
              assistantMessageId: messageId,
              assistantSeq: Number(messageRow.seq),
            },
          })
        }
        if (finalStatus === 'completed' && input.enqueueUserMemoryJob) {
          await enqueueBackgroundJob(transaction, {
            userId: input.userId,
            type: 'user.memory',
            dedupeKey: `user.memory:${input.generationId}`,
            chatId: row.chatId,
            payload: {
              generationId: input.generationId,
              userMessageId: row.userMessageId,
              assistantMessageId: messageId,
            },
          })
        }
    }

    const [updated] = await transaction
      .update(generations)
      .set({
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
        metadata: metadataWithExecutionSteps(row.metadata, finalExecutionSteps),
        updatedAt: sql`now()`,
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
      generation: mapGeneration(updated),
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
