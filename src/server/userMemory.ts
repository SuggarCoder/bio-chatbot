import { and, desc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'

import type { DatabaseTransaction } from './backgroundJobs.js'
import type { Database } from './db/client.js'
import {
  chats,
  generations,
  messages,
  USER_MEMORY_CATEGORIES,
  USER_MEMORY_CONTENT_MAX_CHARS,
  userMemories,
  users,
  type UserMemoryCategory,
  type UserMemorySource,
} from './db/schema.js'
import type { TokenCounter } from './tokenBudget.js'

type Executor = Database | DatabaseTransaction

export { USER_MEMORY_CATEGORIES, USER_MEMORY_CONTENT_MAX_CHARS }
export type { UserMemoryCategory, UserMemorySource }

export const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,95}$/

export const MEMORY_CATEGORY_LABELS: Record<UserMemoryCategory, string> = {
  identity: '身份与背景',
  work: '工作与长期项目',
  preference: '偏好与习惯',
  current: '近期关注',
  other: '其他',
}

export type UserMemoryEntry = {
  key: string
  category: UserMemoryCategory
  content: string
  source: UserMemorySource
  updatedAt: Date
}

export type UserMemoryRecord = UserMemoryEntry & {
  id: string
  sourceChatId: string | null
  createdAt: Date
}

export function normalizeMemoryKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MEMORY_KEY_PATTERN.test(key) ? key : null
}

export function normalizeMemoryContent(value: unknown): string | null {
  const content = typeof value === 'string' ? value.trim().replace(/\s*\n\s*/g, ' ') : ''
  return content && content.length <= USER_MEMORY_CONTENT_MAX_CHARS ? content : null
}

export function normalizeMemoryCategory(value: unknown): UserMemoryCategory {
  return (USER_MEMORY_CATEGORIES as readonly unknown[]).includes(value)
    ? value as UserMemoryCategory
    : 'other'
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

const USER_MEMORY_HEADER = [
  '## 关于该用户的记忆',
  '以下信息来自你与该用户此前的对话，按类别整理，括号内是条目标识。使用规则：',
  '- 只在与当前问题相关时自然地运用，不要逐条复述；除非用户问起，不要说“根据我的记忆”“我记得你说过”。',
  '- 与当前对话冲突时以当前对话为准。',
  '- 用户问你记得关于他的什么时，如实、完整地概括下列内容。',
  '- 不要向用户展示条目标识、类别代码等内部格式。',
].join('\n')

/** Entries kept first when the budget is tight: user-confirmed, then by category. */
function injectionPriority(entry: UserMemoryEntry): number {
  const source = entry.source === 'auto' ? 1 : 0
  return source * 10 + USER_MEMORY_CATEGORIES.indexOf(entry.category)
}

/**
 * Renders in a fixed category/key order, so the instructions only change when
 * a memory does and the provider's prefix cache keeps hitting.
 */
export function renderUserMemoryInstructions(entries: UserMemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = [USER_MEMORY_HEADER]
  for (const category of USER_MEMORY_CATEGORIES) {
    const group = entries
      .filter((entry) => entry.category === category)
      .sort((left, right) => left.key.localeCompare(right.key))
    if (group.length === 0) continue
    lines.push(`### ${MEMORY_CATEGORY_LABELS[category]}`)
    for (const entry of group) lines.push(`- (${entry.key}) ${entry.content}`)
  }
  return lines.join('\n')
}

/** Tokens the full memory set would cost if every entry were injected. */
export function countUserMemoryTokens(
  tokenCounter: TokenCounter,
  entries: UserMemoryEntry[],
): number {
  return entries.length === 0
    ? 0
    : tokenCounter.countText(renderUserMemoryInstructions(entries))
}

/**
 * Picks the entries that fit the budget, highest priority first, then renders
 * them in the stable order. The worker keeps the set within budget, so this
 * only trims a set that has not been consolidated yet.
 */
export function selectMemoriesWithinBudget(
  tokenCounter: TokenCounter,
  entries: UserMemoryEntry[],
  tokenBudget: number,
): UserMemoryEntry[] {
  const ranked = [...entries].sort((left, right) =>
    injectionPriority(left) - injectionPriority(right) ||
    right.updatedAt.getTime() - left.updatedAt.getTime())
  const selected: UserMemoryEntry[] = []
  for (const entry of ranked) {
    const next = [...selected, entry]
    if (countUserMemoryTokens(tokenCounter, next) > tokenBudget) continue
    selected.push(entry)
  }
  return selected
}

// ---------------------------------------------------------------------------
// Settings and scope
// ---------------------------------------------------------------------------

export type MemorySettings = {
  memoryEnabled: boolean
  chatSearchEnabled: boolean
}

export async function loadMemorySettings(
  database: Executor,
  userId: string,
): Promise<MemorySettings> {
  const [row] = await database
    .select({
      memoryEnabled: users.memoryEnabled,
      chatSearchEnabled: users.chatSearchEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row ?? { memoryEnabled: false, chatSearchEnabled: false }
}

export async function updateMemorySettings(
  database: Database,
  userId: string,
  input: Partial<MemorySettings>,
): Promise<MemorySettings> {
  const set: Partial<MemorySettings> = {}
  if (typeof input.memoryEnabled === 'boolean') set.memoryEnabled = input.memoryEnabled
  if (typeof input.chatSearchEnabled === 'boolean') set.chatSearchEnabled = input.chatSearchEnabled
  if (Object.keys(set).length > 0) {
    await database.update(users).set({ ...set, updatedAt: sql`now()` }).where(eq(users.id, userId))
  }
  return loadMemorySettings(database, userId)
}

/** What one generation may do with memory, decided by config, user and chat. */
export type MemoryAccess = {
  readMemory: boolean
  editMemory: boolean
  searchChats: boolean
}

export async function resolveMemoryAccess(
  database: Database,
  input: {
    userId: string
    chatId: string
    userMemoryEnabled: boolean
    chatSearchEnabled: boolean
  },
): Promise<MemoryAccess> {
  const none = { readMemory: false, editMemory: false, searchChats: false }
  if (!input.userMemoryEnabled && !input.chatSearchEnabled) return none
  const [row] = await database
    .select({
      incognito: chats.incognito,
      memoryEnabled: users.memoryEnabled,
      chatSearchEnabled: users.chatSearchEnabled,
    })
    .from(chats)
    .innerJoin(users, eq(users.id, chats.userId))
    .where(and(eq(chats.id, input.chatId), eq(chats.userId, input.userId)))
    .limit(1)
  if (!row || row.incognito) return none
  const memory = input.userMemoryEnabled && row.memoryEnabled
  return {
    readMemory: memory,
    editMemory: memory,
    searchChats: input.chatSearchEnabled && row.chatSearchEnabled,
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const memorySelection = {
  id: userMemories.id,
  key: userMemories.key,
  category: userMemories.category,
  content: userMemories.content,
  source: userMemories.source,
  sourceChatId: userMemories.sourceChatId,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
}

export async function listUserMemories(
  database: Executor,
  userId: string,
  limit = 400,
): Promise<UserMemoryRecord[]> {
  const rows = await database
    .select(memorySelection)
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.updatedAt), userMemories.key)
    .limit(limit)
  return rows.map((row) => ({
    ...row,
    category: normalizeMemoryCategory(row.category),
    source: row.source as UserMemorySource,
  }))
}

export async function buildUserMemoryInstructions(
  database: Database,
  userId: string,
  input: { tokenBudget: number; maxItems: number; tokenCounter: TokenCounter },
): Promise<string> {
  await input.tokenCounter.initialize()
  const rows = await listUserMemories(database, userId, input.maxItems * 2)
  return renderUserMemoryInstructions(
    selectMemoriesWithinBudget(input.tokenCounter, rows, input.tokenBudget),
  )
}

/** Serializes every write to one user's memory set across API and workers. */
export async function lockUserMemories(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`user-memory:${userId}`}, 0))`,
  )
}

export function generatedMemoryKey(prefix = 'note'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export async function upsertUserMemory(
  executor: Executor,
  input: {
    userId: string
    key: string
    category: UserMemoryCategory
    content: string
    source: UserMemorySource
    sourceChatId: string | null
  },
): Promise<UserMemoryRecord> {
  const [row] = await executor
    .insert(userMemories)
    .values({
      userId: input.userId,
      key: input.key,
      category: input.category,
      content: input.content,
      source: input.source,
      sourceChatId: input.sourceChatId,
    })
    .onConflictDoUpdate({
      target: [userMemories.userId, userMemories.key],
      set: {
        category: input.category,
        content: input.content,
        source: input.source,
        sourceChatId: input.sourceChatId,
        updatedAt: sql`now()`,
      },
    })
    .returning(memorySelection)
  return {
    ...row!,
    category: normalizeMemoryCategory(row!.category),
    source: row!.source as UserMemorySource,
  }
}

/** Edits from the settings page; the result counts as user-confirmed. */
export async function editUserMemory(
  database: Database,
  userId: string,
  id: string,
  input: { content?: string; category?: UserMemoryCategory },
): Promise<UserMemoryRecord | null> {
  return database.transaction(async (transaction) => {
    await lockUserMemories(transaction, userId)
    const [row] = await transaction
      .update(userMemories)
      .set({
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        source: 'user',
        updatedAt: sql`now()`,
      })
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
      .returning(memorySelection)
    return row
      ? { ...row, category: normalizeMemoryCategory(row.category), source: row.source as UserMemorySource }
      : null
  })
}

export async function createUserMemory(
  database: Database,
  userId: string,
  input: { content: string; category: UserMemoryCategory },
): Promise<UserMemoryRecord> {
  return database.transaction(async (transaction) => {
    await lockUserMemories(transaction, userId)
    return upsertUserMemory(transaction, {
      userId,
      key: generatedMemoryKey(),
      category: input.category,
      content: input.content,
      source: 'user',
      sourceChatId: null,
    })
  })
}

export async function deleteUserMemories(
  database: Database,
  userId: string,
  filter: { ids?: string[]; keys?: string[] } = {},
): Promise<number> {
  if (filter.ids?.length === 0 || filter.keys?.length === 0) return 0
  return database.transaction(async (transaction) => {
    await lockUserMemories(transaction, userId)
    const rows = await transaction
      .delete(userMemories)
      .where(and(
        eq(userMemories.userId, userId),
        filter.ids ? inArray(userMemories.id, filter.ids) : undefined,
        filter.keys ? inArray(userMemories.key, filter.keys) : undefined,
      ))
      .returning({ key: userMemories.key })
    return rows.length
  })
}

/**
 * A deleted chat stops contributing to memory: entries the model learned from
 * it go with it. Entries the user wrote in settings have no source chat.
 */
export async function forgetChatMemories(
  executor: Executor,
  userId: string,
  chatId: string,
): Promise<void> {
  await executor
    .delete(userMemories)
    .where(and(
      eq(userMemories.userId, userId),
      eq(userMemories.sourceChatId, chatId),
      inArray(userMemories.source, ['auto', 'tool']),
    ))
}

// ---------------------------------------------------------------------------
// Shared filters
// ---------------------------------------------------------------------------

/**
 * Excludes assistant replies that a completed regeneration replaced.
 * `messageId` is the column holding the assistant message id in the outer query.
 */
export function notSupersededMessage(
  database: Executor,
  messageId: AnyPgColumn = messages.id,
) {
  const original = alias(generations, 'superseded_original')
  const replacement = alias(generations, 'superseded_replacement')
  return notExists(
    database
      .select({ value: sql`1` })
      .from(original)
      .innerJoin(replacement, eq(replacement.supersedesGenerationId, original.id))
      .where(and(
        eq(original.assistantMessageId, messageId),
        eq(replacement.status, 'completed'),
      )),
  )
}
