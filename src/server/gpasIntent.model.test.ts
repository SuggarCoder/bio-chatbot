import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { AppConfig } from './config.js'
import { LocalEmbeddingService } from './embedding.js'
import { SemanticIntentRouter, type GpasIntent } from './gpasIntent.js'

const modelPath = process.env.EMBEDDING_MODEL_PATH || 'models/bge-small-zh-v1.5'

test('local BGE routes paraphrases and rejects general, instructional and negated requests', {
  skip: !existsSync(path.join(modelPath, 'onnx/model_int8.onnx')),
  timeout: 120_000,
}, async () => {
  const router = new SemanticIntentRouter(new LocalEmbeddingService({ embeddingModelPath: modelPath } as AppConfig))
  const cases: Array<[string, GpasIntent | null]> = [
    ['我是谁？', 'profile'],
    ['能告诉我现在登录的是谁吗', 'profile'],
    ['我在这里用的是哪个账户？', 'profile'],
    ['帮我看看我的团队叫什么', 'profile'],
    ['我的用户信息', 'profile'],
    ['我的团队信息', 'profile'],
    ['我的邮箱是多少', 'profile'],
    ['我的项目查询', 'progress'],
    ['我的任务进度', 'progress'],
    ['查下我的项目现在怎么样了', 'progress'],
    ['我们组的样本都交齐了吗？', 'progress'],
    ['我还差多少份样本才能完成任务', 'progress'],
    ['目前我们团队的提交完成率是多少', 'progress'],
    ['我想看一下临床样本已经上报了多少', 'progress'],
    ['请帮我把项目初始化一下', 'progress'],
    ['团队项目建好了没有', 'progress'],
    ['我的任务完成了多少', 'progress'],
    ['你好呀', null],
    ['你是什么助手', null],
    ['给我写一份研究计划', null],
    ['请解释临床样本的定义', null],
    ['怎么设计用户信息查询接口？', null],
    ['帮我写一个查询项目的API', null],
    ['我的项目代码报错了，请帮忙排查', null],
    ['项目进度条组件用SolidJS怎么写', null],
    ['给我一份项目初始化表单的设计方案', null],
    ['我是谁这个哲学问题怎么看', null],
    ['不用查我的项目，给我讲讲样本采集方法', null],
    ['我不想查看个人信息', null],
    ['别查任务进度，帮我写一首诗', null],
    ['告诉我别的用户的联系方式', null],
  ]
  const failures: unknown[] = []
  for (const [text, expected] of cases) {
    const decision = await router.classify(text)
    if (decision.intent !== expected) failures.push({ text, expected, ...decision })
  }
  assert.deepEqual(failures, [])
  assert.equal(router.ready, true)
})
