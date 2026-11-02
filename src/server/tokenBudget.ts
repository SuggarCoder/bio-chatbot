import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  AutoTokenizer,
  type PreTrainedTokenizer,
} from '@huggingface/transformers'

import type { AppConfig } from './config.js'

export type BudgetMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface TokenCounter {
  readonly policyFingerprint: string
  initialize(): Promise<void>
  countText(text: string): number
  countMessages(messages: BudgetMessage[], instructions?: string): number
}

function tokenArrayLength(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    const candidate = value as {
      input_ids?: { size?: number; data?: ArrayLike<unknown> } | unknown[]
    }
    if (Array.isArray(candidate.input_ids)) return candidate.input_ids.length
    if (typeof candidate.input_ids?.size === 'number') {
      return candidate.input_ids.size
    }
    if (candidate.input_ids?.data) return candidate.input_ids.data.length
  }
  throw new Error('Tokenizer returned an unsupported token representation')
}

export class QwenTokenCounter implements TokenCounter {
  readonly policyFingerprint: string
  private tokenizer?: PreTrainedTokenizer
  private initializing?: Promise<void>

  constructor(private readonly config: AppConfig) {
    this.policyFingerprint = createHash('sha256')
      .update(JSON.stringify({
        tokenizerPath: path.resolve(config.qwenTokenizerPath),
        history: config.chatHistoryTokenBudget,
        summary: config.chatSummaryTokenBudget,
        instructions: config.instructionsTokenBudget,
        protocol: config.artifactProtocolTokenBudget,
        outline: config.artifactOutlineTokenBudget,
        fragment: config.artifactFragmentTokenBudget,
      }))
      .digest('hex')
      .slice(0, 16)
  }

  initialize(): Promise<void> {
    if (this.tokenizer) return Promise.resolve()
    this.initializing ??= AutoTokenizer.from_pretrained(
      path.resolve(this.config.qwenTokenizerPath),
      { local_files_only: true },
    ).then((tokenizer) => {
      if (!tokenizer.chat_template) {
        throw new Error('Qwen tokenizer does not include a chat template')
      }
      this.tokenizer = tokenizer
    })
    return this.initializing
  }

  private requireTokenizer(): PreTrainedTokenizer {
    if (!this.tokenizer) {
      throw new Error('Qwen tokenizer has not been initialized')
    }
    return this.tokenizer
  }

  countText(text: string): number {
    const encoded = this.requireTokenizer()(text, {
      add_special_tokens: false,
      return_tensor: false,
    })
    return tokenArrayLength(encoded)
  }

  countMessages(messages: BudgetMessage[], instructions?: string): number {
    const conversation: BudgetMessage[] = instructions
      ? [{ role: 'system', content: instructions }, ...messages]
      : messages
    const encoded = this.requireTokenizer().apply_chat_template(conversation, {
      add_generation_prompt: true,
      tokenize: true,
      return_tensor: false,
      return_dict: false,
    })
    return tokenArrayLength(encoded)
  }
}

export class CharacterTokenCounter implements TokenCounter {
  readonly policyFingerprint = 'test-character-counter'

  initialize(): Promise<void> {
    return Promise.resolve()
  }

  countText(text: string): number {
    return [...text].length
  }

  countMessages(messages: BudgetMessage[], instructions?: string): number {
    return (instructions ? this.countText(instructions) + 4 : 0) +
      messages.reduce((total, message) => total + this.countText(message.content) + 4, 3)
  }
}

// ---------------------------------------------------------------------------
// Incremental counting
//
// Tokenizing is synchronous and costs about 1 ms per 2 KB, so re-counting a
// growing conversation on every step is quadratic (a 500-message chat took
// 80 s of CPU). With chat templates that frame each message with special
// tokens, a conversation costs the template's fixed framing plus the sum of
// its messages, so each message is counted once (and cached) and selections
// are made on sums. The sum can be off by a few tokens (e.g. a template that
// adds a reasoning block after a final assistant turn), so every caller
// still makes one exact count of what it finally sends and trims if needed.
// ---------------------------------------------------------------------------

const MESSAGE_COST_CACHE_LIMIT = 20_000
const costCaches = new WeakMap<TokenCounter, { framing?: number; probe?: number; costs: Map<string, number> }>()
/** Follows the measured message, so it is priced as a turn mid-conversation. */
const PROBE: BudgetMessage = { role: 'user', content: 'a' }

function costCache(counter: TokenCounter) {
  let cache = costCaches.get(counter)
  if (!cache) {
    cache = { costs: new Map() }
    costCaches.set(counter, cache)
  }
  return cache
}

/** Tokens the chat template adds around a conversation, independent of its messages. */
export function conversationFramingTokens(counter: TokenCounter): number {
  const cache = costCache(counter)
  if (cache.framing === undefined) {
    const first: BudgetMessage = { role: 'user', content: 'a' }
    const second: BudgetMessage = { role: 'user', content: 'b' }
    cache.framing = Math.max(0,
      counter.countMessages([first]) + counter.countMessages([second]) -
      counter.countMessages([first, second]))
  }
  return cache.framing
}

/**
 * Tokens one message adds to a conversation, counted once per distinct
 * message. It is measured followed by a short user turn, so template extras
 * that only apply to a final assistant turn are left to the exact count.
 */
export function messageCostTokens(counter: TokenCounter, message: BudgetMessage): number {
  const cache = costCache(counter)
  cache.probe ??= counter.countMessages([PROBE])
  const key = `${message.role}\u0000${createHash('sha1').update(message.content).digest('base64')}`
  const cached = cache.costs.get(key)
  if (cached !== undefined) {
    // Refresh recency for the simple LRU below.
    cache.costs.delete(key)
    cache.costs.set(key, cached)
    return cached
  }
  const cost = Math.max(0, counter.countMessages([message, PROBE]) - cache.probe)
  cache.costs.set(key, cost)
  if (cache.costs.size > MESSAGE_COST_CACHE_LIMIT) {
    cache.costs.delete(cache.costs.keys().next().value!)
  }
  return cost
}

/** Estimated tokens of a conversation: framing plus the sum of its messages. */
export function estimateConversationTokens(
  counter: TokenCounter,
  messages: BudgetMessage[],
  instructions?: string,
): number {
  let total = conversationFramingTokens(counter)
  if (instructions) total += messageCostTokens(counter, { role: 'system', content: instructions })
  for (const message of messages) total += messageCostTokens(counter, message)
  return total
}

/** Keep the newest user turn; evict oldest turns before invoking the provider. */
export async function fitInputBudget<T extends BudgetMessage>(
  counter: TokenCounter,
  messages: T[],
  instructions: string,
  config: Pick<AppConfig, 'qwenMaxInputTokens' | 'qwenContextWindowTokens' | 'qwenMaxOutputTokens' |
    'chatHistoryTokenBudget' | 'chatSummaryTokenBudget' | 'instructionsTokenBudget'>,
): Promise<T[]> {
  await counter.initialize()
  const instructionTokens = counter.countText(instructions)
  if (instructionTokens > config.instructionsTokenBudget) {
    throw new Error('ASSEMBLED_INSTRUCTIONS_TOKEN_BUDGET_EXCEEDED')
  }
  const budget = Math.min(config.qwenMaxInputTokens,
    config.qwenContextWindowTokens - config.qwenMaxOutputTokens,
    config.chatHistoryTokenBudget + config.chatSummaryTokenBudget + instructionTokens)
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
  if (!starts.length) throw new Error('CONTEXT_REQUIRES_USER_MESSAGE')

  // Estimated cost of messages[index..] for every index, from the end.
  const fixed = conversationFramingTokens(counter) +
    (instructions ? messageCostTokens(counter, { role: 'system', content: instructions }) : 0)
  const suffix = new Array<number>(messages.length + 1).fill(0)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1]! + messageCostTokens(counter, messages[index]!)
  }
  // The earliest turn start whose estimate fits, then exact counts from there.
  // Final exact check is mandatory, including when instructions is empty.
  const fitsExactly = (position: number) =>
    counter.countMessages(messages.slice(starts[position]), instructions) <= budget
  let position = starts.findIndex((start) => fixed + suffix[start]! <= budget)
  if (position < 0) position = starts.length - 1
  while (position < starts.length && !fitsExactly(position)) position += 1
  if (position >= starts.length) throw new Error('LATEST_MESSAGE_TOKEN_BUDGET_EXCEEDED')
  // If the estimate was pessimistic, an earlier turn may fit too.
  while (position > 0 && fitsExactly(position - 1)) position -= 1
  return messages.slice(starts[position])
}
