import { modelBudgetFetch } from './modelBudget.js'
import type { RedisClient } from './cache.js'
import OpenAI from 'openai'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  sql,
} from 'drizzle-orm'

import type { BackgroundWorkItem, DatabaseTransaction } from './backgroundJobs.js'
import type { AppConfig } from './config.js'
import {
  countSummaryContextTokens,
  countUserMemoryTokens,
} from './conversationMemory.js'
import type { Database } from './db.js'
import {
  chatSummaries,
  messages,
  userMemories,
} from './db/schema.js'
import type { TokenCounter } from './tokenBudget.js'

type BackgroundUsage = {
  kind: 'summary' | 'memory'
  inputTokens: number
  outputTokens: number
}

const SUMMARY_SECTIONS = [
  '用户目标',
  '已做决定',
  '关键实体与数字',
  'Artifact 演进',
  '待办事项',
] as const
// Older versions stay readable for generations that froze them at creation.
const SUMMARY_KEEP_VERSIONS = 3
const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,95}$/
const MEMORY_CONTENT_MAX_CHARS = 200
const MEMORY_OPERATIONS_PER_TURN = 8
// Consolidate below the limits so the next turns do not trigger it again.
const MEMORY_CONSOLIDATION_RATIO = 0.75
// DashScope extension: background tasks do not need a reasoning trace, and
// reasoning would compete with the summary for max_output_tokens.
const BACKGROUND_REQUEST_EXTRAS: Record<string, unknown> = { enable_thinking: false }

function addBackgroundUsage(
  left: BackgroundUsage,
  right: BackgroundUsage,
): BackgroundUsage {
  return {
    kind: left.kind,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

function usageOf(
  response: unknown,
  kind: BackgroundUsage['kind'],
): BackgroundUsage {
  const usage = (response as {
    usage?: { input_tokens?: unknown; output_tokens?: unknown }
  }).usage
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0
  return {
    kind,
    inputTokens: number(usage?.input_tokens),
    outputTokens: number(usage?.output_tokens),
  }
}

function responseText(response: unknown): string {
  const text = (response as { output_text?: unknown }).output_text
  return typeof text === 'string' ? text.trim() : ''
}

/** Rejects truncated or failed responses so they are never persisted. */
function completedText(response: unknown, label: string): string {
  const { status, incomplete_details: details } = response as {
    status?: unknown
    incomplete_details?: { reason?: unknown } | null
  }
  if (status !== undefined && status !== 'completed') {
    const reason = details?.reason ? `: ${String(details.reason)}` : ''
    throw new Error(`${label} model response is ${String(status)}${reason}`)
  }
  const text = responseText(response)
  if (!text) throw new Error(`${label} model returned empty output`)
  return text
}

export function normalizeSummary(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

export function missingSummarySections(summary: string): string[] {
  return SUMMARY_SECTIONS.filter((section) =>
    !new RegExp(`^##\\s*${section.replace(/ /g, '\\s*')}\\s*[:：]?\\s*$`, 'm').test(summary))
}

function assertSummarySections(summary: string): void {
  const missing = missingSummarySections(summary)
  if (missing.length > 0) {
    throw new Error(`Summary is missing sections: ${missing.join(', ')}`)
  }
}

function summaryInstructions(targetTokens: number): string {
  return [
    '你负责更新会话滚动摘要。只输出结构化 Markdown，不要解释。',
    `必须保留并合并以下五个二级标题，依次为：${SUMMARY_SECTIONS.map((section) => `## ${section}`).join('、')}。`,
    `全文控制在约 ${targetTokens} 字以内。超出时优先压缩最早、已完成或已失效的内容；仍有效的决定、关键实体与精确数字、未完成的待办必须保留。`,
    '不要虚构；已失效的决定或 Artifact 状态要明确标注演进关系。',
  ].join('\n')
}

function summaryCompactionInstructions(targetTokens: number): string {
  return [
    `把下面的会话摘要压缩到约 ${targetTokens} 字以内。只输出结构化 Markdown，不要解释。`,
    `保留五个二级标题：${SUMMARY_SECTIONS.map((section) => `## ${section}`).join('、')}。`,
    '合并重复表述，删去已完成或已失效且不影响后续对话的细节；仍有效的决定、关键实体与精确数字、未完成的待办必须保留。不要加入新信息。',
  ].join('\n')
}

export type MemoryOperation =
  | { action: 'delete'; key: string }
  | { action: 'upsert'; key: string; content: string }

function normalizeMemoryKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MEMORY_KEY_PATTERN.test(key) ? key : null
}

function normalizeMemoryContent(value: unknown): string | null {
  const content = typeof value === 'string' ? value.trim() : ''
  return content && content.length <= MEMORY_CONTENT_MAX_CHARS ? content : null
}

/** Invalid operations are dropped; the rest of the turn still applies. */
export function parseMemoryOperations(text: string): MemoryOperation[] {
  const parsed = parseJsonObject(text)
  const values = Array.isArray(parsed.operations)
    ? parsed.operations.slice(0, MEMORY_OPERATIONS_PER_TURN)
    : []
  return values.flatMap((value): MemoryOperation[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const operation = value as Record<string, unknown>
    const key = normalizeMemoryKey(operation.key)
    if (!key) return []
    if (operation.action === 'delete') return [{ action: 'delete', key }]
    const content = normalizeMemoryContent(operation.content)
    return operation.action === 'upsert' && content
      ? [{ action: 'upsert', key, content }]
      : []
  })
}

export type ConsolidatedMemory = { key: string; content: string; sources: string[] }

/**
 * A consolidation replaces the whole set, so any malformed entry rejects the
 * result instead of silently dropping that memory.
 */
export function parseConsolidatedMemories(
  text: string,
  knownKeys: string[],
  maxItems: number,
): ConsolidatedMemory[] {
  const parsed = parseJsonObject(text)
  if (!Array.isArray(parsed.memories)) {
    throw new Error('Consolidation response has no memories array')
  }
  if (parsed.memories.length === 0 && knownKeys.length > 0) {
    throw new Error('Consolidation response dropped every memory')
  }
  if (parsed.memories.length > maxItems) {
    throw new Error(`Consolidation response has more than ${maxItems} memories`)
  }
  const known = new Set(knownKeys)
  const seen = new Set<string>()
  return parsed.memories.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Consolidation response has a non-object memory')
    }
    const memory = value as Record<string, unknown>
    const key = normalizeMemoryKey(memory.key)
    const content = normalizeMemoryContent(memory.content)
    if (!key || !content) throw new Error('Consolidation response has an invalid memory')
    if (seen.has(key)) throw new Error(`Consolidation response repeats key ${key}`)
    seen.add(key)
    const sources = Array.isArray(memory.sources)
      ? memory.sources.flatMap((source) => {
          const sourceKey = normalizeMemoryKey(source)
          return sourceKey && known.has(sourceKey) ? [sourceKey] : []
        })
      : []
    if (known.has(key) && !sources.includes(key)) sources.push(key)
    return { key, content, sources }
  })
}

type StoredMemory = {
  key: string
  content: string
  sourceChatId: string | null
  updatedAt: Date
}

function memoryFingerprint(rows: StoredMemory[]): string {
  return JSON.stringify(rows.map((row) => [row.key, row.content, row.updatedAt.getTime()]))
}

/** Serializes every write to one user's memory set across workers. */
async function lockUserMemories(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`user-memory:${userId}`}, 0))`,
  )
}

function parseJsonObject(text: string): Record<string, unknown> {
  const normalized = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const parsed: unknown = JSON.parse(normalized)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Background model returned a non-object JSON response')
  }
  return parsed as Record<string, unknown>
}

export class MemoryProcessor {
  private readonly qwen: OpenAI

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly tokenCounter: TokenCounter,
    redis?: RedisClient,
  ) {
    this.qwen = new OpenAI({
      ...(redis ? { fetch: modelBudgetFetch(config, redis) } : {}),
      apiKey: config.qwenApiKey,
      baseURL: config.qwenBaseUrl,
      timeout: config.backgroundTimeoutMs,
      maxRetries: 0,
    })
  }

  async process(job: BackgroundWorkItem): Promise<BackgroundUsage | undefined> {
    if (job.type === 'chat.summary') return this.summarize(job)
    if (job.type === 'user.memory') return this.extractMemory(job)
    return undefined
  }

  private async summarize(
    job: BackgroundWorkItem,
  ): Promise<BackgroundUsage | undefined> {
    if (!this.config.contextMemoryEnabled || !job.chatId) return undefined
    await this.tokenCounter.initialize()

    const [previous] = await this.database
      .select({
        version: chatSummaries.version,
        coveredMaxSeq: chatSummaries.coveredMaxSeq,
        summary: chatSummaries.summary,
      })
      .from(chatSummaries)
      .where(and(
        eq(chatSummaries.userId, job.userId),
        eq(chatSummaries.chatId, job.chatId),
      ))
      .orderBy(desc(chatSummaries.coveredMaxSeq), desc(chatSummaries.version))
      .limit(1)

    const assistantSeq = typeof job.payload.assistantSeq === 'number'
      ? job.payload.assistantSeq
      : Number.MAX_SAFE_INTEGER
    const rows = await this.database
      .select({
        seq: messages.seq,
        role: messages.role,
        content: messages.content,
        parts: messages.parts,
      })
      .from(messages)
      .where(and(
        eq(messages.userId, job.userId),
        eq(messages.chatId, job.chatId),
        previous
          ? gt(messages.seq, previous.coveredMaxSeq)
          : undefined,
        lte(messages.seq, BigInt(assistantSeq)),
        sql`(${messages.role} = 'user' or (${messages.role} = 'assistant' and ${messages.status} = 'completed'))`,
      ))
      .orderBy(desc(messages.seq))
      .limit(2_000)

    const retainedBudget = Math.floor(this.config.chatHistoryTokenBudget * 0.75)
    let retainedTokens = 0
    const candidates: typeof rows = []
    for (const row of rows) {
      const content = row.content ?? ''
      const cost = this.tokenCounter.countMessages([{
        role: row.role as 'user' | 'assistant',
        content,
      }])
      if (retainedTokens + cost <= retainedBudget && candidates.length === 0) {
        retainedTokens += cost
      } else {
        candidates.push(row)
      }
    }
    candidates.reverse()

    let candidateTokens = 0
    const batch: typeof candidates = []
    const batchLimit = Math.min(32_768, this.config.chatHistoryTokenBudget)
    for (const row of candidates) {
      const artifactRefs = row.parts
        .filter((part) => part.type === 'artifact_ref')
        .map((part) => part.type === 'artifact_ref'
          ? `${part.logicalId}@v${part.version}`
          : '')
        .filter(Boolean)
      const content = [
        row.content ?? '',
        artifactRefs.length > 0
          ? `[Artifact 版本变化: ${artifactRefs.join(', ')}]`
          : '',
      ].filter(Boolean).join('\n')
      const cost = this.tokenCounter.countText(content) + 4
      if (batch.length > 0 && candidateTokens + cost > batchLimit) break
      batch.push(row)
      candidateTokens += cost
    }
    if (candidateTokens < this.config.summaryTriggerTokens || batch.length === 0) {
      return undefined
    }

    const transcript = batch.map((row) => {
      const refs = row.parts
        .filter((part) => part.type === 'artifact_ref')
        .map((part) => part.type === 'artifact_ref'
          ? `${part.logicalId}@v${part.version}`
          : '')
        .filter(Boolean)
      return [
        `[seq=${row.seq} role=${row.role}]`,
        row.content ?? '',
        refs.length > 0 ? `[Artifacts: ${refs.join(', ')}]` : '',
      ].filter(Boolean).join('\n')
    }).join('\n\n')
    const coveredMaxSeq = batch.at(-1)!.seq
    const targetTokens = this.config.summaryTargetTokens
    const budgetTokens = this.config.chatSummaryTokenBudget
    const drafted = await this.complete('Summary', 'summary', {
      instructions: summaryInstructions(targetTokens),
      input: [
        previous?.summary
          ? `旧摘要：\n${previous.summary}`
          : '旧摘要：无',
        `新增消息：\n${transcript}`,
      ].join('\n\n'),
      max_output_tokens: budgetTokens,
    })
    let usage = drafted.usage
    let summary = normalizeSummary(drafted.text)
    assertSummarySections(summary)
    const summaryTokens = () =>
      countSummaryContextTokens(this.tokenCounter, coveredMaxSeq, summary)
    if (summaryTokens() > targetTokens * 1.25) {
      const compacted = await this.complete('Summary compaction', 'summary', {
        instructions: summaryCompactionInstructions(targetTokens),
        input: summary,
        max_output_tokens: budgetTokens,
      })
      usage = addBackgroundUsage(usage, compacted.usage)
      summary = normalizeSummary(compacted.text)
      assertSummarySections(summary)
    }
    // The context builder drops a summary over budget, so never store one.
    if (summaryTokens() > budgetTokens) {
      throw new Error('Summary exceeds CHAT_SUMMARY_TOKEN_BUDGET after compaction')
    }

    await this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({
          version: chatSummaries.version,
          coveredMaxSeq: chatSummaries.coveredMaxSeq,
        })
        .from(chatSummaries)
        .where(and(
          eq(chatSummaries.userId, job.userId),
          eq(chatSummaries.chatId, job.chatId!),
        ))
        .orderBy(desc(chatSummaries.coveredMaxSeq), desc(chatSummaries.version))
        .limit(1)
      if ((current?.version ?? 0) !== (previous?.version ?? 0)) return
      const version = (previous?.version ?? 0) + 1
      const inserted = await transaction
        .insert(chatSummaries)
        .values({
          userId: job.userId,
          chatId: job.chatId!,
          version,
          coveredMaxSeq,
          summary,
        })
        .onConflictDoNothing()
        .returning({ version: chatSummaries.version })
      if (inserted.length === 0) return
      await transaction
        .delete(chatSummaries)
        .where(and(
          eq(chatSummaries.userId, job.userId),
          eq(chatSummaries.chatId, job.chatId!),
          lte(chatSummaries.version, version - SUMMARY_KEEP_VERSIONS),
          lt(chatSummaries.createdAt, sql`now() - interval '1 day'`),
        ))
    })
    return usage
  }

  private async complete(
    label: string,
    kind: BackgroundUsage['kind'],
    request: { instructions: string; input: string; max_output_tokens: number },
  ): Promise<{ text: string; usage: BackgroundUsage }> {
    const response = await this.qwen.responses.create({
      ...BACKGROUND_REQUEST_EXTRAS,
      model: this.config.backgroundModel,
      ...request,
    })
    return { text: completedText(response, label), usage: usageOf(response, kind) }
  }

  private async loadMemories(
    executor: Database | DatabaseTransaction,
    userId: string,
  ): Promise<StoredMemory[]> {
    return executor
      .select({
        key: userMemories.key,
        content: userMemories.content,
        sourceChatId: userMemories.sourceChatId,
        updatedAt: userMemories.updatedAt,
      })
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(desc(userMemories.updatedAt), userMemories.key)
      .limit(this.config.userMemoryMaxItems * 2)
  }

  private async extractMemory(
    job: BackgroundWorkItem,
  ): Promise<BackgroundUsage | undefined> {
    if (!this.config.userMemoryEnabled || !job.chatId) return undefined
    const userMessageId = typeof job.payload.userMessageId === 'string'
      ? job.payload.userMessageId
      : ''
    const assistantMessageId = typeof job.payload.assistantMessageId === 'string'
      ? job.payload.assistantMessageId
      : ''
    if (!userMessageId || !assistantMessageId) return undefined

    const turn = await this.database
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(and(
        eq(messages.userId, job.userId),
        sql`${messages.id} in (${userMessageId}, ${assistantMessageId})`,
      ))
      .orderBy(asc(messages.seq))
    if (turn.length !== 2) return undefined

    await this.tokenCounter.initialize()
    const existing = await this.loadMemories(this.database, job.userId)
    const extracted = await this.complete('Memory', 'memory', {
      instructions: [
        '判断本轮是否包含值得跨会话保存的稳定事实：身份、长期偏好、长期项目。',
        '临时请求、一次性数据、模型推断、敏感凭据不得保存。用户明确要求忘记时输出 delete。',
        '与现有记忆属于同一主题时，复用其 key 并输出合并后的完整内容，不要新建近义 key；与现有记忆冲突时以本轮信息覆盖。',
        '只输出 JSON：{"operations":[{"action":"upsert|delete","key":"snake_case","content":"不超过200字"}]}。无操作则 operations 为空数组。',
      ].join('\n'),
      input: [
        `现有记忆：${JSON.stringify(existing.map(({ key, content }) => ({ key, content })))}`,
        `本轮：${JSON.stringify(turn)}`,
      ].join('\n\n'),
      max_output_tokens: Math.min(1_024, this.config.backgroundMaxOutputTokens),
    })
    const operations = parseMemoryOperations(extracted.text)

    if (operations.length > 0) {
      await this.database.transaction(async (transaction) => {
        await lockUserMemories(transaction, job.userId)
        for (const operation of operations) {
          if (operation.action === 'delete') {
            await transaction
              .delete(userMemories)
              .where(and(
                eq(userMemories.userId, job.userId),
                eq(userMemories.key, operation.key),
              ))
            continue
          }
          await transaction
            .insert(userMemories)
            .values({
              userId: job.userId,
              key: operation.key,
              content: operation.content,
              sourceChatId: job.chatId!,
            })
            .onConflictDoUpdate({
              target: [userMemories.userId, userMemories.key],
              set: {
                content: operation.content,
                sourceChatId: job.chatId!,
                updatedAt: new Date(),
              },
            })
        }
      })
    }

    const consolidated = await this.consolidateMemories(job.userId)
    return consolidated
      ? addBackgroundUsage(extracted.usage, consolidated)
      : extracted.usage
  }

  /**
   * Keeps a user's memory set within USER_MEMORY_MAX_ITEMS and
   * USER_MEMORY_TOKEN_BUDGET by asking the model to merge, dedupe and drop
   * stale entries. Best effort: a failed attempt leaves the set unchanged and
   * the next extraction retries, while injection still enforces the budget.
   */
  private async consolidateMemories(
    userId: string,
  ): Promise<BackgroundUsage | undefined> {
    const maxItems = this.config.userMemoryMaxItems
    const budgetTokens = this.config.userMemoryTokenBudget
    const snapshot = await this.loadMemories(this.database, userId)
    if (
      snapshot.length <= maxItems &&
      countUserMemoryTokens(this.tokenCounter, snapshot) <= budgetTokens
    ) return undefined

    const targetItems = Math.floor(maxItems * MEMORY_CONSOLIDATION_RATIO)
    const targetTokens = Math.floor(budgetTokens * MEMORY_CONSOLIDATION_RATIO)
    let result: { text: string; usage: BackgroundUsage }
    try {
      result = await this.complete('Memory consolidation', 'memory', {
        instructions: [
          '你负责整理用户的跨会话记忆，使其精简、无重复、无矛盾。',
          '合并重复或同一主题的条目；删除已过时、被更新信息推翻或不再稳定的条目，冲突时以 updatedAt 较新的为准。',
          '只能改写、合并和删减，不得加入现有记忆之外的信息；身份、长期偏好、长期项目中的关键事实与精确数字必须保留。',
          `最多 ${targetItems} 条，全部内容合计约 ${targetTokens} 字以内，每条不超过 ${MEMORY_CONTENT_MAX_CHARS} 字。`,
          '尽量沿用原 key；sources 列出该条合并自的全部原 key。',
          '只输出 JSON：{"memories":[{"key":"snake_case","content":"...","sources":["原key"]}]}。',
        ].join('\n'),
        input: JSON.stringify(snapshot.map((row) => ({
          key: row.key,
          content: row.content,
          updatedAt: row.updatedAt.toISOString(),
        }))),
        max_output_tokens: this.config.backgroundMaxOutputTokens,
      })
    } catch (error) {
      console.warn('User memory consolidation request failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }

    try {
      const memories = parseConsolidatedMemories(
        result.text,
        snapshot.map((row) => row.key),
        maxItems,
      )
      if (countUserMemoryTokens(this.tokenCounter, memories) > budgetTokens) {
        throw new Error('Consolidated memories exceed USER_MEMORY_TOKEN_BUDGET')
      }
      await this.database.transaction(async (transaction) => {
        await lockUserMemories(transaction, userId)
        const current = await this.loadMemories(transaction, userId)
        // Another job changed the set meanwhile; the next extraction retries.
        if (memoryFingerprint(current) !== memoryFingerprint(snapshot)) return
        await transaction
          .delete(userMemories)
          .where(and(
            eq(userMemories.userId, userId),
            inArray(userMemories.key, snapshot.map((row) => row.key)),
          ))
        for (const memory of memories) {
          // Snapshot rows are newest first, so this is the most recent source.
          // Deleting that chat cascades to the merged memory.
          const source = snapshot.find((row) => memory.sources.includes(row.key))
          const updatedAt = source?.updatedAt ?? new Date()
          await transaction
            .insert(userMemories)
            .values({
              userId,
              key: memory.key,
              content: memory.content,
              sourceChatId: source?.sourceChatId ?? null,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: [userMemories.userId, userMemories.key],
              set: {
                content: memory.content,
                sourceChatId: source?.sourceChatId ?? null,
                updatedAt,
              },
            })
        }
      })
    } catch (error) {
      console.warn('User memory consolidation rejected', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return result.usage
  }
}
