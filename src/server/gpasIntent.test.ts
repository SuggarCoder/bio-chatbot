import assert from 'node:assert/strict'
import test from 'node:test'
import { SemanticIntentRouter } from './gpasIntent.js'
import type { CapabilityDescription } from './capabilities/registry.js'

const vector = (index: number) => Array.from({ length: 512 }, (_, i) => i === index ? 1 : 0)
const descriptions: CapabilityDescription[] = Array.from({ length: 24 }, (_, index) => ({
  id: `capability.${index}`, domain: 'test', title: `title ${index}`, description: `description ${index}`,
  examples: [`example ${index}`], policy: 'policy', effect: 'read', alwaysInclude: index === 23,
}))

test('capability retrieval is vector driven, cached, bounded and reserves context and global rules', async () => {
  const calls: string[] = []
  const router = new SemanticIntentRouter({ embed: async (text, pooling) => {
    calls.push(text)
    assert.equal(pooling, 'cls')
    if (text === '完全没有关键词的输入') return vector(12)
    return vector(descriptions.findIndex(item => item.description === text || item.examples.includes(text)))
  } }, descriptions)
  await Promise.all([router.initialize(), router.initialize()])
  assert.equal(calls.length, 48)
  const candidates = await router.retrieve('完全没有关键词的输入', ['capability.22'])
  assert.equal(candidates.length, 16)
  assert.ok(candidates.some(item => item.capability.id === 'capability.23'))
  assert.ok(candidates.some(item => item.capability.id === 'capability.22'))
  assert.equal(candidates.find(item => item.capability.id === 'capability.12')?.score, 1)
  assert.equal(calls.length, 49)
})

test('ambiguous BGE scores are handed to semantic planning, not converted to an action', async () => {
  const router = new SemanticIntentRouter({ embed: async () => vector(0) }, descriptions)
  const decision = { capabilityId: null, intent: 'clarify', scope: 'unspecified', confidence: 0.3 }
  const result = await router.classify('这能再来一次吗', { decide: async input => {
    assert.equal(input.text, '这能再来一次吗')
    assert.ok(input.candidates.length <= 16)
    assert.deepEqual(input.history, [{ role: 'user', content: '前一轮' }])
    return decision
  } }, [{ role: 'user', content: '前一轮' }])
  assert.deepEqual(result.decision, decision)
})

test('embedding failures and invalid vectors fail explicitly without keyword fallback and permit retry', async () => {
  let fail = true
  const router = new SemanticIntentRouter({ embed: async () => {
    if (fail) throw new Error('model missing')
    return vector(0)
  } }, descriptions)
  await assert.rejects(router.retrieve('我的任务进度'), { code: 'intent_model_unavailable' })
  fail = false
  await router.initialize()
  assert.equal(router.ready, true)
  const invalid = new SemanticIntentRouter({ embed: async () => [NaN] }, descriptions)
  await assert.rejects(invalid.retrieve('我是谁'), { code: 'intent_model_unavailable' })
})
