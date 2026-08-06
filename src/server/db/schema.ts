import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export type JsonRecord = Record<string, unknown>

export type MessagePart =
  | {
      type: 'text'
      order?: number
      text: string
    }
  | {
      type: 'artifact_ref'
      order: number
      artifactId: string
      logicalId: string
      version: number
    }
  | {
      type?: string
      [key: string]: unknown
    }

const timestampTz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' })

const bigintValue = (name: string) =>
  bigint(name, { mode: 'bigint' })

export const users = pgTable(
  'User',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    externalUserId: varchar('externalUserId', { length: 128 }).notNull().unique(),
    externalTeamId: varchar('externalTeamId', { length: 128 }),
    realName: text('realName'),
    userName: varchar('userName', { length: 64 }),
    jobTitle: varchar('jobTitle', { length: 64 }),
    researchField: text('researchField'),
    phone: varchar('phone', { length: 32 }),
    gpas2Role: integer('gpas2Role'),
    email: varchar('email', { length: 320 }),
    name: text('name'),
    image: text('image'),
    serviceTier: varchar('serviceTier', { length: 20 })
      .notNull()
      .default('free'),
    schedulingWeight: integer('schedulingWeight').notNull().default(1),
    generationConcurrencyLimit: integer('generationConcurrencyLimit')
      .notNull()
      .default(1),
    maxQueuedGenerations: integer('maxQueuedGenerations')
      .notNull()
      .default(5),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    deletedAt: timestampTz('deletedAt'),
  },
  (table) => [
    check(
      'chk_user_service_tier',
      sql`${table.serviceTier} in ('free', 'pro', 'enterprise')`,
    ),
    check('chk_user_scheduling_weight', sql`${table.schedulingWeight} >= 1`),
    check(
      'chk_user_generation_concurrency',
      sql`${table.generationConcurrencyLimit} >= 1`,
    ),
    check(
      'chk_user_max_queued_generations',
      sql`${table.maxQueuedGenerations} >= 1`,
    ),
    index('idx_user_team')
      .on(table.externalTeamId)
      .where(sql`${table.externalTeamId} is not null`),
  ],
)

export const chats = pgTable(
  'Chat',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    chatType: varchar('chatType', { length: 32 }).notNull().default('general'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    shareScope: varchar('shareScope', { length: 20 }).notNull().default('private'),
    shareMode: varchar('shareMode', { length: 16 }),
    sharedThroughSeq: bigintValue('sharedThroughSeq'),
    sharedAt: timestampTz('sharedAt'),
    shareSlug: varchar('shareSlug', { length: 64 }),
    contextRevision: bigintValue('contextRevision').notNull().default(sql`0`),
    nextMessageSeq: bigintValue('nextMessageSeq').notNull().default(sql`1`),
    forkedFromChatId: uuid('forkedFromChatId').references(
      (): AnyPgColumn => chats.id,
      { onDelete: 'set null' },
    ),
    forkedFromSeq: bigintValue('forkedFromSeq'),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    deletedAt: timestampTz('deletedAt'),
  },
  (table) => [
    check('chk_chat_status', sql`${table.status} in ('active', 'archived')`),
    check(
      'chk_chat_type',
      sql`${table.chatType} in ('general', 'analysis', 'pipeline', 'literature')`,
    ),
    check('chk_chat_next_seq', sql`${table.nextMessageSeq} >= 1`),
    check(
      'chk_chat_fork_state',
      sql`(
        (${table.forkedFromChatId} is null and ${table.forkedFromSeq} is null)
        or
        (${table.forkedFromChatId} is not null and ${table.forkedFromSeq} is not null
          and ${table.forkedFromSeq} >= 1 and ${table.forkedFromChatId} <> ${table.id})
      )`,
    ),
    check(
      'chk_chat_share_scope',
      sql`${table.shareScope} in ('private', 'authenticated')`,
    ),
    check(
      'chk_chat_share_mode',
      sql`${table.shareMode} is null or ${table.shareMode} in ('snapshot', 'live')`,
    ),
    check(
      'chk_chat_share_state',
      sql`(
        (${table.shareScope} = 'private' and ${table.shareMode} is null
          and ${table.sharedThroughSeq} is null and ${table.sharedAt} is null
          and ${table.shareSlug} is null)
        or
        (${table.shareScope} = 'authenticated' and ${table.shareMode} = 'snapshot'
          and ${table.sharedThroughSeq} is not null and ${table.sharedThroughSeq} >= 1
          and ${table.sharedThroughSeq} < ${table.nextMessageSeq}
          and ${table.sharedAt} is not null and ${table.shareSlug} is not null)
        or
        (${table.shareScope} = 'authenticated' and ${table.shareMode} = 'live'
          and ${table.sharedThroughSeq} is null and ${table.sharedAt} is not null
          and ${table.shareSlug} is not null)
      )`,
    ),
    index('idx_chat_user_active')
      .on(table.userId, table.status, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    unique('uq_chat_user_id').on(table.userId, table.id),
    foreignKey({
      name: 'fk_chat_user_fork',
      columns: [table.userId, table.forkedFromChatId],
      foreignColumns: [table.userId, table.id],
    }),
    uniqueIndex('uq_chat_share_slug')
      .on(table.shareSlug)
      .where(sql`${table.shareSlug} is not null`),
    index('idx_chat_shared')
      .on(table.sharedAt.desc())
      .where(
        sql`${table.shareScope} = 'authenticated' and ${table.deletedAt} is null`,
      ),
  ],
)

export const messages = pgTable(
  'Message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chatId')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    generationId: uuid('generationId'),
    seq: bigintValue('seq').notNull(),
    role: varchar('role', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('completed'),
    content: text('content'),
    parts: jsonb('parts').$type<MessagePart[]>().notNull().default([]),
    sharedText: text('sharedText'),
    clientMessageId: varchar('clientMessageId', { length: 128 }),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_message_role',
      sql`${table.role} in ('user', 'assistant', 'system', 'tool')`,
    ),
    check('chk_message_seq', sql`${table.seq} >= 1`),
    check(
      'chk_message_status',
      sql`(
        (${table.role} = 'assistant' and ${table.status} in ('pending', 'streaming', 'completed', 'cancelled', 'failed'))
        or (${table.role} <> 'assistant' and ${table.status} = 'completed')
      )`,
    ),
    check(
      'chk_message_shared_text',
      sql`${table.sharedText} is null or (
        ${table.role} in ('user', 'assistant') and ${table.status} = 'completed'
      )`,
    ),
    unique('uq_message_chat_seq').on(table.chatId, table.seq),
    unique('uq_message_user_id').on(table.userId, table.id),
    unique('uq_message_id_chat').on(table.id, table.chatId),
    foreignKey({
      name: 'fk_message_user_chat',
      columns: [table.userId, table.chatId],
      foreignColumns: [chats.userId, chats.id],
    }),
    uniqueIndex('uq_message_generation')
      .on(table.generationId)
      .where(sql`${table.generationId} is not null`),
    uniqueIndex('uq_message_client_id')
      .on(table.chatId, table.clientMessageId)
      .where(sql`${table.clientMessageId} is not null`),
  ],
)

export const votes = pgTable(
  'Vote',
  {
    messageId: uuid('messageId')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isUpvoted: boolean('isUpvoted').notNull(),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    foreignKey({
      name: 'fk_vote_user_message',
      columns: [table.userId, table.messageId],
      foreignColumns: [messages.userId, messages.id],
    }),
  ],
)

export const attachments = pgTable(
  'Attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storageProvider: varchar('storageProvider', { length: 32 }).notNull(),
    storageKey: text('storageKey').notNull(),
    fileName: text('fileName').notNull(),
    mimeType: varchar('mimeType', { length: 255 }),
    sizeBytes: bigintValue('sizeBytes').notNull(),
    sha256: varchar('sha256', { length: 64 }),
    status: varchar('status', { length: 20 }).notNull().default('uploading'),
    metadata: jsonb('metadata').$type<JsonRecord>().notNull().default({}),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    deletedAt: timestampTz('deletedAt'),
  },
  (table) => [
    check('chk_attachment_size', sql`${table.sizeBytes} >= 0`),
    check(
      'chk_attachment_status',
      sql`${table.status} in ('uploading', 'scanning', 'ready', 'quarantined', 'failed')`,
    ),
    unique('uq_attachment_storage').on(table.storageProvider, table.storageKey),
    unique('uq_attachment_user_id').on(table.userId, table.id),
    index('idx_attachment_user')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    index('idx_attachment_sha')
      .on(table.userId, table.sha256)
      .where(sql`${table.sha256} is not null and ${table.deletedAt} is null`),
  ],
)

export const messageAttachments = pgTable(
  'MessageAttachment',
  {
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('messageId')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachmentId')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.attachmentId] }),
    foreignKey({
      name: 'fk_message_attachment_user_message',
      columns: [table.userId, table.messageId],
      foreignColumns: [messages.userId, messages.id],
    }),
    foreignKey({
      name: 'fk_message_attachment_user_attachment',
      columns: [table.userId, table.attachmentId],
      foreignColumns: [attachments.userId, attachments.id],
    }),
    unique('uq_message_attachment_position').on(table.messageId, table.position),
    check('chk_message_attachment_position', sql`${table.position} >= 0`),
    index('idx_message_attachment_attachment').on(table.attachmentId),
  ],
)

export const generations = pgTable(
  'Generation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chatId: uuid('chatId')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userMessageId: uuid('userMessageId')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    assistantMessageId: uuid('assistantMessageId')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    supersedesGenerationId: uuid('supersedesGenerationId').references(
      (): AnyPgColumn => generations.id,
      { onDelete: 'set null' },
    ),
    provider: varchar('provider', { length: 64 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    streamId: varchar('streamId', { length: 256 }).notNull(),
    requestId: varchar('requestId', { length: 128 }).notNull(),
    providerRequestId: varchar('providerRequestId', { length: 256 }),
    status: varchar('status', { length: 20 }).notNull().default('created'),
    priority: integer('priority').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    workerId: varchar('workerId', { length: 128 }),
    providerRequestStartedAt: timestampTz('providerRequestStartedAt'),
    queuedAt: timestampTz('queuedAt'),
    scheduledAt: timestampTz('scheduledAt'),
    startedAt: timestampTz('startedAt'),
    cancelRequestedAt: timestampTz('cancelRequestedAt'),
    cancelSource: varchar('cancelSource', { length: 32 }),
    inputTokens: bigintValue('inputTokens').notNull().default(sql`0`),
    outputTokens: bigintValue('outputTokens').notNull().default(sql`0`),
    cachedInputTokens: bigintValue('cachedInputTokens').notNull().default(sql`0`),
    reasoningTokens: bigintValue('reasoningTokens').notNull().default(sql`0`),
    providerCostUsd: numeric('providerCostUsd', { precision: 18, scale: 8 }),
    latencyMs: integer('latencyMs'),
    timeToFirstTokenMs: integer('timeToFirstTokenMs'),
    finishReason: varchar('finishReason', { length: 64 }),
    errorCode: varchar('errorCode', { length: 128 }),
    errorMessage: text('errorMessage'),
    metadata: jsonb('metadata').$type<JsonRecord>().notNull().default({}),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    finishedAt: timestampTz('finishedAt'),
  },
  (table) => [
    unique('uq_generation_user_request_id').on(table.userId, table.requestId),
    unique('uq_generation_user_id').on(table.userId, table.id),
    unique('uq_generation_chat_id').on(table.chatId, table.id),
    unique('uq_generation_stream_id').on(table.streamId),
    check(
      'chk_generation_status',
      sql`${table.status} in (
        'created', 'queued', 'scheduled', 'running', 'cancelling',
        'completed', 'cancelled', 'failed', 'interrupted', 'timed_out'
      )`,
    ),
    check('chk_generation_attempt', sql`${table.attempt} >= 0`),
    check(
      'chk_generation_tokens',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0
        and ${table.cachedInputTokens} >= 0 and ${table.reasoningTokens} >= 0`,
    ),
    check(
      'chk_generation_cost',
      sql`${table.providerCostUsd} is null or ${table.providerCostUsd} >= 0`,
    ),
    check(
      'chk_generation_latency',
      sql`(${table.latencyMs} is null or ${table.latencyMs} >= 0)
        and (${table.timeToFirstTokenMs} is null or ${table.timeToFirstTokenMs} >= 0)`,
    ),
    check(
      'chk_generation_cancel_source',
      sql`${table.cancelSource} is null or ${table.cancelSource} in (
        'user_stop', 'superseded', 'timeout', 'server_shutdown', 'system'
      )`,
    ),
    check(
      'chk_generation_cancel_fields',
      sql`(${table.cancelRequestedAt} is null and ${table.cancelSource} is null)
        or (${table.cancelRequestedAt} is not null and ${table.cancelSource} is not null)`,
    ),
    check(
      'chk_generation_finished_at',
      sql`(${table.status} in ('completed', 'failed', 'cancelled', 'interrupted', 'timed_out') and ${table.finishedAt} is not null)
        or (${table.status} in ('created', 'queued', 'scheduled', 'running', 'cancelling') and ${table.finishedAt} is null)`,
    ),
    index('idx_generation_supersedes')
      .on(table.supersedesGenerationId)
      .where(sql`${table.supersedesGenerationId} is not null`),
    index('idx_generation_completed_supersedes')
      .on(table.supersedesGenerationId)
      .where(
        sql`${table.supersedesGenerationId} is not null and ${table.status} = 'completed'`,
      ),
    index('idx_generation_user_created')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.userId} is not null`),
    index('idx_generation_chat')
      .on(table.chatId, table.createdAt)
      .where(sql`${table.chatId} is not null`),
    index('idx_generation_model').on(table.provider, table.model, table.createdAt.desc()),
    uniqueIndex('uq_generation_assistant_message')
      .on(table.assistantMessageId),
    uniqueIndex('uq_generation_chat_active')
      .on(table.chatId)
      .where(
        sql`${table.status} in ('scheduled', 'running', 'cancelling')`,
      ),
    foreignKey({
      name: 'fk_generation_user_chat',
      columns: [table.userId, table.chatId],
      foreignColumns: [chats.userId, chats.id],
    }),
    foreignKey({
      name: 'fk_generation_user_message',
      columns: [table.userId, table.userMessageId],
      foreignColumns: [messages.userId, messages.id],
    }),
    foreignKey({
      name: 'fk_generation_assistant_message',
      columns: [table.userId, table.assistantMessageId],
      foreignColumns: [messages.userId, messages.id],
    }),
    foreignKey({
      name: 'fk_generation_user_supersedes',
      columns: [table.userId, table.supersedesGenerationId],
      foreignColumns: [table.userId, table.id],
    }),
    foreignKey({
      name: 'fk_generation_chat_supersedes',
      columns: [table.chatId, table.supersedesGenerationId],
      foreignColumns: [table.chatId, table.id],
    }),
  ],
)

export const outboxEvents = pgTable(
  'OutboxEvent',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregateId').notNull(),
    payload: jsonb('payload').$type<JsonRecord>().notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestampTz('availableAt').notNull().defaultNow(),
    publishedAt: timestampTz('publishedAt'),
    lastError: text('lastError'),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_outbox_status',
      sql`${table.status} in ('pending', 'published', 'failed')`,
    ),
    check('chk_outbox_attempts', sql`${table.attempts} >= 0`),
    index('idx_outbox_pending')
      .on(table.status, table.availableAt, table.createdAt),
    index('idx_outbox_aggregate').on(table.aggregateId, table.createdAt),
  ],
)

export const toolRuns = pgTable(
  'ToolRun',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generationId: uuid('generationId')
      .notNull()
      .references(() => generations.id, { onDelete: 'cascade' }),
    toolCallId: varchar('toolCallId', { length: 256 }),
    toolName: varchar('toolName', { length: 128 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    input: jsonb('input').$type<JsonRecord>(),
    outputSummary: jsonb('outputSummary').$type<JsonRecord>(),
    error: text('error'),
    startedAt: timestampTz('startedAt').notNull().defaultNow(),
    finishedAt: timestampTz('finishedAt'),
  },
  (table) => [
    check(
      'chk_tool_run_status',
      sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    foreignKey({
      name: 'fk_tool_run_user_generation',
      columns: [table.userId, table.generationId],
      foreignColumns: [generations.userId, generations.id],
    }),
    unique('uq_tool_run_user_id').on(table.userId, table.id),
    uniqueIndex('uq_tool_run_call')
      .on(table.generationId, table.toolCallId)
      .where(sql`${table.toolCallId} is not null`),
    index('idx_tool_run_generation').on(table.generationId, table.startedAt),
    index('idx_tool_run_name').on(table.toolName, table.startedAt.desc()),
  ],
)

export const analysisJobs = pgTable(
  'AnalysisJob',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chatId: uuid('chatId').references(() => chats.id, { onDelete: 'set null' }),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalJobId: varchar('externalJobId', { length: 256 }),
    jobType: varchar('jobType', { length: 64 }).notNull(),
    jobName: text('jobName'),
    params: jsonb('params').$type<JsonRecord>().notNull().default({}),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    progress: smallint('progress').notNull().default(0),
    result: jsonb('result').$type<JsonRecord>(),
    error: text('error'),
    idempotencyKey: varchar('idempotencyKey', { length: 128 }),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('maxAttempts').notNull().default(3),
    workerId: varchar('workerId', { length: 128 }),
    leaseUntil: timestampTz('leaseUntil'),
    heartbeatAt: timestampTz('heartbeatAt'),
    cancelRequestedAt: timestampTz('cancelRequestedAt'),
    queuedAt: timestampTz('queuedAt'),
    startedAt: timestampTz('startedAt'),
    finishedAt: timestampTz('finishedAt'),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    originToolRunId: uuid('originToolRunId').references(() => toolRuns.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    check(
      'chk_job_status',
      sql`${table.status} in ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    foreignKey({
      name: 'fk_analysis_job_user_chat',
      columns: [table.userId, table.chatId],
      foreignColumns: [chats.userId, chats.id],
    }),
    foreignKey({
      name: 'fk_analysis_job_user_tool_run',
      columns: [table.userId, table.originToolRunId],
      foreignColumns: [toolRuns.userId, toolRuns.id],
    }),
    unique('uq_analysis_job_user_id').on(table.userId, table.id),
    check('chk_job_progress', sql`${table.progress} between 0 and 100`),
    check(
      'chk_job_attempt',
      sql`${table.attempt} >= 0 and ${table.maxAttempts} >= 1
        and ${table.attempt} <= ${table.maxAttempts}`,
    ),
    index('idx_job_chat')
      .on(table.chatId)
      .where(sql`${table.chatId} is not null`),
    index('idx_job_user_status')
      .on(table.userId, table.status, table.createdAt.desc())
      .where(sql`${table.userId} is not null`),
    index('idx_job_active_status')
      .on(table.status, table.createdAt)
      .where(sql`${table.status} in ('pending', 'queued', 'running')`),
    index('idx_job_external')
      .on(table.externalJobId)
      .where(sql`${table.externalJobId} is not null`),
    uniqueIndex('uq_job_idempotency')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.userId} is not null and ${table.idempotencyKey} is not null`),
    index('idx_job_origin_tool')
      .on(table.originToolRunId)
      .where(sql`${table.originToolRunId} is not null`),
  ],
)

export const jobEvents = pgTable(
  'JobEvent',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('jobId')
      .notNull()
      .references(() => analysisJobs.id, { onDelete: 'cascade' }),
    eventType: varchar('eventType', { length: 64 }).notNull(),
    data: jsonb('data').$type<JsonRecord>().notNull().default({}),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'fk_job_event_user_job',
      columns: [table.userId, table.jobId],
      foreignColumns: [analysisJobs.userId, analysisJobs.id],
    }),
    index('idx_job_event_job').on(table.jobId, table.id),
  ],
)

export const artifacts = pgTable(
  'Artifact',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chatId').references(() => chats.id, { onDelete: 'set null' }),
    messageId: uuid('messageId').references(() => messages.id, { onDelete: 'set null' }),
    generationId: uuid('generationId').references(() => generations.id, {
      onDelete: 'set null',
    }),
    analysisJobId: uuid('analysisJobId').references(() => analysisJobs.id, {
      onDelete: 'set null',
    }),
    logicalId: varchar('logicalId', { length: 64 }),
    currentVersion: integer('currentVersion').notNull().default(0),
    title: text('title').notNull(),
    artifactType: varchar('artifactType', { length: 32 }).notNull(),
    isChatShareable: boolean('isChatShareable')
      .generatedAlwaysAs(sql`"artifactType" in ('report', 'table', 'chart')`),
    format: varchar('format', { length: 32 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('generating'),
    content: text('content'),
    storageProvider: varchar('storageProvider', { length: 32 }),
    storageKey: text('storageKey'),
    mimeType: varchar('mimeType', { length: 255 }),
    sizeBytes: bigintValue('sizeBytes'),
    sha256: varchar('sha256', { length: 64 }),
    error: text('error'),
    metadata: jsonb('metadata').$type<JsonRecord>().notNull().default({}),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
    updatedAt: timestampTz('updatedAt').notNull().defaultNow(),
    expiresAt: timestampTz('expiresAt'),
    deletedAt: timestampTz('deletedAt'),
  },
  (table) => [
    check(
      'chk_artifact_type',
      sql`${table.artifactType} in ('report', 'table', 'chart', 'file', 'dataset')`,
    ),
    check(
      'chk_artifact_format',
      sql`${table.format} in ('html', 'markdown', 'text', 'code', 'mermaid', 'pdf', 'csv', 'xlsx', 'json', 'png', 'jpeg', 'svg')`,
    ),
    check(
      'chk_artifact_status',
      sql`${table.status} in ('generating', 'ready', 'failed', 'expired', 'archived', 'deleted')`,
    ),
    check('chk_artifact_current_version', sql`${table.currentVersion} >= 0`),
    check(
      'chk_artifact_logical_id',
      sql`${table.logicalId} is null or ${table.logicalId} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`,
    ),
    check('chk_artifact_size', sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
    check(
      'chk_artifact_storage',
      sql`(${table.storageProvider} is null and ${table.storageKey} is null)
        or (${table.storageProvider} is not null and ${table.storageKey} is not null)`,
    ),
    check(
      'chk_artifact_ready_content',
      sql`${table.status} <> 'ready' or ${table.content} is not null or ${table.storageKey} is not null`,
    ),
    check(
      'chk_artifact_expiry',
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'chk_artifact_message_chat_presence',
      sql`${table.messageId} is null or ${table.chatId} is not null`,
    ),
    foreignKey({
      name: 'fk_artifact_message_chat',
      columns: [table.messageId, table.chatId],
      foreignColumns: [messages.id, messages.chatId],
    }),
    foreignKey({
      name: 'fk_artifact_user_chat',
      columns: [table.userId, table.chatId],
      foreignColumns: [chats.userId, chats.id],
    }),
    foreignKey({
      name: 'fk_artifact_user_message',
      columns: [table.userId, table.messageId],
      foreignColumns: [messages.userId, messages.id],
    }),
    foreignKey({
      name: 'fk_artifact_user_generation',
      columns: [table.userId, table.generationId],
      foreignColumns: [generations.userId, generations.id],
    }),
    foreignKey({
      name: 'fk_artifact_user_analysis_job',
      columns: [table.userId, table.analysisJobId],
      foreignColumns: [analysisJobs.userId, analysisJobs.id],
    }),
    unique('uq_artifact_user_id').on(table.userId, table.id),
    uniqueIndex('uq_artifact_storage')
      .on(table.storageProvider, table.storageKey)
      .where(sql`${table.storageKey} is not null`),
    uniqueIndex('uq_artifact_chat_logical_id')
      .on(table.userId, table.chatId, table.logicalId)
      .where(
        sql`${table.logicalId} is not null and ${table.deletedAt} is null`,
      ),
    index('idx_artifact_user')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.userId} is not null and ${table.deletedAt} is null`),
    index('idx_artifact_chat')
      .on(table.chatId, table.createdAt.desc())
      .where(sql`${table.chatId} is not null and ${table.deletedAt} is null`),
    index('idx_artifact_message')
      .on(table.messageId)
      .where(sql`${table.messageId} is not null and ${table.deletedAt} is null`),
    index('idx_artifact_generation')
      .on(table.generationId)
      .where(sql`${table.generationId} is not null and ${table.deletedAt} is null`),
    index('idx_artifact_job')
      .on(table.analysisJobId)
      .where(sql`${table.analysisJobId} is not null and ${table.deletedAt} is null`),
    index('idx_artifact_expiry')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} is not null and ${table.deletedAt} is null`),
  ],
)

export const artifactVersions = pgTable(
  'ArtifactVersion',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifactId')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    parentVersion: integer('parentVersion'),
    title: text('title').notNull(),
    mimeType: varchar('mimeType', { length: 255 }).notNull(),
    language: varchar('language', { length: 64 }),
    storageProvider: varchar('storageProvider', { length: 32 }).notNull(),
    storageKey: text('storageKey').notNull(),
    contentHash: varchar('contentHash', { length: 64 }).notNull(),
    byteLength: bigintValue('byteLength').notNull(),
    sourceMessageId: uuid('sourceMessageId')
      .references(() => messages.id, { onDelete: 'set null' }),
    sourceGenerationId: uuid('sourceGenerationId')
      .references(() => generations.id, { onDelete: 'set null' }),
    streamArtifactId: uuid('streamArtifactId').notNull(),
    createdBy: varchar('createdBy', { length: 20 }).notNull(),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
  },
  (table) => [
    check('chk_artifact_version_number', sql`${table.version} >= 1`),
    check(
      'chk_artifact_parent_version',
      sql`${table.parentVersion} is null or ${table.parentVersion} >= 1`,
    ),
    check('chk_artifact_version_bytes', sql`${table.byteLength} >= 0`),
    check(
      'chk_artifact_version_hash',
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'chk_artifact_version_creator',
      sql`${table.createdBy} in ('assistant', 'user')`,
    ),
    unique('uq_artifact_version').on(table.artifactId, table.version),
    foreignKey({
      name: 'fk_artifact_version_user_artifact',
      columns: [table.userId, table.artifactId],
      foreignColumns: [artifacts.userId, artifacts.id],
    }),
    foreignKey({
      name: 'fk_artifact_version_user_message',
      columns: [table.userId, table.sourceMessageId],
      foreignColumns: [messages.userId, messages.id],
    }),
    foreignKey({
      name: 'fk_artifact_version_user_generation',
      columns: [table.userId, table.sourceGenerationId],
      foreignColumns: [generations.userId, generations.id],
    }),
    unique('uq_artifact_version_storage').on(table.storageProvider, table.storageKey),
    unique('uq_artifact_generation_stream').on(
      table.sourceGenerationId,
      table.streamArtifactId,
    ),
    index('idx_artifact_version_history').on(
      table.artifactId,
      table.version.desc(),
    ),
    index('idx_artifact_version_message').on(table.sourceMessageId),
  ],
)

export const usageEvents = pgTable(
  'UsageEvent',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generationId: uuid('generationId').references(() => generations.id, {
      onDelete: 'set null',
    }),
    inputTokens: bigintValue('inputTokens').notNull().default(sql`0`),
    outputTokens: bigintValue('outputTokens').notNull().default(sql`0`),
    totalTokens: bigintValue('totalTokens')
      .generatedAlwaysAs(sql`"inputTokens" + "outputTokens"`),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_usage_tokens',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`,
    ),
    uniqueIndex('uq_usage_generation')
      .on(table.generationId)
      .where(sql`${table.generationId} is not null`),
    foreignKey({
      name: 'fk_usage_user_generation',
      columns: [table.userId, table.generationId],
      foreignColumns: [generations.userId, generations.id],
    }),
    index('idx_usage_user_created').on(table.userId, table.createdAt.desc()),
  ],
)

export const auditLogs = pgTable(
  'AuditLog',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorUserId: uuid('actorUserId').references(() => users.id, { onDelete: 'set null' }),
    actorExternalUserId: varchar('actorExternalUserId', { length: 128 }),
    requestId: varchar('requestId', { length: 128 }),
    action: varchar('action', { length: 128 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull().default('success'),
    resourceType: varchar('resourceType', { length: 64 }),
    resourceId: text('resourceId'),
    ip: inet('ip'),
    userAgent: text('userAgent'),
    metadata: jsonb('metadata').$type<JsonRecord>().notNull().default({}),
    createdAt: timestampTz('createdAt').notNull().defaultNow(),
  },
  (table) => [
    check('chk_audit_outcome', sql`${table.outcome} in ('success', 'denied', 'failed')`),
    index('idx_audit_actor').on(table.actorUserId, table.createdAt.desc()),
    index('idx_audit_resource').on(
      table.resourceType,
      table.resourceId,
      table.createdAt.desc(),
    ),
    index('idx_audit_request')
      .on(table.requestId)
      .where(sql`${table.requestId} is not null`),
    index('idx_audit_outcome').on(table.outcome, table.createdAt.desc()),
  ],
)

export const sharedChats = pgView('SharedChat').as((query) =>
  query
    .select({
      id: chats.id,
      ownerUserId: sql<string>`${chats.userId}`.as('ownerUserId'),
      title: chats.title,
      chatType: chats.chatType,
      shareMode: chats.shareMode,
      sharedThroughSeq: chats.sharedThroughSeq,
      sharedAt: chats.sharedAt,
      shareSlug: chats.shareSlug,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(
      sql`${chats.shareScope} = 'authenticated' and ${chats.deletedAt} is null`,
    ),
)

export const sharedChatMessages = pgView('SharedChatMessage').as((query) =>
  query
    .select({
      id: messages.id,
      chatId: messages.chatId,
      seq: messages.seq,
      role: messages.role,
      sharedText: messages.sharedText,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(chats, sql`${chats.id} = ${messages.chatId}`)
    .where(sql`
      ${chats.shareScope} = 'authenticated'
      and ${chats.deletedAt} is null
      and ${messages.role} in ('user', 'assistant')
      and ${messages.status} = 'completed'
      and ${messages.sharedText} is not null
      and (
        ${chats.shareMode} = 'live'
        or (${chats.shareMode} = 'snapshot' and ${messages.seq} <= ${chats.sharedThroughSeq})
      )
    `),
)

export const sharedArtifacts = pgView('SharedArtifact').as((query) =>
  query
    .select({
      id: artifacts.id,
      chatId: artifacts.chatId,
      messageId: artifacts.messageId,
      title: artifacts.title,
      artifactType: artifacts.artifactType,
      format: artifacts.format,
      status: artifacts.status,
      content: artifacts.content,
      mimeType: artifacts.mimeType,
      sizeBytes: artifacts.sizeBytes,
      hasStoredContent: sql<boolean>`${artifacts.storageKey} is not null`.as('hasStoredContent'),
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      expiresAt: artifacts.expiresAt,
    })
    .from(artifacts)
    .innerJoin(
      messages,
      sql`${messages.id} = ${artifacts.messageId} and ${messages.chatId} = ${artifacts.chatId}`,
    )
    .innerJoin(chats, sql`${chats.id} = ${artifacts.chatId}`)
    .where(sql`
      ${chats.shareScope} = 'authenticated'
      and ${chats.deletedAt} is null
      and ${artifacts.isChatShareable} = true
      and ${artifacts.status} = 'ready'
      and ${messages.status} = 'completed'
      and ${artifacts.deletedAt} is null
      and (${artifacts.expiresAt} is null or ${artifacts.expiresAt} > now())
      and (
        ${chats.shareMode} = 'live'
        or (${chats.shareMode} = 'snapshot' and ${messages.seq} <= ${chats.sharedThroughSeq})
      )
    `),
)
