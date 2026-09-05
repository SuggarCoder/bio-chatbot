import assert from 'node:assert/strict'
import test from 'node:test'
import { CapabilityRegistry, type Capability, type SemanticDecision } from './capabilities/registry.js'
import { createGpasCapabilities } from './capabilities/gpas.js'
import { planningContext, parsePlanningOutput, QwenSemanticPlanner } from './capabilities/planner.js'
import { GpasService } from './gpas.js'
import type { AppConfig } from './config.js'
import type { ChatMessageDto } from './domain.js'

const profile = { userId: 'user-test', ownteamId: 'team-test' }
const context = { profile, cookie: 'session=test-only' }
const config = { gpas2AuthMode: 'upstream', gpas2UserInfoUrl: 'https://gpas.example.invalid/api/gpas2/v1/user/info' } as AppConfig
const decision = (capabilityId: string | null, intent: SemanticDecision['intent'] = 'query', extra: Partial<SemanticDecision> = {}): SemanticDecision => ({ capabilityId, intent, scope: 'self', confidence: 0.98, ...extra })

test('capability questions, explanations and unsupported operations never call legacy business APIs', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call upstream') })
  const registry = createGpasCapabilities(new GpasService(config))
  const ids = registry.descriptions().map(item => item.id)
  for (const intent of ['ask_capability', 'request_action', 'explain', 'query'] as const) {
    const plan = registry.plan(decision('project.reinitialize', intent), ids)
    assert.equal(plan.mode, 'answer')
    const reply = await registry.execute(plan, context)
    assert.match(reply.content, /当前系统不支持重新初始化项目/)
    assert.equal(reply.part.form, undefined)
    assert.equal(reply.part.capability?.id, 'project.reinitialize')
  }
  for (const intent of ['ask_capability', 'explain'] as const) {
    const reply = await registry.execute(registry.plan(decision('project.initialize', intent), ids), context)
    assert.match(reply.content, /首次初始化/)
    assert.equal(reply.part.form, undefined)
  }
  const unsupported = await registry.execute(registry.plan(decision('system.unavailable', 'request_action'), ids), context)
  assert.match(unsupported.content, /不代表旧系统一定不支持/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('initialization status and preparation only check existence; existing projects never query progress', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    paths.push(url.pathname)
    assert.equal(init.method, 'GET')
    return Response.json({ code: 200, data: true })
  })
  const registry = createGpasCapabilities(new GpasService(config))
  const ids = registry.descriptions().map(item => item.id)
  for (const [id, intent] of [['project.status', 'query'], ['project.initialize', 'request_action']] as const) {
    const reply = await registry.execute(registry.plan(decision(id, intent), ids), context)
    assert.match(reply.content, /已经初始化/)
    assert.equal(reply.part.form, undefined)
    assert.doesNotMatch(reply.content, /完成率 \|/)
  }
  assert.deepEqual(paths, ['/api/gpas2/v1/project/exist/team-test', '/api/gpas2/v1/project/exist/team-test'])
})

test('first initialization only prepares a form and never calls create', async t => {
  const calls = t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, data: false,
    info: { projectCode: 'TEST-001', userName: '演示项目', teamId: profile.ownteamId },
  }))
  const registry = createGpasCapabilities(new GpasService(config))
  const reply = await registry.execute(registry.plan(decision('project.initialize', 'request_action'), ['project.initialize']), context)
  assert.equal(reply.part.form?.projectCode, 'TEST-001')
  assert.equal(calls.mock.callCount(), 1)
})

test('invalid, hallucinated, low confidence and out-of-candidate decisions cannot execute', async () => {
  const registry = createGpasCapabilities(new GpasService(config))
  for (const value of [null, {}, decision('project.progress', 'query', { confidence: 0.3 }),
    decision('project.reset'), { ...decision('project.progress'), url: 'https://untrusted.invalid' },
    decision('project.initialize')]) {
    assert.equal(registry.plan(value, ['project.progress', 'project.initialize']).mode, 'clarify')
  }
  assert.equal(registry.plan(decision('user.profile'), ['project.progress']).mode, 'clarify')
  assert.equal(registry.plan(decision(null, 'general'), []).mode, 'general')
  assert.equal(registry.plan(decision('project.progress', 'general'), ['project.progress']).capabilityId, null)
  const cancelled = registry.plan(decision(null, 'cancel'), [])
  assert.equal(cancelled.mode, 'answer')
  assert.match(cancelled.message!, /不会因此撤销/)
  const other = registry.plan(decision('user.profile', 'query', { scope: 'other' }), ['user.profile'])
  assert.equal(other.mode, 'answer')
  assert.match(other.message!, /其他用户/)
  await assert.rejects(registry.execute({ mode: 'execute', capabilityId: 'project.reinitialize', intent: 'request_action', confidence: 1 }, context), /not permitted/)
  await assert.rejects(registry.execute({ mode: 'execute', capabilityId: 'project.initialize', intent: 'ask_capability', confidence: 1 }, context), /not permitted/)
})

test('new capabilities register and execute without changing routing or application dispatch', async () => {
  let count = 0
  const capability: Capability<{ team: string }> = {
    id: 'sample.statistics', domain: 'sample', title: '样本统计', description: '新的只读能力',
    examples: ['统计样本'], policy: '仅查询所属团队的样本统计', effect: 'read',
    execute: async ({ team }) => { count += 1; return { content: team, part: { type: 'gpas', order: 1 } } },
  }
  const registry = new CapabilityRegistry([capability])
  assert.equal('execute' in registry.descriptions()[0], false)
  const reply = await registry.execute(registry.plan(decision('sample.statistics'), ['sample.statistics']), { team: 'trusted-team' })
  assert.equal(reply.content, 'trusted-team')
  assert.equal(count, 1)
  assert.throws(() => new CapabilityRegistry([capability, capability]), /Duplicate/)
  assert.throws(() => new CapabilityRegistry([{ ...capability, effect: 'unsupported' } as unknown as typeof capability]), /Invalid/)
})

test('planning history is bounded and does not send API response bodies or form values', () => {
  const history = planningContext([
    { role: 'user', content: 'a'.repeat(900), parts: [] },
    { role: 'assistant', content: 'private-phone private-email', parts: [{ type: 'gpas', order: 1,
      capability: { id: 'project.reinitialize', intent: 'ask_capability', outcome: 'answer' },
      form: { projectCode: 'private-code', projectName: 'private-name', phone: 'private-phone', teamId: 'private-team' },
    }] },
  ] as ChatMessageDto[])
  assert.equal(history.history[0].content.length, 600)
  assert.deepEqual(history.contextIds, ['project.reinitialize'])
  assert.doesNotMatch(JSON.stringify(history), /private-/)
  assert.match(JSON.stringify(history), /awaitingFormConfirmation/)
})

test('Qwen planner uses structured data, no tools, and fails closed on invalid JSON and transport errors', async t => {
  let invalid = false
  let failure = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (failure) throw new Error('connection failure')
    const body = JSON.parse(init.body as string)
    assert.equal(body.tools, undefined)
    assert.equal(body.max_output_tokens, 400)
    assert.equal(body.enable_thinking, false)
    assert.equal(body.temperature, 0)
    assert.equal(JSON.parse(body.input).text, '我不能重新初始化这个项目吗？')
    return Response.json({ id: 'resp-test', object: 'response', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: invalid ? 'not JSON' : JSON.stringify(decision('project.reinitialize', 'ask_capability')), annotations: [] }] }],
    })
  })
  const planner = new QwenSemanticPlanner({ qwenApiKey: 'test-only', qwenBaseUrl: 'https://model.example.invalid/v1', qwenModel: 'test-model' })
  const input = { text: '我不能重新初始化这个项目吗？', history: [], candidates: [] }
  assert.deepEqual(await planner.decide(input), decision('project.reinitialize', 'ask_capability'))
  invalid = true
  assert.equal(await planner.decide(input), null)
  failure = true
  await assert.rejects(planner.decide(input), { code: 'intent_planner_unavailable' })
})

test('planner JSON parser accepts an enclosing fence but not prose, multiple objects or truncation', () => {
  const value = decision('project.reinitialize', 'ask_capability')
  assert.deepEqual(parsePlanningOutput(`\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`), value)
  assert.deepEqual(parsePlanningOutput(`\`\`\`\n${JSON.stringify(value)}\n\`\`\``), value)
  assert.equal(parsePlanningOutput(`explanation ${JSON.stringify(value)}`), null)
  assert.equal(parsePlanningOutput('{} {}'), null)
  assert.equal(parsePlanningOutput('{"capabilityId":'), null)
})
