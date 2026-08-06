import {
  applyMonthlyQuota,
  notifyGenerationStateChanged,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import {
  finalizeGeneration,
  type Database,
  type FinalizeGenerationInput,
  type FinalizedGeneration,
} from './db.js'
import type { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'

export class GenerationFinalizer {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly redis: RedisClient,
    private readonly runtimes: GenerationRuntimeRegistry,
  ) {}

  async finalize(
    input: FinalizeGenerationInput,
  ): Promise<FinalizedGeneration> {
    const result = await finalizeGeneration(this.database, input)
    const generation = result.generation

    if (result.newlyFinalized) {
      await Promise.allSettled([
        applyMonthlyQuota(
          this.redis,
          this.config,
          input.userId,
          input.generationId,
          input.usage.inputTokens + input.usage.outputTokens,
        ),
        notifyGenerationStateChanged(
          this.redis,
          this.config,
          input.userId,
          input.generationId,
          generation.status,
        ),
      ])
    }

    this.runtimes.delete(input.generationId)
    return result
  }
}
