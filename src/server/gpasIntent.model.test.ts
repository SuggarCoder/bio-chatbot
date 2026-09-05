import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { AppConfig } from './config.js'
import { LocalEmbeddingService } from './embedding.js'
import { SemanticIntentRouter } from './gpasIntent.js'
import { createGpasCapabilities } from './capabilities/gpas.js'
import { GpasService } from './gpas.js'

const modelPath = process.env.EMBEDDING_MODEL_PATH || 'models/bge-small-zh-v1.5'

test('real local BGE recalls fine-grained capabilities for paraphrases (not final intent accuracy)', {
  skip: !existsSync(path.join(modelPath, 'onnx/model_int8.onnx')),
  timeout: 120_000,
}, async () => {
  const catalog = createGpasCapabilities(new GpasService({ gpas2AuthMode: 'mock' } as AppConfig))
  const router = new SemanticIntentRouter(new LocalEmbeddingService({ embeddingModelPath: modelPath } as AppConfig), catalog.descriptions())
  const cases: Array<[string, string]> = [
    ['我是谁？', 'user.profile'],
    ['能告诉我现在登录的是谁吗', 'user.profile'],
    ['我在这里用的是哪个账户？', 'user.profile'],
    ['帮我看看我的团队叫什么', 'user.profile'],
    ['我的用户信息', 'user.profile'],
    ['我的团队信息', 'user.profile'],
    ['我的邮箱是多少', 'user.profile'],
    ['我的项目查询', 'project.progress'],
    ['我的任务进度', 'project.progress'],
    ['查下我的项目现在怎么样了', 'project.progress'],
    ['我们组的样本都交齐了吗？', 'project.progress'],
    ['我还差多少份样本才能完成任务', 'project.progress'],
    ['目前我们团队的提交完成率是多少', 'project.progress'],
    ['我想看一下临床样本已经上报了多少', 'project.progress'],
    ['请帮我把项目初始化一下', 'project.initialize'],
    ['团队项目建好了没有', 'project.status'],
    ['我的任务完成了多少', 'project.progress'],
    ['我不能重新初始化这个项目吗？', 'project.reinitialize'],
    ['我想清空这个项目从头来过', 'project.reinitialize'],
    ['重建一遍这个项目行不行', 'project.reinitialize'],
    ['把项目名称改一下', 'system.unavailable'],
  ]
  const failures: unknown[] = []
  for (const [text, expected] of cases) {
    const candidates = await router.retrieve(text)
    const top = [...candidates].sort((left, right) => right.score - left.score).slice(0, 2)
    if (!top.some(item => item.capability.id === expected)) failures.push({ text, expected, top: top.map(item => ({ id: item.capability.id, score: item.score })) })
  }
  assert.deepEqual(failures, [])
  assert.equal(router.ready, true)
})
