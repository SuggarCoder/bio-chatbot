import {
  and,
  desc,
  eq,
  gt,
  lt,
  lte,
  or,
} from 'drizzle-orm'

import type { Database, ChatContext } from './db.js'
import {
  chats,
  chatSummaries,
  messages,
} from './db/schema.js'
import {
  conversationFramingTokens,
  messageCostTokens,
  type TokenCounter,
} from './tokenBudget.js'
import { notSupersededMessage } from './userMemory.js'

/**
 * The exact message the context builder injects for a stored summary. It is
 * sent in the user turn position, so it says plainly that the user did not
 * write it.
 */
export function renderSummaryContext(
  coveredMaxSeq: bigint | number,
  summary: string,
): string {
  return [
    `<conversation_summary covered_through_seq="${coveredMaxSeq}">`,
    '【系统消息，不是用户发言】以下是本会话更早内容的自动摘要，后面紧接的是摘要之后的原始对话。用它理解上文，不要回复或复述这段摘要。',
    summary,
    '</conversation_summary>',
  ].join('\n')
}

/** Tokens a stored summary costs against CHAT_SUMMARY_TOKEN_BUDGET. */
export function countSummaryContextTokens(
  tokenCounter: TokenCounter,
  coveredMaxSeq: bigint | number,
  summary: string,
): number {
  return tokenCounter.countMessages([{
    role: 'user',
    content: renderSummaryContext(coveredMaxSeq, summary),
  }])
}

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
    ? renderSummaryContext(summary.coveredMaxSeq, summary.summary)
    : null
  const summaryTokens = summary
    ? countSummaryContextTokens(input.tokenCounter, summary.coveredMaxSeq, summary.summary)
    : 0
  const usableSummary = summaryContent && summaryTokens <= input.summaryTokenBudget
    ? summaryContent
    : null
  const coveredMaxSeq = usableSummary && summary
    ? safeNumber(summary.coveredMaxSeq)
    : 0

  const selected: Array<{
    seq: number
    role: 'user' | 'assistant'
    content: string
  }> = []
  let cursor = BigInt(input.contextMaxSeq + 1)
  let exhausted = false
  let omittedUnsummarized = false
  // Each message is counted once; the running sum selects, one exact count
  // below confirms.
  let estimatedTokens = conversationFramingTokens(input.tokenCounter)

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
        notSupersededMessage(database),
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
      const nextTokens = estimatedTokens + messageCostTokens(input.tokenCounter, candidate)
      if (selected.length > 0 && nextTokens > input.historyTokenBudget) {
        omittedUnsummarized = candidate.seq > coveredMaxSeq
        exhausted = true
        break
      }
      estimatedTokens = nextTokens
      selected.unshift(candidate)
    }
    cursor = rows.at(-1)!.seq
    if (rows.length < 100) break
  }

  let rawMessages = selected.map(({ role, content }) => ({ role, content }))
  let rawTokens = rawMessages.length > 0
    ? input.tokenCounter.countMessages(rawMessages)
    : 0
  // The estimate can be a few tokens short; drop the oldest turns until the
  // exact count fits, as the old per-step exact count would have.
  while (rawMessages.length > 1 && rawTokens > input.historyTokenBudget) {
    const dropped = selected.shift()!
    if (dropped.seq > coveredMaxSeq) omittedUnsummarized = true
    rawMessages = rawMessages.slice(1)
    rawTokens = input.tokenCounter.countMessages(rawMessages)
  }
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
