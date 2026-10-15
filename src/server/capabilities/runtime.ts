import type { AppConfig } from '../config.js'
import { GpasService } from '../gpas.js'
import { createGpasCapabilities } from './gpas.js'

// One composition root keeps the catalog offered to the model identical to the
// tools the worker executes. Register additional domain modules here.
export function createCapabilityRuntime(config: AppConfig) {
  const gpas = new GpasService(config)
  const registry = createGpasCapabilities(gpas)
  const toolIds = registry.toolIds()
  // Every run is offered the whole catalog and the model picks the tool, so a
  // catalog larger than the per-run limit would silently drop tools.
  if (toolIds.length > config.agentToolLimit) {
    throw new Error(`AGENT_TOOL_LIMIT (${config.agentToolLimit}) must be at least the ${toolIds.length} registered agent tools`)
  }
  return { gpas, registry, toolIds }
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>
