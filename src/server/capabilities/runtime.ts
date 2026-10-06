import type { AppConfig } from '../config.js'
import { LocalEmbeddingService } from '../embedding.js'
import { GpasService } from '../gpas.js'
import { SemanticIntentRouter } from '../gpasIntent.js'
import { createGpasCapabilities } from './gpas.js'

// One composition root keeps the catalog used for tool retrieval identical to
// the tools the worker executes. Register additional domain modules here.
export function createCapabilityRuntime(config: AppConfig, embedding = new LocalEmbeddingService(config)) {
  const gpas = new GpasService(config)
  const registry = createGpasCapabilities(gpas)
  const toolIds = registry.toolIds()
  return {
    gpas,
    registry,
    toolIds,
    /** The local embedding model is only needed once tools outnumber the per-run limit. */
    routerRequired: toolIds.length > (config.agentToolLimit ?? 8),
    router: new SemanticIntentRouter(embedding, registry.descriptions()),
  }
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>
