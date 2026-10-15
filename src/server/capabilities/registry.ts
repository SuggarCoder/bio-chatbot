export type CapabilityDescription = {
  id: string
  domain: string
  title: string
  description: string
  examples: readonly string[]
  policy: string
  // Semantic effects, NOT HTTP methods: the legacy summary read uses POST.
  effect: 'read' | 'prepare_confirmation' | 'unsupported' | 'information'
  alwaysInclude?: boolean
}

/**
 * Catalog of everything the assistant can talk about. `read` and
 * `prepare_confirmation` entries are agent tools (src/server/gpas/tools);
 * `unsupported` / `information` entries are policies the agent must follow.
 * The catalog never holds handlers, URLs, credentials or API parameters.
 */
export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityDescription>()

  constructor(capabilities: readonly CapabilityDescription[]) {
    for (const capability of capabilities) {
      if (!capability.id || this.entries.has(capability.id)) throw new Error(`Duplicate or empty capability ID: ${capability.id}`)
      if (!capability.policy || !capability.examples.length) {
        throw new Error(`Invalid capability registration: ${capability.id}`)
      }
      this.entries.set(capability.id, Object.freeze({ ...capability, examples: Object.freeze([...capability.examples]) }))
    }
  }

  descriptions(): CapabilityDescription[] {
    return Array.from(this.entries.values(), (description) => ({ ...description }))
  }

  /** Ids the agent may call as tools. */
  toolIds(): string[] {
    return this.descriptions()
      .filter((item) => item.effect === 'read' || item.effect === 'prepare_confirmation')
      .map((item) => item.id)
  }
}
