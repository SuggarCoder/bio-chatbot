import path from 'node:path'

import { pipeline } from '@huggingface/transformers'

import type { AppConfig } from './config.js'

type FeatureExtractor = (
  text: string,
  options: Record<string, unknown>,
) => Promise<unknown>

export class LocalEmbeddingService {
  private extractor?: FeatureExtractor
  private initializing?: Promise<void>

  constructor(private readonly config: AppConfig) {}

  initialize(): Promise<void> {
    if (this.extractor) return Promise.resolve()
    this.initializing ??= pipeline(
      'feature-extraction',
      path.resolve(this.config.embeddingModelPath),
      {
        dtype: 'int8',
        device: 'cpu',
        local_files_only: true,
      },
    ).then((extractor) => {
      this.extractor = extractor as unknown as FeatureExtractor
    }).catch((error: unknown) => {
      this.initializing = undefined
      throw error
    })
    return this.initializing
  }

  async embed(text: string, pooling: 'mean' | 'cls' = 'mean'): Promise<number[]> {
    await this.initialize()
    const output = await this.extractor!(text, {
      pooling,
      normalize: true,
      truncation: true,
      max_length: 512,
    }) as unknown as {
      data?: ArrayLike<number>
      tolist?: () => unknown
    }
    if (output.data && output.data.length === 512) {
      return Array.from(output.data)
    }
    const listed = output.tolist?.()
    const vector = Array.isArray(listed) && Array.isArray(listed[0])
      ? listed[0]
      : listed
    if (!Array.isArray(vector) || vector.length !== 512) {
      throw new Error('Embedding model did not return a 512-dimensional vector')
    }
    return vector.map(Number)
  }
}
