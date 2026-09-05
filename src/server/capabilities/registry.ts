import { z } from 'zod'
import type { BusinessReply } from '../gpas.js'

export const semanticDecisionSchema = z.object({
  capabilityId: z.string().max(120).nullable(),
  intent: z.enum(['query', 'request_action', 'ask_capability', 'explain', 'cancel', 'general', 'clarify']),
  scope: z.enum(['self', 'other', 'unspecified']),
  confidence: z.number().min(0).max(1),
}).strict()
export type SemanticDecision = z.infer<typeof semanticDecisionSchema>

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
export type Capability<Context> = CapabilityDescription & { reply?: string } & (
  | { effect: 'read' | 'prepare_confirmation', execute: (context: Context) => Promise<BusinessReply> }
  | { effect: 'unsupported' | 'information', execute?: never }
)
export type CapabilityPlan = {
  mode: 'general' | 'clarify' | 'answer' | 'execute'
  capabilityId: string | null
  intent: SemanticDecision['intent']
  confidence: number
  message?: string
}

const clarification = '请说明你希望执行的具体业务，以及是查询状态、请求操作，还是了解功能是否支持；如有多项需求，请先选择一项。我不会在意图不明确时执行操作。'

export class CapabilityRegistry<Context> {
  private readonly entries = new Map<string, Capability<Context>>()

  constructor(capabilities: readonly Capability<Context>[]) {
    for (const capability of capabilities) {
      if (!capability.id || this.entries.has(capability.id)) throw new Error(`Duplicate or empty capability ID: ${capability.id}`)
      const actionable = capability.effect === 'read' || capability.effect === 'prepare_confirmation'
      if (actionable !== (typeof capability.execute === 'function') || !capability.policy || !capability.examples.length) {
        throw new Error(`Invalid capability registration: ${capability.id}`)
      }
      this.entries.set(capability.id, Object.freeze({ ...capability, examples: Object.freeze([...capability.examples]) }))
    }
  }

  // The planner never receives handlers, URLs, credentials or API parameters.
  descriptions(): CapabilityDescription[] {
    return Array.from(this.entries.values(), ({ execute: _execute, reply: _reply, ...description }) => description)
  }

  plan(value: unknown, candidateIds: readonly string[]): CapabilityPlan {
    const parsed = semanticDecisionSchema.safeParse(value)
    const uncertain: CapabilityPlan = { mode: 'clarify', capabilityId: null, intent: 'clarify', confidence: 0, message: clarification }
    if (!parsed.success) return uncertain
    const decision = parsed.data
    const base = { capabilityId: decision.capabilityId, intent: decision.intent, confidence: decision.confidence }
    if (decision.confidence < 0.75 || decision.intent === 'clarify') return { ...uncertain, confidence: decision.confidence }
    // A topic ID is irrelevant for general conversation; discard it rather than
    // accidentally treating a programming question as an executable capability.
    if (decision.intent === 'general') return { ...base, capabilityId: null, mode: 'general' }
    if (decision.intent === 'cancel') return { ...base, mode: 'answer', message: '好的，本条消息不会发起业务查询或项目操作。此前已经提交的操作不会因此撤销。' }
    if (decision.scope === 'other') return { ...base, mode: 'answer', message: '当前助手只能访问你登录账号及所属团队的信息，不支持查询或操作其他用户、其他团队的数据。' }
    const capability = decision.capabilityId ? this.entries.get(decision.capabilityId) : undefined
    if (!capability || !candidateIds.includes(capability.id)) return uncertain
    if (capability.effect === 'unsupported' || capability.effect === 'information' || decision.intent === 'ask_capability' || decision.intent === 'explain') {
      return { ...base, mode: 'answer', message: capability.reply ?? capability.policy }
    }
    if (capability.effect === 'prepare_confirmation' && decision.intent !== 'request_action') return uncertain
    return { ...base, mode: 'execute' }
  }

  async execute(plan: CapabilityPlan, context: Context): Promise<BusinessReply> {
    if (plan.mode === 'general') throw new Error('General conversation must use the generation pipeline')
    const capability = plan.capabilityId ? this.entries.get(plan.capabilityId) : undefined
    let response: BusinessReply
    if (plan.mode === 'execute') {
      // Even a forged plan cannot execute an unsupported entry or explanations.
      if (!capability?.execute || !['query', 'request_action'].includes(plan.intent) ||
        (capability.effect === 'prepare_confirmation' && plan.intent !== 'request_action')) {
        throw new Error('Capability execution is not permitted')
      }
      response = await capability.execute(context)
    } else {
      response = { content: plan.message ?? clarification, part: { type: 'gpas', order: 1 } }
    }
    return { ...response, part: { ...response.part, capability: {
      id: plan.capabilityId, intent: plan.intent, outcome: plan.mode,
    } } }
  }
}
