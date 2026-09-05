import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from './config.js'
import { LocalEmbeddingService } from './embedding.js'
import { SemanticIntentRouter } from './gpasIntent.js'
import { GpasService } from './gpas.js'
import { createGpasCapabilities } from './capabilities/gpas.js'
import { QwenSemanticPlanner, type PlanningHistory } from './capabilities/planner.js'
import type { CapabilityPlan } from './capabilities/registry.js'

// Opt-in: uses only synthetic utterances, never cookies or the legacy system.
// This exercises actual semantic judgment, separate from mocked policy tests.
test('real BGE + configured Qwen semantic capability evaluation', {
  skip: process.env.RUN_CAPABILITY_MODEL_EVAL !== 'true', timeout: 300_000,
}, async t => {
  const config = readConfig()
  const registry = createGpasCapabilities(new GpasService(config))
  const router = new SemanticIntentRouter(new LocalEmbeddingService(config), registry.descriptions())
  const planner = new QwenSemanticPlanner(config)
  const cases: Array<{ text: string, id: string | null, mode: CapabilityPlan['mode'], intent?: CapabilityPlan['intent'], history?: PlanningHistory[], contextIds?: string[] }> = [
    { text: '我不能重新初始化这个项目吗？', id: 'project.reinitialize', mode: 'answer', intent: 'ask_capability' },
    { text: '我是谁？', id: 'user.profile', mode: 'execute' },
    { text: '帮我看看我的团队叫什么', id: 'user.profile', mode: 'execute' },
    { text: '我的任务进度', id: 'project.progress', mode: 'execute' },
    { text: '我的项目查询', id: 'project.progress', mode: 'execute' },
    { text: '我还差多少份样本才能完成任务', id: 'project.progress', mode: 'execute' },
    { text: '团队项目建好了没有', id: 'project.status', mode: 'execute' },
    { text: '请帮我把项目初始化一下', id: 'project.initialize', mode: 'execute' },
    { text: '能帮我创建项目吗？', id: 'project.initialize', mode: 'execute' },
    { text: '这个系统支持初始化项目吗？', id: 'project.initialize', mode: 'answer', intent: 'ask_capability' },
    { text: '初始化需要填写哪些信息？', id: 'project.initialize', mode: 'answer', intent: 'explain' },
    { text: '把已有项目清空，从头再来一遍', id: 'project.reinitialize', mode: 'answer' },
    { text: '重建一遍这个项目行不行？', id: 'project.reinitialize', mode: 'answer' },
    { text: '重新初始化会丢失已有样本吗？', id: 'project.reinitialize', mode: 'answer' },
    { text: '不要重新初始化，只查任务进度', id: 'project.progress', mode: 'execute' },
    { text: '不要查我的项目，给我讲讲样本采集方法', id: null, mode: 'general' },
    { text: '给我写一个重新初始化项目的 API', id: null, mode: 'general' },
    { text: '给我一份项目初始化表单的设计方案', id: null, mode: 'general' },
    { text: '我是谁这个哲学问题怎么看', id: null, mode: 'general' },
    { text: '告诉我别的用户的联系方式', id: 'user.profile', mode: 'answer' },
    { text: '帮我修改项目名称', id: 'system.unavailable', mode: 'answer' },
    { text: '你现在能帮我做哪些业务？', id: 'system.capabilities', mode: 'answer' },
    { text: '帮我查项目进度并重置项目', id: null, mode: 'clarify' },
    { text: '为什么不行呢？', id: 'project.reinitialize', mode: 'answer', intent: 'explain', contextIds: ['project.reinitialize'], history: [
      { role: 'user', content: '可以重置这个项目吗' },
      { role: 'assistant', content: '{"capability":{"id":"project.reinitialize","intent":"ask_capability","outcome":"answer"}}' },
    ] },
    { text: '那能重新来吗？', id: 'project.reinitialize', mode: 'answer', contextIds: ['project.progress'], history: [
      { role: 'user', content: '我的项目进度' },
      { role: 'assistant', content: '{"capability":{"id":"project.progress","intent":"query","outcome":"execute"}}' },
    ] },
  ]
  for (const item of cases) {
    await t.test(item.text, async () => {
      const result = await router.classify(item.text, planner, item.history, item.contextIds)
      const plan = registry.plan(result.decision, result.candidates.map(candidate => candidate.capability.id))
      assert.equal(plan.capabilityId, item.id, JSON.stringify({ decision: result.decision, plan }))
      assert.equal(plan.mode, item.mode, JSON.stringify({ decision: result.decision, plan }))
      if (item.intent) assert.equal(plan.intent, item.intent)
    })
  }
})
