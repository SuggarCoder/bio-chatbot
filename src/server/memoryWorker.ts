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
  or,
  sql,
} from 'drizzle-orm'

import type { BackgroundWorkItem, DatabaseTransaction } from './backgroundJobs.js'
import type { AppConfig } from './config.js'
import { countSummaryContextTokens } from './conversationMemory.js'
import type { Database } from './db.js'
import {
  chats,
  chatSummaries,
  messages,
  userMemories,
  users,
} from './db/schema.js'
import { messageCostTokens, type TokenCounter } from './tokenBudget.js'
import {
  countUserMemoryTokens,
  listUserMemories,
  lockUserMemories,
  normalizeMemoryCategory,
  normalizeMemoryContent,
  normalizeMemoryKey,
  notSupersededMessage,
  touchUserMemories,
  upsertUserMemory,
  type UserMemoryCategory,
} from './userMemory.js'
import { episodeKey, memoryExpiresAt, promoteRecurringMemories } from './memoryPolicy.js'

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
const MEMORY_OPERATIONS_PER_BATCH = 12
// The extractor reads a few turns at once; assistant text only gives context.
const EXTRACTION_WINDOW_TOKENS = 12_000
const EXTRACTION_CLIP = { user: 4_000, assistant: 1_500 }
// Routine (not over-limit) consolidation is pointless for a handful of entries.
const ROUTINE_CONSOLIDATION_MIN_ITEMS = 8
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
  | { action: 'touch'; key: string }
  | { action: 'upsert'; key: string; category: UserMemoryCategory; content: string }

/** Invalid operations are dropped; the rest of the batch still applies. */
export function parseMemoryOperations(text: string): MemoryOperation[] {
  return parseExtraction(text).operations
}

export type ExtractionResult = {
  operations: MemoryOperation[]
  /** The chat's updated digest, or null when it has nothing worth recalling. */
  episode: string | null
}

const EPISODE_MAX_CHARS = 300

export function parseExtraction(text: string): ExtractionResult {
  const parsed = parseJsonObject(text)
  const values = Array.isArray(parsed.operations)
    ? parsed.operations.slice(0, MEMORY_OPERATIONS_PER_BATCH)
    : []
  const operations = values.flatMap((value): MemoryOperation[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const operation = value as Record<string, unknown>
    const key = normalizeMemoryKey(operation.key)
    // Digests have their own field and key scheme.
    if (!key || key.startsWith('episode_')) return []
    if (operation.action === 'delete') return [{ action: 'delete', key }]
    if (operation.action === 'touch') return [{ action: 'touch', key }]
    const content = normalizeMemoryContent(operation.content)
    const category = normalizeMemoryCategory(operation.category)
    return operation.action === 'upsert' && content && category !== 'episode'
      ? [{ action: 'upsert', key, category, content }]
      : []
  })
  const episode = typeof parsed.episode === 'string'
    ? parsed.episode.trim().replace(/\s*\n\s*/g, ' ').slice(0, EPISODE_MAX_CHARS)
    : ''
  return { operations, episode: episode || null }
}

export type ConsolidatedMemory = {
  key: string
  category: UserMemoryCategory
  content: string
  sources: string[]
}

/**
 * A consolidation replaces the whole editable set, so any malformed entry
 * rejects the result instead of silently dropping that memory.
 */
export function parseConsolidatedMemories(
  text: string,
  knownKeys: string[],
  maxItems: number,
  reservedKeys: string[] = [],
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
  const reserved = new Set(reservedKeys)
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
    if (reserved.has(key)) throw new Error(`Consolidation response overwrites user entry ${key}`)
    seen.add(key)
    const sources = Array.isArray(memory.sources)
      ? memory.sources.flatMap((source) => {
          const sourceKey = normalizeMemoryKey(source)
          return sourceKey && known.has(sourceKey) ? [sourceKey] : []
        })
      : []
    if (known.has(key) && !sources.includes(key)) sources.push(key)
    return { key, category: normalizeMemoryCategory(memory.category), content, sources }
  })
}

function memoryFingerprint(rows: Array<{ key: string; content: string; updatedAt: Date }>): string {
  return JSON.stringify(
    [...rows]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((row) => [row.key, row.content, row.updatedAt.getTime()]),
  )
}

/** A retryable failure: the job runs again later with a fresh snapshot. */
export class MemorySetChangedError extends Error {
  constructor() {
    super('User memory set changed during extraction; retrying with a fresh snapshot')
  }
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

const CATEGORY_GUIDE = [
  '长期记忆（一直保留，信息变化时更新）：',
  '- identity：身份与背景，如职业、单位、研究方向、专业水平、常用语言',
  '- work：工作与长期项目，如持续在做的课题或项目、实验体系、物种或样本类型、长期目标',
  '- preference：偏好与习惯，如回答风格与格式、常用软件和分析方法',
  '- other：确实值得长期记住但不属于以上类别的信息',
  '近期记忆（一个月没人再提会自动淘汰，在多个对话里反复出现会自动转为 work）：',
  '- current：近期关注，如这几周在处理的问题、正在跑的一批样本、准备中的论文或汇报',
].join('\n')

export function extractionInstructions(): string {
  return [
    '你负责维护用户的跨会话记忆。阅读“新对话”，完成两件事：',
    '一、判断其中有没有值得记住的、关于用户本人的信息，输出对“现有记忆”的增删改操作。',
    '二、更新本会话的概要（episode）。',
    '记忆类别（必须是用户自己说出或明确确认的）：',
    CATEGORY_GUIDE,
    '分类原则：拿不准是长期还是近期时选 current，让它自然淘汰或升级；身份和偏好只有用户明确表达时才记。',
    '不要保存：',
    '- 一次性请求、临时数据、某次分析的具体结果（除非用户说明以后还要用）；',
    '- 助手的回答、建议或推断，以及用户只是提问而没有陈述的内容；',
    '- 敏感信息：密码、密钥、证件号、银行卡、精确住址，以及健康状况、宗教、政治倾向等，除非用户明确要求记住；',
    '- 现有记忆里已有且没有变化的内容。',
    '规则：',
    '- 与现有记忆属于同一主题时复用它的 key，输出合并后的完整内容，不要新建近义 key；冲突时以新对话为准。',
    '- 新对话再次涉及某条 current 记忆、但内容没有变化时，输出 touch，让它保持有效。',
    '- 用户要求忘记某事时删除对应条目，并且不要再保存这类信息。',
    '- source 为 user 的条目是用户亲自填写的；除非用户在新对话里明确更正，否则不要修改或删除。',
    '- content 用第三人称写成简洁完整的中文陈述（如“用户在做土壤宏基因组的耐药基因分析”），不超过 300 字。',
    '- “上文”只用于理解指代，不要从中提取信息。',
    'episode（本会话概要）：',
    '- 在“本会话已有概要”的基础上，用一两句中文概括这个会话至今讨论了什么、得出了什么结论或还有什么待办，写清主题和关键名词，不超过 150 字。',
    '- 它会在之后两周的新对话里作为“近期对话”提供给助手，帮助接上话题；不要写寒暄，不要写敏感信息。',
    '- 会话只是寒暄、测试或没有实质内容时，episode 输出 null。',
    '只输出 JSON：{"operations":[{"action":"upsert","key":"snake_case","category":"identity|work|preference|current|other","content":"..."},{"action":"touch","key":"..."},{"action":"delete","key":"..."}],"episode":"..."}。没有需要的操作时 operations 为空数组。',
  ].join('\n')
}

export function consolidationInstructions(input: {
  targetItems: number
  targetTokens: number
  today: string
}): string {
  return [
    '你负责整理用户的跨会话长期记忆，使它精简、无重复、无矛盾，读起来像一份连贯的用户画像。',
    '类别：',
    CATEGORY_GUIDE,
    '要求：',
    '- 合并重复或同一主题的条目，把零散事实改写成完整的陈述；删除被更新信息推翻或不再成立的条目，冲突时以 lastSeenAt 较新的为准。',
    `- 今天是 ${input.today}。保持条目原来的类别；current 会按 lastSeenAt 自动淘汰，不需要你删除，也不要把它改成长期类别，除非它明显是用户长期在做的事。`,
    '- 只能改写、合并和删减，不得加入现有记忆之外的信息；身份、长期项目中的关键事实与精确数字必须保留。',
    '- “用户填写的条目”只用于去重参考：不要输出它们，也不要输出与它们重复的内容，不能占用它们的 key。',
    `- 最多 ${input.targetItems} 条，全部内容合计约 ${input.targetTokens} 字以内，每条不超过 300 字。`,
    '- 尽量沿用原 key；sources 列出该条合并自的全部原 key。长期类和 current 不要合并成一条。',
    '只输出 JSON：{"memories":[{"key":"snake_case","category":"identity|work|preference|current|other","content":"...","sources":["原key"]}]}。',
  ].join('\n')
}

type WindowMessage = { seq: bigint; role: string; content: string | null }

function clip(text: string, limit: number): string {
  const flat = text.trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…（已截断）`
}

function renderTurns(rows: WindowMessage[], limits: { user: number; assistant: number }): string {
  return rows.map((row) => {
    const role = row.role === 'user' ? '用户' : '助手'
    return `[${role}] ${clip(row.content ?? '', row.role === 'user' ? limits.user : limits.assistant)}`
  }).join('\n\n')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The part of the model client the background jobs use. */
export type BackgroundModelClient = Pick<OpenAI, 'responses'>

export class MemoryProcessor {
  private readonly qwen: BackgroundModelClient

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly tokenCounter: TokenCounter,
    redis?: RedisClient,
    client?: BackgroundModelClient,
  ) {
    this.qwen = client ?? new OpenAI({
      ...(redis ? { fetch: modelBudgetFetch(config, redis) } : {}),
      apiKey: config.qwenApiKey,
      baseURL: config.qwenBaseUrl,
      timeout: config.backgroundTimeoutMs,
      maxRetries: 0,
    })
  }

  /** `signal` aborts the job's model calls (the worker's per-job deadline and shutdown). */
  async process(job: BackgroundWorkItem, signal?: AbortSignal): Promise<BackgroundUsage | undefined> {
    if (job.type === 'chat.summary') return this.summarize(job, signal)
    if (job.type === 'user.memory') return this.extractMemory(job, signal)
    return undefined
  }

  private async summarize(
    job: BackgroundWorkItem,
    signal?: AbortSignal,
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
        // A reply the user regenerated is not part of the conversation.
        notSupersededMessage(this.database),
      ))
      .orderBy(desc(messages.seq))
      .limit(2_000)

    const retainedBudget = Math.floor(this.config.chatHistoryTokenBudget * 0.75)
    let retainedTokens = 0
    const candidates: typeof rows = []
    for (const row of rows) {
      // Once one row falls outside the retained window, all older ones do.
      if (candidates.length > 0) {
        candidates.push(row)
        continue
      }
      const cost = messageCostTokens(this.tokenCounter, {
        role: row.role as 'user' | 'assistant',
        content: row.content ?? '',
      })
      if (retainedTokens + cost <= retainedBudget) {
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
    }, signal)
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
      }, signal)
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
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: BackgroundUsage }> {
    const response = await this.qwen.responses.create({
      ...BACKGROUND_REQUEST_EXTRAS,
      model: this.config.backgroundModel,
      ...request,
    }, { signal })
    return { text: completedText(response, label), usage: usageOf(response, kind) }
  }

  private async extractMemory(
    job: BackgroundWorkItem,
    signal?: AbortSignal,
  ): Promise<BackgroundUsage | undefined> {
    if (!this.config.userMemoryEnabled || !job.chatId) return undefined
    const chatId = job.chatId
    const [chat] = await this.database
      .select({
        deletedAt: chats.deletedAt,
        cursor: chats.memoryExtractedSeq,
        memoryEnabled: users.memoryEnabled,
      })
      .from(chats)
      .innerJoin(users, eq(users.id, chats.userId))
      .where(and(eq(chats.id, chatId), eq(chats.userId, job.userId)))
      .limit(1)
    if (!chat || chat.deletedAt) return undefined

    const jobSeq = await this.jobAssistantSeq(job)
    if (jobSeq === null || jobSeq <= chat.cursor) return undefined

    const [latest] = await this.database
      .select({ seq: sql<string | null>`max(${messages.seq})` })
      .from(messages)
      .where(and(
        eq(messages.chatId, chatId),
        eq(messages.userId, job.userId),
        eq(messages.role, 'assistant'),
        eq(messages.status, 'completed'),
      ))
    const latestSeq = latest?.seq ? BigInt(latest.seq) : jobSeq
    const upTo = latestSeq > jobSeq ? latestSeq : jobSeq

    if (!chat.memoryEnabled) {
      // Memory paused: these turns never become memory, even after resuming.
      await this.advanceCursor(this.database, job.userId, chatId, upTo)
      return undefined
    }

    const window = await this.database
      .select({ seq: messages.seq, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(
        eq(messages.chatId, chatId),
        eq(messages.userId, job.userId),
        gt(messages.seq, chat.cursor),
        lte(messages.seq, upTo),
        or(
          eq(messages.role, 'user'),
          and(eq(messages.role, 'assistant'), eq(messages.status, 'completed')),
        ),
        notSupersededMessage(this.database),
      ))
      .orderBy(asc(messages.seq))
      .limit(200)
    const pendingTurns = window.filter((row) => row.role === 'user').length
    // A newer turn's job will read this one too, unless too many are waiting.
    if (latestSeq > jobSeq && pendingTurns < this.config.memoryExtractionMaxPendingTurns) {
      return undefined
    }
    if (pendingTurns === 0) {
      await this.advanceCursor(this.database, job.userId, chatId, upTo)
      return undefined
    }

    await this.tokenCounter.initialize()
    // Keep the most recent turns that fit; older ones in a long burst are
    // already reflected by the rolling summary and later turns.
    const selected: WindowMessage[] = []
    let selectedTokens = 0
    for (const row of [...window].reverse()) {
      // Turns are joined by a blank line; count each turn once.
      const tokens = this.tokenCounter.countText(renderTurns([row], EXTRACTION_CLIP)) + 2
      if (selected.length > 0 && selectedTokens + tokens > EXTRACTION_WINDOW_TOKENS) break
      selected.unshift(row)
      selectedTokens += tokens
    }
    const preceding = await this.database
      .select({ seq: messages.seq, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(
        eq(messages.chatId, chatId),
        eq(messages.userId, job.userId),
        lt(messages.seq, selected[0]!.seq),
        or(
          eq(messages.role, 'user'),
          and(eq(messages.role, 'assistant'), eq(messages.status, 'completed')),
        ),
        notSupersededMessage(this.database),
      ))
      .orderBy(desc(messages.seq))
      .limit(2)

    const snapshot = await listUserMemories(this.database, job.userId, this.config.userMemoryMaxItems * 2)
    const digestKey = episodeKey(chatId)
    const [previousEpisode] = await this.database
      .select({ content: userMemories.content })
      .from(userMemories)
      .where(and(eq(userMemories.userId, job.userId), eq(userMemories.key, digestKey)))
      .limit(1)
    const extracted = await this.complete('Memory', 'memory', {
      instructions: extractionInstructions(),
      input: [
        `今天：${today()}`,
        `现有记忆：${JSON.stringify(snapshot.map(({ key, category, content, source, lastSeenAt }) => ({
          key,
          category,
          content,
          source,
          lastSeenAt: lastSeenAt.toISOString().slice(0, 10),
        })))}`,
        `本会话已有概要：${previousEpisode?.content ?? '无'}`,
        preceding.length > 0
          ? `上文（仅用于理解指代）：\n${renderTurns(preceding.reverse(), { user: 600, assistant: 600 })}`
          : '',
        `新对话：\n${renderTurns(selected, EXTRACTION_CLIP)}`,
      ].filter(Boolean).join('\n\n'),
      max_output_tokens: Math.min(2_048, this.config.backgroundMaxOutputTokens),
    }, signal)
    const { operations, episode } = parseExtraction(extracted.text)
    const changes = operations.filter(
      (operation): operation is Exclude<MemoryOperation, { action: 'touch' }> => operation.action !== 'touch',
    )
    const touched = operations.flatMap((operation) => operation.action === 'touch' ? [operation.key] : [])

    await this.database.transaction(async (transaction) => {
      await lockUserMemories(transaction, job.userId)
      if (changes.length > 0) {
        const current = await listUserMemories(transaction, job.userId, this.config.userMemoryMaxItems * 2)
        // Another chat or the user changed the set since the prompt was
        // built; retry so the model sees it instead of adding near-duplicates.
        if (memoryFingerprint(current) !== memoryFingerprint(snapshot)) {
          throw new MemorySetChangedError()
        }
        const byKey = new Map(current.map((row) => [row.key, row]))
        for (const operation of changes) {
          if (operation.action === 'delete') {
            await transaction
              .delete(userMemories)
              .where(and(eq(userMemories.userId, job.userId), eq(userMemories.key, operation.key)))
            continue
          }
          await upsertUserMemory(transaction, {
            userId: job.userId,
            key: operation.key,
            category: operation.category,
            content: operation.content,
            // A correction of a user-written entry stays the user's.
            source: byKey.get(operation.key)?.source === 'user' ? 'user' : 'auto',
            sourceChatId: chatId,
          })
        }
      }
      // Touching only extends a memory's life, so it needs no snapshot check.
      await touchUserMemories(transaction, { userId: job.userId, keys: touched, chatId })
      if (episode) {
        await upsertUserMemory(transaction, {
          userId: job.userId,
          key: digestKey,
          category: 'episode',
          content: episode,
          source: 'auto',
          sourceChatId: chatId,
        })
      }
      await promoteRecurringMemories(transaction, job.userId)
      await this.advanceCursor(transaction, job.userId, chatId, upTo)
    })

    const consolidated = await this.consolidateMemories(job.userId, signal)
    return consolidated
      ? addBackgroundUsage(extracted.usage, consolidated)
      : extracted.usage
  }

  private async jobAssistantSeq(job: BackgroundWorkItem): Promise<bigint | null> {
    if (typeof job.payload.assistantSeq === 'number' && Number.isSafeInteger(job.payload.assistantSeq)) {
      return BigInt(job.payload.assistantSeq)
    }
    // Jobs queued before assistantSeq was added name the message instead.
    const messageId = typeof job.payload.assistantMessageId === 'string'
      ? job.payload.assistantMessageId
      : ''
    if (!messageId) return null
    const [row] = await this.database
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.userId, job.userId), eq(messages.id, messageId)))
      .limit(1)
    return row?.seq ?? null
  }

  private async advanceCursor(
    executor: Database | DatabaseTransaction,
    userId: string,
    chatId: string,
    seq: bigint,
  ): Promise<void> {
    await executor
      .update(chats)
      .set({ memoryExtractedSeq: sql`greatest(${chats.memoryExtractedSeq}, ${seq})` })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
  }

  /**
   * Keeps a user's memory set concise. Runs when the set exceeds
   * USER_MEMORY_MAX_ITEMS or USER_MEMORY_TOKEN_BUDGET, and otherwise at most
   * once per MEMORY_CONSOLIDATION_INTERVAL_HOURS after the set changed, so
   * duplicates and contradictions below the limits are cleaned up too.
   * Entries the user wrote are never rewritten. Best effort: a failed attempt
   * leaves the set unchanged, while injection still enforces the budget.
   */
  private async consolidateMemories(
    userId: string,
    signal?: AbortSignal,
  ): Promise<BackgroundUsage | undefined> {
    const maxItems = this.config.userMemoryMaxItems
    const budgetTokens = this.config.userMemoryTokenBudget
    const snapshot = await listUserMemories(this.database, userId, maxItems * 2)
    const overLimit = snapshot.length > maxItems ||
      countUserMemoryTokens(this.tokenCounter, snapshot) > budgetTokens
    if (!overLimit) {
      if (snapshot.length < ROUTINE_CONSOLIDATION_MIN_ITEMS) return undefined
      const [user] = await this.database
        .select({ consolidatedAt: users.memoryConsolidatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      const consolidatedAt = user?.consolidatedAt?.getTime() ?? 0
      const due = Date.now() - consolidatedAt >= this.config.memoryConsolidationIntervalHours * 3_600_000
      const changed = snapshot.some((row) => row.updatedAt.getTime() > consolidatedAt)
      if (!due || !changed) return undefined
    }

    const pinned = snapshot.filter((row) => row.source === 'user')
    const editable = snapshot.filter((row) => row.source !== 'user')
    if (editable.length === 0) return undefined
    const pinnedTokens = countUserMemoryTokens(this.tokenCounter, pinned)
    const targetItems = Math.max(1, Math.floor(maxItems * MEMORY_CONSOLIDATION_RATIO) - pinned.length)
    const targetTokens = Math.max(
      128,
      Math.floor(budgetTokens * MEMORY_CONSOLIDATION_RATIO) - pinnedTokens,
    )
    const markConsolidated = () => this.database
      .update(users)
      .set({ memoryConsolidatedAt: sql`now()` })
      .where(eq(users.id, userId))
    let result: { text: string; usage: BackgroundUsage }
    try {
      result = await this.complete('Memory consolidation', 'memory', {
        instructions: consolidationInstructions({ targetItems, targetTokens, today: today() }),
        input: [
          `用户填写的条目（不可修改，仅供去重参考）：${JSON.stringify(pinned.map(({ key, category, content }) => ({ key, category, content })))}`,
          `待整理的条目：${JSON.stringify(editable.map((row) => ({
            key: row.key,
            category: row.category,
            content: row.content,
            lastSeenAt: row.lastSeenAt.toISOString().slice(0, 10),
          })))}`,
        ].join('\n\n'),
        max_output_tokens: this.config.backgroundMaxOutputTokens,
      }, signal)
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
        editable.map((row) => row.key),
        targetItems,
        pinned.map((row) => row.key),
      )
      const merged = [
        ...pinned,
        ...memories.map((memory) => ({ ...memory, source: 'auto' as const, updatedAt: new Date(), lastSeenAt: new Date() })),
      ]
      if (countUserMemoryTokens(this.tokenCounter, merged) > budgetTokens) {
        throw new Error('Consolidated memories exceed USER_MEMORY_TOKEN_BUDGET')
      }
      await this.database.transaction(async (transaction) => {
        await lockUserMemories(transaction, userId)
        const current = await listUserMemories(transaction, userId, maxItems * 2)
        // Another job changed the set meanwhile; a later run retries.
        if (memoryFingerprint(current) !== memoryFingerprint(snapshot)) return
        await transaction
          .delete(userMemories)
          .where(and(
            eq(userMemories.userId, userId),
            inArray(userMemories.key, editable.map((row) => row.key)),
          ))
        for (const memory of memories) {
          // Snapshot rows are newest first, so this is the most recent source.
          // Deleting that chat removes the merged memory.
          const source = editable.find((row) => memory.sources.includes(row.key))
          // A merged memory keeps its sources' history: first seen, last
          // seen and how many chats confirmed it, so aging and promotion
          // carry over.
          const sources = editable.filter((row) => memory.sources.includes(row.key))
          const lastSeenAt = sources.length
            ? new Date(Math.max(...sources.map((row) => row.lastSeenAt.getTime())))
            : new Date()
          await transaction.insert(userMemories).values({
            userId,
            key: memory.key,
            category: memory.category,
            content: memory.content,
            source: source?.source ?? 'auto',
            sourceChatId: source?.sourceChatId ?? null,
            lastSeenAt,
            reinforcedCount: Math.max(1, ...sources.map((row) => row.reinforcedCount)),
            expiresAt: memoryExpiresAt(memory.category, lastSeenAt),
            createdAt: sources.length
              ? new Date(Math.min(...sources.map((row) => row.createdAt.getTime())))
              : new Date(),
            updatedAt: source?.updatedAt ?? new Date(),
          })
        }
        await transaction
          .update(users)
          .set({ memoryConsolidatedAt: sql`now()` })
          .where(eq(users.id, userId))
      })
    } catch (error) {
      // Do not retry a rejected routine run on every extraction.
      if (!overLimit) await markConsolidated().catch(() => undefined)
      console.warn('User memory consolidation rejected', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return result.usage
  }
}
