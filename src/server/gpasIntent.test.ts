import assert from 'node:assert/strict'
import test from 'node:test'
import { SemanticIntentRouter, intentExamples } from './gpasIntent.js'

const vector = (index: number) => Array.from({ length: 512 }, (_, i) => i === index ? 1 : 0)

test('routing is driven by model vectors and embeds reference utterances only once', async () => {
  const calls: string[] = []
  const router = new SemanticIntentRouter({ embed: async (text, pooling) => {
    calls.push(text)
    assert.equal(pooling, 'cls')
    if (text === '完全没有关键词的输入' || intentExamples.progress.includes(text)) return vector(1)
    if (intentExamples.profile.includes(text)) return vector(0)
    return vector(2)
  } })
  const count = Object.values(intentExamples).flat().length
  await Promise.all([router.initialize(), router.initialize()])
  assert.equal(calls.length, count)
  assert.equal((await router.classify('完全没有关键词的输入')).intent, 'progress')
  assert.equal((await router.classify('我的项目查询')).intent, null)
  assert.equal(calls.length, count + 2)
})

test('ambiguous scores do not invoke a business API', async () => {
  const router = new SemanticIntentRouter({ embed: async () => vector(0) })
  assert.equal((await router.classify('anything')).intent, null)
})

test('model failures and invalid vectors fail explicitly without keyword fallback and permit retry', async () => {
  let fail = true
  const router = new SemanticIntentRouter({ embed: async () => {
    if (fail) throw new Error('model missing')
    return vector(0)
  } })
  await assert.rejects(router.classify('我的任务进度'), { code: 'intent_model_unavailable' })
  fail = false
  await router.initialize()
  assert.equal(router.ready, true)
  const invalid = new SemanticIntentRouter({ embed: async () => [NaN] })
  await assert.rejects(invalid.classify('我是谁'), { code: 'intent_model_unavailable' })
})
