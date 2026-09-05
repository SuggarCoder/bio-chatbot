import type { AppConfig } from '../config.js'
import { LocalEmbeddingService } from '../embedding.js'
import { GpasService } from '../gpas.js'
import { SemanticIntentRouter } from '../gpasIntent.js'
import { createGpasCapabilities } from './gpas.js'
import { QwenSemanticPlanner, type SemanticPlanner } from './planner.js'

// One composition root keeps the catalog used for retrieval identical to the
// catalog used for execution. Register additional domain modules here.
export function createCapabilityRuntime(config: AppConfig, embedding = new LocalEmbeddingService(config)) {
  const gpas = new GpasService(config)
  const registry = createGpasCapabilities(gpas)
  return {
    gpas,
    registry,
    router: new SemanticIntentRouter(embedding, registry.descriptions()),
    planner: new QwenSemanticPlanner(config) as SemanticPlanner,
  }
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>
