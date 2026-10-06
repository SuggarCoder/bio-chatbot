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

/** Keep the newest user turn; evict oldest turns before invoking the provider. */
export async function fitInputBudget<T extends BudgetMessage>(
  counter: TokenCounter,
  messages: T[],
  instructions: string,
  config: Pick<AppConfig, 'qwenMaxInputTokens' | 'qwenContextWindowTokens' | 'qwenMaxOutputTokens' |
    'chatHistoryTokenBudget' | 'chatSummaryTokenBudget' | 'instructionsTokenBudget'>,
): Promise<T[]> {
  await counter.initialize()
  if (counter.countText(instructions) > config.instructionsTokenBudget) {
    throw new Error('ASSEMBLED_INSTRUCTIONS_TOKEN_BUDGET_EXCEEDED')
  }
  const budget = Math.min(config.qwenMaxInputTokens,
    config.qwenContextWindowTokens - config.qwenMaxOutputTokens,
    config.chatHistoryTokenBudget + config.chatSummaryTokenBudget + counter.countText(instructions))
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
  if (!starts.length) throw new Error('CONTEXT_REQUIRES_USER_MESSAGE')
  let low = 0
  let high = starts.length - 1
  const fits = (index: number) => counter.countMessages(messages.slice(starts[index]), instructions) <= budget
  if (!fits(high)) throw new Error('LATEST_MESSAGE_TOKEN_BUDGET_EXCEEDED')
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (fits(mid)) high = mid
    else low = mid + 1
  }
  const selected = messages.slice(starts[low])
  // Final exact check is mandatory, including when instructions is empty.
  if (counter.countMessages(selected, instructions) > budget) throw new Error('ASSEMBLED_CONTEXT_TOKEN_BUDGET_EXCEEDED')
  return selected
}
