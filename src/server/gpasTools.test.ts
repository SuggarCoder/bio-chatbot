import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { createGpasCapabilities } from './capabilities/gpas.js'
import type { AppConfig } from './config.js'
import type { Gpas2UserInfo } from './domain.js'
import { GpasService } from './gpas.js'
import { GpasClient } from './gpas/client.js'
import { defineGpasTool, identityFieldPattern } from './gpas/defineTool.js'
import { createGpasTools } from './gpas/tools/index.js'

const config = { gpas2AuthMode: 'upstream', gpas2UserInfoUrl: 'https://gpas.example.invalid:8058/api/gpas2/v1/user/info' } as AppConfig
const profile = { userId: 'user-test', ownteamId: 'team-test', realName: '演示用户', ownteamName: '演示团队' } as Gpas2UserInfo
const base = {
  domain: 'demo', title: '示例', description: '示例工具', policy: '仅示例', examples: ['示例'],
  effect: 'read' as const,
  run: async () => ({}),
  toModel: () => ({}),
  toReply: () => ({ content: '', part: { type: 'gpas' as const, order: 1 } }),
}

test('every registered GPAS tool has a valid, identity-free contract', () => {
  const tools = createGpasTools(new GpasService(config))
  assert.ok(tools.length >= 4)
  assert.equal(new Set(tools.map((tool) => tool.id)).size, tools.length)
  for (const tool of tools) {
    assert.ok(tool.examples.length > 0, tool.id)
    assert.ok(['read', 'prepare_confirmation'].includes(tool.effect), tool.id)
    for (const key of Object.keys(tool.input.shape)) {
      assert.doesNotMatch(key, identityFieldPattern, `${tool.id}.${key}`)
    }
  }
})

test('tool definitions reject arguments that would let a model choose an identity', () => {
  for (const key of ['teamId', 'ownteamId', 'projectCode', 'user_id', 'team_code', 'cookie', 'userName']) {
    assert.throws(
      () => defineGpasTool({ ...base, id: 'demo.lookup', input: z.object({ [key]: z.string() }) }),
      /identity fields/,
      key,
    )
  }
  // Ordinary business filters stay allowed.
  defineGpasTool({ ...base, id: 'demo.lookup', input: z.object({ sampleType: z.string(), page: z.number(), keyword: z.string() }) })
  assert.throws(() => defineGpasTool({ ...base, id: 'Bad Id', input: z.object({}) }), /Invalid GPAS tool id/)
  assert.throws(() => defineGpasTool({ ...base, id: 'demo.empty', examples: [], input: z.object({}) }), /requires/)
})

test('capability catalog lists agent tools plus refusal policies', () => {
  const registry = createGpasCapabilities(new GpasService(config))
  const ids = registry.descriptions().map((item) => item.id)
  assert.deepEqual(ids, [
    'user.profile', 'project.progress', 'project.status', 'project.initialize',
    'project.reinitialize', 'system.unavailable',
  ])
  assert.deepEqual(registry.toolIds(), ['user.profile', 'project.progress', 'project.status', 'project.initialize'])
  // Descriptions never expose handlers or tool internals.
  for (const item of registry.descriptions()) {
    assert.equal('execute' in item, false)
    assert.equal('run' in item, false)
    assert.equal('input' in item, false)
  }
})

test('progress tool gives the model a compact structured view and the user the full table', async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push(`${init.method} ${url.pathname} ${new Headers(init.headers).get('cookie')}`)
    if (url.pathname.endsWith('/project/exist/team-test')) return Response.json({ code: 200, data: true })
    return Response.json({ code: 200,
      projectPlanInfo: { name: '项目甲', id: 'p1', clinic: 100, media: 0, environment: 10, lab: 4 },
      realSubmitInfo: [{ year: 2026, month: 9, clinic: 40, environment: 10 }, { year: 2026, month: 10, clinic: 10, lab: 1 }],
    })
  })
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'project.progress')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const data = await tool.run(context, tool.input.parse({}))

  const model = tool.toModel(data) as { initialized: boolean; samples: Array<Record<string, unknown>> }
  assert.equal(model.initialized, true)
  assert.deepEqual(model.samples[0], { type: 'clinic', label: '临床样本', plan: 100, submitted: 50, remaining: 50, completionRate: 50 })
  assert.equal(model.samples[1].completionRate, null)
  assert.ok(JSON.stringify(model).length < 8_192)
  assert.doesNotMatch(JSON.stringify(model), /session=mine/)

  const reply = tool.toReply(data, context)
  assert.match(reply.content, /\| 临床样本 \| 100 \| 50 \| 50 \| 50\.0% \|/)
  assert.match(reply.content, /\| 虫媒样本 \| 0 \| 0 \| 0 \| 未设置计划 \|/)
  // Only the session's own cookie reaches GPAS, for the session's own team.
  assert.deepEqual(calls, [
    'GET /api/gpas2/v1/project/exist/team-test session=mine',
    'POST /api/gpas2/v1/summary/submit/info/team-test session=mine',
  ])
})

test('client.read validates response data and requires a session cookie', async (t) => {
  const client = new GpasClient(config)
  const request = { operation: 'demo', label: '示例查询', method: 'GET' as const, path: 'demo' }
  await assert.rejects(client.read(undefined, request, z.object({})), /登录已失效/)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, rows: 'not-an-array' }))
  await assert.rejects(
    client.read('session=a', request, z.object({ rows: z.array(z.string()) })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'gpas_invalid_response',
  )
})
