import OpenAI from 'openai'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  sql,
} from 'drizzle-orm'

import type { BackgroundWorkItem } from './backgroundJobs.js'
import type { AppConfig } from './config.js'
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
  ) {
    this.qwen = new OpenAI({
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
    const response = await this.qwen.responses.create({
      model: this.config.backgroundModel,
      instructions: [
        '你负责更新会话滚动摘要。只输出结构化 Markdown，不要解释。',
        '必须保留并合并以下五个二级标题：用户目标、已做决定、关键实体与数字、Artifact 演进、待办事项。',
        '不要虚构；已失效的决定或 Artifact 状态要明确标注演进关系。',
      ].join('\n'),
      input: [
        previous?.summary
          ? `旧摘要：\n${previous.summary}`
          : '旧摘要：无',
        `新增消息：\n${transcript}`,
      ].join('\n\n'),
      max_output_tokens: this.config.backgroundMaxOutputTokens,
    })
    const summary = responseText(response)
    if (!summary) throw new Error('Summary model returned empty output')

    const coveredMaxSeq = batch.at(-1)!.seq
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
      await transaction
        .insert(chatSummaries)
        .values({
          userId: job.userId,
          chatId: job.chatId!,
          version: (previous?.version ?? 0) + 1,
          coveredMaxSeq,
          summary,
        })
        .onConflictDoNothing()
    })
    return usageOf(response, 'summary')
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

    const existing = await this.database
      .select({ key: userMemories.key, content: userMemories.content })
      .from(userMemories)
      .where(eq(userMemories.userId, job.userId))
      .orderBy(desc(userMemories.updatedAt))
      .limit(50)
    const response = await this.qwen.responses.create({
      model: this.config.backgroundModel,
      instructions: [
        '判断本轮是否包含值得跨会话保存的稳定事实：身份、长期偏好、长期项目。',
        '临时请求、一次性数据、模型推断、敏感凭据不得保存。用户明确要求忘记时输出 delete。',
        '只输出 JSON：{"operations":[{"action":"upsert|delete","key":"snake_case","content":"不超过200字"}]}。无操作则 operations 为空数组。',
      ].join('\n'),
      input: [
        `现有记忆：${JSON.stringify(existing)}`,
        `本轮：${JSON.stringify(turn)}`,
      ].join('\n\n'),
      max_output_tokens: Math.min(1_024, this.config.backgroundMaxOutputTokens),
    })
    const parsed = parseJsonObject(responseText(response))
    const operations = Array.isArray(parsed.operations)
      ? parsed.operations.slice(0, 8)
      : []

    await this.database.transaction(async (transaction) => {
      for (const value of operations) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const operation = value as Record<string, unknown>
        const action = operation.action
        const key = typeof operation.key === 'string'
          ? operation.key.trim().toLowerCase()
          : ''
        if (!/^[a-z][a-z0-9_]{0,95}$/.test(key)) continue
        if (action === 'delete') {
          await transaction
            .delete(userMemories)
            .where(and(
              eq(userMemories.userId, job.userId),
              eq(userMemories.key, key),
            ))
          continue
        }
        const content = typeof operation.content === 'string'
          ? operation.content.trim()
          : ''
        if (action !== 'upsert' || !content || content.length > 200) continue
        await transaction
          .insert(userMemories)
          .values({
            userId: job.userId,
            key,
            content,
            sourceChatId: job.chatId!,
          })
          .onConflictDoUpdate({
            target: [userMemories.userId, userMemories.key],
            set: {
              content,
              sourceChatId: job.chatId!,
              updatedAt: new Date(),
            },
          })
      }
    })
    return usageOf(response, 'memory')
  }
}
