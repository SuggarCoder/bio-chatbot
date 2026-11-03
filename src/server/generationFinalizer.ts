import {
  applyMonthlyQuota,
  notifyGenerationStateChanged,
  type RedisClient,
} from './cache.js'
import type { AppConfig } from './config.js'
import { metrics } from './metrics.js'
import {
  finalizeGeneration,
  type Database,
  type FinalizeGenerationInput,
  type FinalizedGeneration,
} from './db.js'
import type { GenerationRuntime, GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'

export class GenerationFinalizer {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly redis: RedisClient,
    private readonly runtimes: GenerationRuntimeRegistry,
  ) {}

  async finalize(
    input: FinalizeGenerationInput,
    runtime?: GenerationRuntime,
  ): Promise<FinalizedGeneration> {
    const result = await finalizeGeneration(this.database, {
      ...input,
      enqueueSummaryJob: this.config.contextMemoryEnabled,
      enqueueUserMemoryJob: this.config.userMemoryEnabled,
      userMemoryJobDelaySeconds: this.config.memoryExtractionDelaySeconds,
      enqueueChatIndexJob: this.config.chatSearchEnabled,
    })
    if (result.newlyFinalized) {
      metrics.generationsFinished.inc({
        status: result.generation.status,
        error_code: result.generation.errorCode ?? 'none',
      })
    }
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

    this.runtimes.delete(input.generationId, runtime)
    return result
  }
}
