import { AuthenticationError } from './auth.js'
import type { CapabilityDescription } from './capabilities/registry.js'
import type { PlanningHistory, SemanticPlanner } from './capabilities/planner.js'

type Embedder = { embed: (text: string, pooling: 'cls') => Promise<number[]> }
export type CapabilityCandidate = { capability: CapabilityDescription, score: number }

function normalized(vector: number[]): number[] {
  const norm = Math.hypot(...vector)
  if (vector.length !== 512 || !Number.isFinite(norm) || norm === 0) {
    throw new Error('Intent embedding must be a finite nonzero 512-dimensional vector')
  }
  return vector.map(value => value / norm)
}

// BGE retrieves capabilities; it does not infer permission, negation or actions.
// Adding capabilities only changes the registry, not this routing algorithm.
export class SemanticIntentRouter {
  private references: Array<{ id: string, vector: number[] }> = []
  private initializing?: Promise<void>

  constructor(private readonly embedding: Embedder, private readonly capabilities: readonly CapabilityDescription[]) {}

  get ready() { return this.references.length > 0 }

  initialize(): Promise<void> {
    if (this.ready) return Promise.resolve()
    this.initializing ??= (async () => {
      const references: typeof this.references = []
      for (const capability of this.capabilities) {
        for (const text of [capability.description, ...capability.examples]) {
          references.push({ id: capability.id, vector: normalized(await this.embedding.embed(text, 'cls')) })
        }
      }
      this.references = references
    })().catch((error: unknown) => {
      this.initializing = undefined
      throw error
    })
    return this.initializing
  }

  async retrieve(text: string, contextIds: readonly string[] = []): Promise<CapabilityCandidate[]> {
    try {
      await this.initialize()
      const vector = normalized(await this.embedding.embed(text, 'cls'))
      const scores = new Map<string, number>()
      for (const reference of this.references) {
        const similarity = vector.reduce((sum, value, index) => sum + value * reference.vector[index], 0)
        scores.set(reference.id, Math.max(scores.get(reference.id) ?? -1, similarity))
      }
      const ranked = this.capabilities.map(capability => ({ capability, score: scores.get(capability.id) ?? -1 }))
        .sort((left, right) => right.score - left.score)
      const selected = ranked.slice(0, 6)
      const domains = new Set([...selected.slice(0, 2).map(item => item.capability.domain),
        ...this.capabilities.filter(item => contextIds.includes(item.id)).map(item => item.domain)])
      // Reserve catalog-wide rules and contextual capabilities before bounded
      // related-domain expansion. Sibling unsupported operations remain visible.
      const extras = ranked.filter(item => item.capability.alwaysInclude || contextIds.includes(item.capability.id))
      const related = ranked.filter(item => domains.has(item.capability.domain))
      return [...new Map([...extras, ...selected, ...related].map(item => [item.capability.id, item])).values()].slice(0, 16)
    } catch {
      throw new AuthenticationError('本地语义识别模型暂时不可用，请稍后重试。', 503, 'intent_model_unavailable')
    }
  }

  async classify(text: string, planner: SemanticPlanner, history: readonly PlanningHistory[] = [], contextIds: readonly string[] = []) {
    const candidates = await this.retrieve(text, contextIds)
    const decision = await planner.decide({ text, history: history.slice(-6), candidates: candidates.map(item => item.capability) })
    return { decision, candidates }
  }
}
