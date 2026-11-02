import { and, asc, cosineDistance, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'

import type { Database } from './db/client.js'
import { chats, chatSummaries, messageChunks, messages } from './db/schema.js'
import type { Embedder } from './embeddings.js'
import { notSupersededMessage } from './userMemory.js'

// ---------------------------------------------------------------------------
// Lexical matching
// ---------------------------------------------------------------------------

const CJK = /[㐀-鿿豈-﫿]/
const SEPARATORS = /[\s,，。.;；:：!！?？、"“”'‘’()（）[\]【】<>《》/\\|]+/

/**
 * Splits a query into keyword terms. Latin words are kept whole; a run of CJK
 * characters is kept whole when short and also split into bigrams, since
 * PostgreSQL has no Chinese word segmentation by default.
 */
export function searchTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const raw of query.toLowerCase().split(SEPARATORS)) {
    if (!raw) continue
    let latin = ''
    let cjk = ''
    const flush = () => {
      if (latin.length >= 2) terms.add(latin)
      if (cjk.length >= 1) {
        if (cjk.length <= 4) terms.add(cjk)
        if (cjk.length >= 3) {
          for (let index = 0; index < cjk.length - 1; index += 1) terms.add(cjk.slice(index, index + 2))
        }
      }
      latin = ''
      cjk = ''
    }
    for (const char of raw) {
      if (CJK.test(char)) {
        if (latin) flush()
        cjk += char
      } else {
        if (cjk) flush()
        latin += char
      }
    }
    flush()
  }
  return [...terms].slice(0, 16)
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    // Longer terms are more specific than a bigram.
    if (lower.includes(term)) score += Math.min(4, term.length)
  }
  return score
}

export function snippetAround(text: string, terms: string[], radius = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
  const center = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, center - radius)
  const end = Math.min(flat.length, center + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

const CHUNK_USER_MAX_CHARS = 1_500
const CHUNK_ASSISTANT_MAX_CHARS = 2_500

function clip(text: string, limit: number): string {
  const flat = text.trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** The searchable text of one turn: what the user asked and how it was answered. */
export function buildChunkContent(user: string, assistant: string): string {
  return [
    user.trim() ? `用户：${clip(user, CHUNK_USER_MAX_CHARS)}` : '',
    assistant.trim() ? `助手：${clip(assistant, CHUNK_ASSISTANT_MAX_CHARS)}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Stores (or refreshes) the chunk for one completed turn and embeds it. The
 * chunk is written before embedding, so keyword search finds it even when the
 * embedding call fails and the job is retried.
 */
export async function indexChatTurn(
  database: Database,
  embedder: Embedder | null,
  input: { userId: string; chatId: string; assistantMessageId: string; userMessageId?: string },
): Promise<{ tokens: number } | undefined> {
  const [chat] = await database
    .select({ incognito: chats.incognito, deletedAt: chats.deletedAt })
    .from(chats)
    .where(and(eq(chats.id, input.chatId), eq(chats.userId, input.userId)))
    .limit(1)
  if (!chat || chat.incognito || chat.deletedAt) return undefined

  const [assistant] = await database
    .select({ seq: messages.seq, content: messages.content })
    .from(messages)
    .where(and(
      eq(messages.id, input.assistantMessageId),
      eq(messages.userId, input.userId),
      eq(messages.chatId, input.chatId),
      eq(messages.role, 'assistant'),
      eq(messages.status, 'completed'),
    ))
    .limit(1)
  if (!assistant) return undefined
  const [user] = await database
    .select({ content: messages.content })
    .from(messages)
    .where(and(
      eq(messages.userId, input.userId),
      eq(messages.chatId, input.chatId),
      eq(messages.role, 'user'),
      input.userMessageId
        ? eq(messages.id, input.userMessageId)
        : lt(messages.seq, assistant.seq),
    ))
    .orderBy(desc(messages.seq))
    .limit(1)
  const content = buildChunkContent(user?.content ?? '', assistant.content ?? '')
  if (!content) return undefined

  const [chunk] = await database
    .insert(messageChunks)
    .values({
      userId: input.userId,
      chatId: input.chatId,
      assistantMessageId: input.assistantMessageId,
      seq: assistant.seq,
      content,
    })
    .onConflictDoUpdate({
      target: messageChunks.assistantMessageId,
      set: {
        content,
        // A changed text invalidates its vector.
        embedding: sql`case when ${messageChunks.content} = excluded."content" then ${messageChunks.embedding} end`,
        embeddingModel: sql`case when ${messageChunks.content} = excluded."content" then ${messageChunks.embeddingModel} end`,
      },
    })
    .returning({ id: messageChunks.id, embeddingModel: messageChunks.embeddingModel })
  if (!embedder || chunk!.embeddingModel === embedder.model) return undefined

  const { vectors, tokens } = await embedder.embed([content])
  await database
    .update(messageChunks)
    .set({ embedding: vectors[0]!, embeddingModel: embedder.model })
    .where(eq(messageChunks.id, chunk!.id))
  return { tokens }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Chats the user can still see, excluding incognito ones and the current one. */
function searchableChat(userId: string, excludeChatId?: string) {
  return and(
    eq(chats.userId, userId),
    isNull(chats.deletedAt),
    eq(chats.incognito, false),
    excludeChatId ? ne(chats.id, excludeChatId) : undefined,
  )
}

type Candidate = {
  id: bigint
  chatId: string
  title: string
  chatUpdatedAt: Date
  seq: bigint
  content: string
  createdAt: Date
}

/** Reciprocal rank fusion: robust to the two lists' incomparable scores. */
export function fuseRankings<T>(rankings: T[][], key: (item: T) => string, k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      const id = key(item)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return scores
}

export type ChatSearchHit = {
  chatId: string
  title: string
  updatedAt: string
  matches: Array<{
    seq: number
    createdAt: string
    excerpt: string
    /** Cosine similarity to the query when it was found semantically. */
    similarity: number | null
  }>
}

const CANDIDATES_PER_METHOD = 40

export async function searchUserChats(
  database: Database,
  embedder: Embedder | null,
  input: {
    userId: string
    query: string
    excludeChatId?: string
    limit?: number
    minSimilarity?: number
    signal?: AbortSignal
  },
): Promise<ChatSearchHit[]> {
  const terms = searchTerms(input.query)
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10)
  let queryVector: number[] | null = null
  if (embedder && input.query.trim()) {
    try {
      queryVector = (await embedder.embed([input.query.trim()], input.signal)).vectors[0] ?? null
    } catch (error) {
      if (input.signal?.aborted) throw error
      // Keyword search still answers when the embedding service is down.
      console.warn('Chat search query embedding failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (terms.length === 0 && !queryVector) return []

  const selection = {
    id: messageChunks.id,
    chatId: messageChunks.chatId,
    title: chats.title,
    chatUpdatedAt: chats.updatedAt,
    seq: messageChunks.seq,
    content: messageChunks.content,
    createdAt: messageChunks.createdAt,
  }
  const visible = and(
    eq(messageChunks.userId, input.userId),
    searchableChat(input.userId, input.excludeChatId),
    notSupersededMessage(database, messageChunks.assistantMessageId),
  )

  const similarity = new Map<string, number>()
  let semantic: Candidate[] = []
  if (queryVector && embedder) {
    const distance = cosineDistance(messageChunks.embedding, queryVector)
    // An exact scan over this user's chunks: complete and fast at per-user scale.
    const rows = await database
      .select({ ...selection, distance: sql<number>`${distance}` })
      .from(messageChunks)
      .innerJoin(chats, eq(chats.id, messageChunks.chatId))
      .where(and(
        visible,
        isNotNull(messageChunks.embedding),
        eq(messageChunks.embeddingModel, embedder.model),
      ))
      .orderBy(distance)
      .limit(CANDIDATES_PER_METHOD)
    for (const { distance: rowDistance, ...row } of rows) {
      const score = 1 - Number(rowDistance)
      if (score < (input.minSimilarity ?? 0)) continue
      semantic.push(row)
      similarity.set(String(row.id), score)
    }
  }

  let lexical: Candidate[] = []
  if (terms.length > 0) {
    const rows = await database
      .select(selection)
      .from(messageChunks)
      .innerJoin(chats, eq(chats.id, messageChunks.chatId))
      .where(and(
        visible,
        or(
          ...terms.map((term) => sql`${messageChunks.content} ilike ${`%${escapeLike(term)}%`}`),
          ...terms.map((term) => sql`${chats.title} ilike ${`%${escapeLike(term)}%`}`),
        ),
      ))
      .orderBy(desc(messageChunks.createdAt))
      .limit(400)
    lexical = rows
      .map((row) => ({ row, score: scoreText(row.content, terms) + scoreText(row.title, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.row.createdAt.getTime() - left.row.createdAt.getTime())
      .slice(0, CANDIDATES_PER_METHOD)
      .map((item) => item.row)
  }

  const fused = fuseRankings([semantic, lexical], (row) => String(row.id))
  const byId = new Map([...semantic, ...lexical].map((row) => [String(row.id), row]))
  const byChat = new Map<string, { candidate: Candidate; chunks: Array<{ row: Candidate; score: number }> }>()
  for (const [id, score] of fused) {
    const row = byId.get(id)!
    const entry = byChat.get(row.chatId) ?? { candidate: row, chunks: [] }
    entry.chunks.push({ row, score })
    byChat.set(row.chatId, entry)
  }
  const chatScore = (chunks: Array<{ score: number }>) => {
    const sorted = chunks.map((chunk) => chunk.score).sort((left, right) => right - left)
    // Best turn decides; further matching turns add a little.
    return sorted[0]! + 0.25 * sorted.slice(1).reduce((total, value) => total + value, 0)
  }

  return [...byChat.values()]
    .sort((left, right) =>
      chatScore(right.chunks) - chatScore(left.chunks) ||
      right.candidate.chatUpdatedAt.getTime() - left.candidate.chatUpdatedAt.getTime())
    .slice(0, limit)
    .map(({ candidate, chunks }) => ({
      chatId: candidate.chatId,
      title: candidate.title,
      updatedAt: candidate.chatUpdatedAt.toISOString(),
      matches: chunks
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .sort((left, right) => Number(left.row.seq - right.row.seq))
        .map(({ row }) => {
          const id = String(row.id)
          const lexicalHit = terms.length > 0 && scoreText(row.content, terms) > 0
          return {
            seq: Number(row.seq),
            createdAt: row.createdAt.toISOString(),
            excerpt: lexicalHit ? snippetAround(row.content, terms) : clip(row.content.replace(/\s+/g, ' '), 240),
            similarity: similarity.has(id) ? Math.round(similarity.get(id)! * 100) / 100 : null,
          }
        }),
    }))
}

// ---------------------------------------------------------------------------
// Recent chats
// ---------------------------------------------------------------------------

export type RecentChat = {
  chatId: string
  title: string
  createdAt: string
  updatedAt: string
  overview: string
}

function summaryOverview(summary: string): string {
  // The first section of the rolling summary is the user's goal.
  const goal = summary.match(/^##\s*用户目标\s*[:：]?\s*\n([\s\S]*?)(?=^##\s)/m)?.[1] ?? summary
  return goal.replace(/\s+/g, ' ').trim().slice(0, 300)
}

export async function listRecentUserChats(
  database: Database,
  input: {
    userId: string
    excludeChatId?: string
    limit?: number
    before?: Date
    after?: Date
  },
): Promise<RecentChat[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20)
  const rows = await database
    .select({
      chatId: chats.id,
      title: chats.title,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(and(
      searchableChat(input.userId, input.excludeChatId),
      input.before ? lt(chats.updatedAt, input.before) : undefined,
      input.after ? gt(chats.updatedAt, input.after) : undefined,
    ))
    .orderBy(desc(chats.updatedAt))
    .limit(limit)
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.chatId)
  const summaries = await database
    .selectDistinctOn([chatSummaries.chatId], {
      chatId: chatSummaries.chatId,
      summary: chatSummaries.summary,
    })
    .from(chatSummaries)
    .where(and(eq(chatSummaries.userId, input.userId), inArray(chatSummaries.chatId, ids)))
    .orderBy(chatSummaries.chatId, desc(chatSummaries.coveredMaxSeq), desc(chatSummaries.version))
  const firstMessages = await database
    .selectDistinctOn([messages.chatId], {
      chatId: messages.chatId,
      content: messages.content,
    })
    .from(messages)
    .where(and(
      eq(messages.userId, input.userId),
      inArray(messages.chatId, ids),
      eq(messages.role, 'user'),
    ))
    .orderBy(messages.chatId, asc(messages.seq))
  const summaryByChat = new Map(summaries.map((row) => [row.chatId, summaryOverview(row.summary)]))
  const firstByChat = new Map(firstMessages.map((row) => [
    row.chatId,
    (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  ]))
  return rows.map((row) => ({
    chatId: row.chatId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    overview: summaryByChat.get(row.chatId) ?? firstByChat.get(row.chatId) ?? '',
  }))
}

/** Chunks and their vectors are derived data; a deleted chat drops them. */
export async function deleteChatChunks(
  database: Pick<Database, 'delete'>,
  userId: string,
  chatId: string,
): Promise<void> {
  await database
    .delete(messageChunks)
    .where(and(eq(messageChunks.userId, userId), eq(messageChunks.chatId, chatId)))
}
