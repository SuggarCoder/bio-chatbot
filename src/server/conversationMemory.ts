import {
  and,
  desc,
  eq,
  gt,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Database, ChatContext } from './db.js'
import {
  chats,
  chatSummaries,
  generations,
  messages,
  userMemories,
} from './db/schema.js'
import type { TokenCounter } from './tokenBudget.js'

const SUMMARY_PREFIX = '以下是本会话早期内容的摘要'

export type BudgetedContextResult = ChatContext & {
  summaryVersion: number | null
  summaryCoveredMaxSeq: number | null
  rawMinSeq: number | null
  rawMaxSeq: number | null
  rawTokens: number
  summaryTokens: number
  omittedUnsummarized: boolean
}

function safeNumber(value: bigint): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Message sequence exceeds safe integer range')
  return number
}

export async function buildBudgetedChatContext(
  database: Database,
  input: {
    userId: string
    chatId: string
    contextMaxSeq: number
    summaryVersion?: number
    historyTokenBudget: number
    summaryTokenBudget: number
    tokenCounter: TokenCounter
  },
): Promise<BudgetedContextResult | null> {
  const [chat] = await database
    .select({ revision: chats.contextRevision })
    .from(chats)
    .where(and(
      eq(chats.id, input.chatId),
      eq(chats.userId, input.userId),
    ))
    .limit(1)
  if (!chat) return null

  const [summary] = input.summaryVersion
    ? await database
        .select({
          version: chatSummaries.version,
          coveredMaxSeq: chatSummaries.coveredMaxSeq,
          summary: chatSummaries.summary,
        })
        .from(chatSummaries)
        .where(and(
          eq(chatSummaries.userId, input.userId),
          eq(chatSummaries.chatId, input.chatId),
          eq(chatSummaries.version, input.summaryVersion),
          lt(chatSummaries.coveredMaxSeq, BigInt(input.contextMaxSeq)),
        ))
        .limit(1)
    : []
  const summaryContent = summary
    ? `${SUMMARY_PREFIX}（覆盖至 seq ${summary.coveredMaxSeq}）：\n${summary.summary}`
    : null
  const summaryTokens = summaryContent
    ? input.tokenCounter.countMessages([{ role: 'user', content: summaryContent }])
    : 0
  const usableSummary = summaryContent && summaryTokens <= input.summaryTokenBudget
    ? summaryContent
    : null
  const coveredMaxSeq = usableSummary && summary
    ? safeNumber(summary.coveredMaxSeq)
    : 0

  const original = alias(generations, 'context_original')
  const replacement = alias(generations, 'context_replacement')
  const selected: Array<{
    seq: number
    role: 'user' | 'assistant'
    content: string
  }> = []
  let cursor = BigInt(input.contextMaxSeq + 1)
  let exhausted = false
  let omittedUnsummarized = false

  while (!exhausted) {
    const rows = await database
      .select({
        seq: messages.seq,
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(and(
        eq(messages.chatId, input.chatId),
        eq(messages.userId, input.userId),
        lte(messages.seq, BigInt(input.contextMaxSeq)),
        lt(messages.seq, cursor),
        coveredMaxSeq > 0
          ? gt(messages.seq, BigInt(coveredMaxSeq))
          : undefined,
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
            .where(and(
              eq(original.assistantMessageId, messages.id),
              eq(replacement.status, 'completed'),
            )),
        ),
      ))
      .orderBy(desc(messages.seq))
      .limit(100)

    if (rows.length === 0) break
    for (const row of rows) {
      const candidate = {
        seq: safeNumber(row.seq),
        role: row.role as 'user' | 'assistant',
        content: row.content ?? '',
      }
      const next = [candidate, ...selected]
      const nextTokens = input.tokenCounter.countMessages(next.map(({ role, content }) => ({
        role,
        content,
      })))
      if (selected.length > 0 && nextTokens > input.historyTokenBudget) {
        omittedUnsummarized = candidate.seq > coveredMaxSeq
        exhausted = true
        break
      }
      selected.unshift(candidate)
    }
    cursor = rows.at(-1)!.seq
    if (rows.length < 100) break
  }

  const rawMessages = selected.map(({ role, content }) => ({ role, content }))
  const rawTokens = rawMessages.length > 0
    ? input.tokenCounter.countMessages(rawMessages)
    : 0
  const contextMessages = usableSummary
    ? [{ role: 'user' as const, content: usableSummary }, ...rawMessages]
    : rawMessages

  return {
    chatId: input.chatId,
    revision: safeNumber(chat.revision),
    lastSeq: selected.at(-1)?.seq ?? coveredMaxSeq,
    messages: contextMessages,
    summaryVersion: usableSummary ? summary?.version ?? null : null,
    summaryCoveredMaxSeq: usableSummary ? coveredMaxSeq : null,
    rawMinSeq: selected[0]?.seq ?? null,
    rawMaxSeq: selected.at(-1)?.seq ?? null,
    rawTokens,
    summaryTokens: usableSummary ? summaryTokens : 0,
    omittedUnsummarized,
  }
}

export async function buildUserMemoryInstructions(
  database: Database,
  userId: string,
  maxBytes = 2 * 1024,
): Promise<string> {
  const rows = await database
    .select({
      key: userMemories.key,
      content: userMemories.content,
    })
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.updatedAt), userMemories.key)
    .limit(200)

  const lines = ['跨会话用户记忆（仅在相关时使用，不要向用户披露内部存储格式）：']
  let bytes = Buffer.byteLength(`${lines[0]}\n`, 'utf8')
  for (const row of rows) {
    const line = `- ${row.key}: ${row.content}`
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + lineBytes > maxBytes) continue
    lines.push(line)
    bytes += lineBytes
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
