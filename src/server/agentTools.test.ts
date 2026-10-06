import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import {
  AgentSession,
  AgentToolbox,
  limitModelOutput,
  MODEL_OUTPUT_LIMIT_BYTES,
  toolFunctionName,
} from './agent/tools.js'
import { createGpasCapabilities } from './capabilities/gpas.js'
import type { AppConfig } from './config.js'
import type { CurrentUser } from './domain.js'
import { GpasService } from './gpas.js'
import { defineGpasTool } from './gpas/defineTool.js'
import { createGpasTools } from './gpas/tools/index.js'
import { openCredential, sealCredential } from './ingress.js'

const config = {
  gpas2AuthMode: 'upstream',
  gpas2UserInfoUrl: 'https://gpas.example.invalid/api/gpas2/v1/user/info',
  agentToolLimit: 8,
} as AppConfig
const user = { id: 'u1', externalUserId: 'user-a', externalTeamId: 'team-a' } as CurrentUser

function fakeGpas(responses: Record<string, unknown>, seen: string[] = []) {
  return async (input: URL | string, init: RequestInit) => {
    const url = new URL(String(input))
    seen.push(`${url.pathname} ${new Headers(init.headers).get('cookie')}`)
    const key = Object.keys(responses).find((path) => url.pathname.endsWith(path))
    return key ? Response.json(responses[key]) : new Response('missing', { status: 404 })
  }
}

function toolbox() {
  const service = new GpasService(config)
  return new AgentToolbox(config, createGpasTools(service), service.client, createGpasCapabilities(service).descriptions())
}

test('tool set exposes valid function names and JSON schemas, and only selected tools', () => {
  const set = toolbox().select(['project.progress', 'user.profile', 'not.registered'])!
  assert.deepEqual(set.tools.map((tool) => tool.name), ['project__progress', 'user__profile'])
  for (const tool of set.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/)
    assert.equal((tool.parameters as { type?: string }).type, 'object')
    assert.equal('$schema' in (tool.parameters ?? {}), false)
  }
  assert.match(set.instructions(), /重新初始化项目/)
  assert.equal(toolbox().select(['not.registered']), null)
})

test('the model cannot call a tool outside the run allowlist or pass invalid arguments', async () => {
  const set = toolbox().select(['user.profile'])!
  const session = new AgentSession({ ...config, gpas2AuthMode: 'mock' } as AppConfig, user, undefined, new AbortController().signal)
  const unknown = await set.execute({ call_id: 'c1', name: 'project__progress', arguments: '{}' }, session)
  assert.equal(unknown.ok, false)
  assert.match(unknown.output, /不可用/)
  const badJson = await set.execute({ call_id: 'c2', name: 'user__profile', arguments: '{not json' }, session)
  assert.equal(badJson.ok, false)
  assert.match(badJson.output, /JSON/)
})

test('agent session rejects a cookie whose GPAS identity differs from the generation owner', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeGpas({
    '/user/info': { code: 200, data: { userId: 'user-b', ownteamId: 'team-b', status: 0 } },
  }))
  const set = toolbox().select(['project.progress'])!
  const session = new AgentSession(config, user, 'session=b', new AbortController().signal)
  const result = await set.execute({ call_id: 'c1', name: 'project__progress', arguments: '{}' }, session)
  assert.equal(result.ok, false)
  assert.match(result.output, /身份或团队已变更/)
})

test('progress tool runs with the session cookie for the session team only', async (t) => {
  const seen: string[] = []
  t.mock.method(globalThis, 'fetch', fakeGpas({
    '/user/info': { code: 200, data: { userId: 'user-a', ownteamId: 'team-a', ownteamName: '甲', status: 0 } },
    '/project/exist/team-a': { code: 200, data: true },
    '/summary/submit/info/team-a': { code: 200,
      projectPlanInfo: { name: '项目甲', id: 'p', clinic: 10, media: 0, environment: 0, lab: 0 },
      realSubmitInfo: [{ year: 2026, month: 1, clinic: 4 }] },
  }, seen))
  const set = toolbox().select(['project.progress'])!
  const session = new AgentSession(config, user, 'session=a', new AbortController().signal)
  const result = await set.execute({ call_id: 'c1', name: 'project__progress', arguments: '{}' }, session)
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(result.output).samples[0].remaining, 6)
  assert.equal(result.part, undefined)
  assert.deepEqual(seen, [
    '/api/gpas2/v1/user/info session=a',
    '/api/gpas2/v1/project/exist/team-a session=a',
    '/api/gpas2/v1/summary/submit/info/team-a session=a',
  ])
})

test('confirmation tool returns a form part for the user, never a mutation', async (t) => {
  const seen: string[] = []
  t.mock.method(globalThis, 'fetch', fakeGpas({
    '/user/info': { code: 200, data: { userId: 'user-a', ownteamId: 'team-a', status: 0 } },
    '/project/exist/team-a': { code: 200, data: false, info: { projectCode: 'P1', userName: '项目', teamId: 'team-a' } },
  }, seen))
  const set = toolbox().select(['project.initialize'])!
  const session = new AgentSession(config, user, 'session=a', new AbortController().signal)
  const result = await set.execute({ call_id: 'c1', name: 'project__initialize', arguments: '{}' }, session)
  assert.equal(result.ok, true)
  assert.equal(result.part?.form?.projectCode, 'P1')
  assert.equal(JSON.parse(result.output).formPrepared, true)
  assert.equal(seen.some((line) => line.includes('/project/create')), false)
})

test('large tool results are truncated for the model', () => {
  const output = limitModelOutput({ rows: Array.from({ length: 5_000 }, (_, index) => ({ index, name: `样本-${index}` })) })
  assert.ok(Buffer.byteLength(output, 'utf8') <= MODEL_OUTPUT_LIMIT_BYTES)
  assert.equal(JSON.parse(output).truncated, true)
  assert.equal(limitModelOutput({ small: 1 }), '{"small":1}')
})

test('tool arguments are validated against the spec and never carry identity', async () => {
  const spec = defineGpasTool({
    id: 'demo.list', domain: 'demo', title: '示例', description: '示例', policy: '示例', examples: ['示例'], effect: 'read',
    input: z.object({ page: z.number().int().min(1).default(1) }),
    run: async (_ctx, args) => args,
    toModel: (data) => data,
    toReply: () => ({ content: '', part: { type: 'gpas', order: 1 } }),
  })
  const service = new GpasService(config)
  const set = new AgentToolbox(config, [spec], service.client).select(['demo.list'])!
  assert.equal(toolFunctionName('demo.list'), 'demo__list')
  // Defaulted fields are optional for the model.
  assert.deepEqual((set.tools[0].parameters as { required?: string[] }).required ?? [], [])
  const session = new AgentSession({ ...config, gpas2AuthMode: 'mock' } as AppConfig, { ...user, externalUserId: 'user-69da47c8f6b1f75c2d3855f8ed23d803', externalTeamId: 'team-1f340278f76b47a7a46bb91c466f7742' }, undefined, new AbortController().signal)
  const invalid = await set.execute({ call_id: 'c1', name: 'demo__list', arguments: '{"page":0}' }, session)
  assert.equal(invalid.ok, false)
  assert.match(invalid.output, /参数无效/)
  const valid = await set.execute({ call_id: 'c2', name: 'demo__list', arguments: '{}' }, session)
  assert.deepEqual(JSON.parse(valid.output), { page: 1 })
})

test('sealed generation credentials are bound to one user and generation', () => {
  const key = Buffer.alloc(32, 3).toString('base64')
  const sealed = sealCredential('session=a', key, 'u1:g1:generation')
  assert.equal(openCredential(sealed, key, 'u1:g1:generation'), 'session=a')
  assert.throws(() => openCredential(sealed, key, 'u1:g2:generation'))
  assert.throws(() => openCredential(sealed, key, 'u2:g1:generation'))
})
