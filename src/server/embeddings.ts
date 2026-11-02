import OpenAI from 'openai'

import type { AppConfig } from './config.js'
import { EMBEDDING_DIMENSIONS } from './db/schema.js'

export type EmbeddingResult = {
  vectors: number[][]
  /** Billed input tokens, when the provider reports them. */
  tokens: number
}

export interface Embedder {
  /** Identifies the vector space; vectors from another model are not comparable. */
  readonly model: string
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>
}

// DashScope accepts at most 10 inputs per embeddings request.
const EMBEDDING_BATCH_SIZE = 10
// Well under the model's 8k-token input limit, measured in characters.
export const EMBEDDING_INPUT_MAX_CHARS = 6_000

export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string
  private readonly client: OpenAI

  constructor(config: Pick<AppConfig, 'embeddingBaseUrl' | 'embeddingApiKey' | 'embeddingModel' | 'embeddingTimeoutMs'>) {
    this.model = config.embeddingModel
    // Not routed through the shared chat budget: embeddings have their own
    // provider quota and would otherwise reserve a full output allowance.
    this.client = new OpenAI({
      apiKey: config.embeddingApiKey,
      baseURL: config.embeddingBaseUrl,
      timeout: config.embeddingTimeoutMs,
      maxRetries: 1,
    })
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    const vectors: number[][] = []
    let tokens = 0
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts
        .slice(start, start + EMBEDDING_BATCH_SIZE)
        .map((text) => text.slice(0, EMBEDDING_INPUT_MAX_CHARS))
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      }, { signal })
      const ordered = [...response.data].sort((left, right) => left.index - right.index)
      if (ordered.length !== batch.length) {
        throw new Error(`Embedding response has ${ordered.length} vectors for ${batch.length} inputs`)
      }
      for (const item of ordered) vectors.push(validVector(item.embedding))
      tokens += response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0
    }
    return { vectors, tokens }
  }
}

function validVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== EMBEDDING_DIMENSIONS ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error(`Embedding model must return ${EMBEDDING_DIMENSIONS} finite numbers`)
  }
  return value as number[]
}

export function createEmbedder(config: AppConfig): Embedder | null {
  return config.chatSearchEnabled ? new OpenAICompatibleEmbedder(config) : null
}
