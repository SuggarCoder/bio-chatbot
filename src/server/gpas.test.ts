import assert from 'node:assert/strict'
import test from 'node:test'
import { GpasService, GpasUpstreamError, gpasUrl, profileReply } from './gpas.js'
import { projectInputSchema } from './gpasContracts.js'
import type { AppConfig } from './config.js'
import { mapMessage } from './db.js'

const profile = { userId: 'user-test', ownteamId: 'team-test', realName: '演示用户', ownteamName: '演示团队' }
const seed = { projectCode: '12345', userName: '默认项目', projectName: '不作为默认值', teamId: 'team-test', phone: '13800000000' }
const input = { sourceMessageId: 'c9345da6-998b-4462-a539-2d803f184e25', projectName: '项目', projectDesc: '', phone: '13800000000', samples: { clinic: 100, media: 200, environment: 300, lab: 400 } }
const config = { gpas2AuthMode: 'upstream', gpas2UserInfoUrl: 'https://gpas.example.invalid:8058/api/gpas2/v1/user/info' } as AppConfig

test('profile replies include user and team information', () => {
  assert.match(profileReply(profile), /演示用户/)
  assert.match(profileReply(profile), /演示团队/)
})

test('project URL preserves the API prefix and handles a trailing slash without forwarding queries', () => {
  for (const ending of ['/user/info', '/user/info/', '/user/info?token=private']) {
    assert.equal(gpasUrl(`https://gpas.example.invalid:8058/api/gpas2/v1${ending}`, 'project/exist/team-test').href,
      'https://gpas.example.invalid:8058/api/gpas2/v1/project/exist/team-test')
  }
  assert.throws(() => gpasUrl('https://gpas.example.invalid/wrong/path', 'project/create'), /应以/)
})

test('upstream errors identify the failing operation and HTTP status without retaining credentials or response data', async (t) => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1
    return count === 1 ? Response.json({ code: 200, data: true }) : new Response('private upstream details', { status: 404 })
  })
  await assert.rejects(new GpasService(config).progress(profile, 'session=secret'), (error: unknown) => {
    assert.ok(error instanceof GpasUpstreamError)
    assert.equal(error.code, 'gpas_upstream_error')
    assert.match(error.message, /项目进度汇总查询.*HTTP 404/)
    assert.equal(error.diagnostics.operation, 'project_summary')
    assert.equal(error.diagnostics.upstreamStatus, 404)
    assert.doesNotMatch(JSON.stringify(error), /team-test|session=secret|private upstream/)
    return true
  })
})

test('project query forwards Cookie to fixed endpoints and sums monthly totals without studies', async (t) => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    paths.push(url.pathname)
    assert.equal(url.origin, 'https://gpas.example.invalid:8058')
    assert.equal((options.headers as Record<string, string>).cookie, 'session=test')
    assert.equal(options.redirect, 'error')
    return Response.json(paths.length === 1 ? { code: 200, data: true } : {
      code: 200,
      projectPlanInfo: { clinic: 100, media: 0, environment: 10, lab: 0, name: '项目', id: 'project-test' },
      realSubmitInfo: [
        { year: 2025, month: 12, clinic: 21, studies: { clinic: [{ count: 21 }] } },
        { year: 2026, month: 1, clinic: 30, environment: 12 },
      ],
    })
  })
  const reply = await new GpasService(config).progress(profile, 'session=test')
  assert.deepEqual(paths, ['/api/gpas2/v1/project/exist/team-test', '/api/gpas2/v1/summary/submit/info/team-test'])
  assert.match(reply.content, /临床样本 \| 100 \| 51 \| 49 \| 51.0%/)
  assert.match(reply.content, /环境样本 \| 10 \| 12 \| 0 \| 120.0%/)
  assert.match(reply.content, /虫媒样本 \| 0 \| 0 \| 0 \| 未设置计划/)
  assert.match(reply.content, /实验室样本/)
})

test('missing project yields persistent form and create sends the documented payload', async (t) => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    if (options.method === 'POST') {
      posts += 1
      assert.equal(url.pathname, '/api/gpas2/v1/project/create')
      assert.deepEqual(JSON.parse(options.body as string), {
        projectCode: seed.projectCode, projectName: input.projectName, projectDesc: '',
        ownTeamId: profile.ownteamId, phone: input.phone, planContent: JSON.stringify(input.samples),
      })
      return Response.json({ code: 200 })
    }
    return Response.json({ code: 200, data: posts > 0, info: seed })
  })
  const service = new GpasService(config)
  const reply = await service.progress(profile, 'session=test')
  assert.equal(reply.part.form?.projectName, seed.userName)
  const restored = mapMessage({ id: input.sourceMessageId, seq: 2n, role: 'assistant', status: 'completed', parts: [reply.part], createdAt: new Date() })
  assert.deepEqual(restored.parts, [reply.part])
  await service.create(profile, 'session=test', input, reply.part.form!)
  assert.match((await service.create(profile, 'session=test', input, reply.part.form!)).content, /已存在/)
  assert.equal(posts, 1)
})

test('rejects stale forms, wrong teams, missing initialization info, invalid data and expired sessions', async (t) => {
  let payload: unknown = { code: 200, data: false, info: { ...seed, teamId: 'team-other' } }
  let status = 200
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
    if (options.method === 'POST') posts += 1
    return Response.json(payload, { status })
  })
  const service = new GpasService(config)
  await assert.rejects(service.progress(profile, 's=t'), /团队/)
  payload = { code: 200, data: false, info: seed }
  await assert.rejects(service.create(profile, 's=t', input, { ...seed, projectName: '', projectCode: 'stale' }), /初始化信息已变化/)
  payload = { code: 200, data: false }
  await assert.rejects(service.progress(profile, 's=t'), /缺失/)
  payload = { code: 200, data: 'false' }
  await assert.rejects(service.progress(profile, 's=t'), /不完整/)
  payload = { code: 401 }
  await assert.rejects(service.progress(profile, 's=t'), /登录已失效/)
  status = 503
  await assert.rejects(service.progress(profile, 's=t'), /返回错误/)
  await assert.rejects(service.progress(profile), /登录已失效/)
  assert.equal(posts, 0)
})

test('form quantities reject negative, fractional, unsafe values and empty names', () => {
  for (const clinic of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(projectInputSchema.safeParse({ ...input, samples: { ...input.samples, clinic } }).success, false)
  }
  assert.equal(projectInputSchema.safeParse({ ...input, projectName: '  ' }).success, false)
  assert.equal(projectInputSchema.safeParse(input).success, true)
})

test('local fixture supports initialization and progress without network', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
  const service = new GpasService({ ...config, gpas2AuthMode: 'mock' })
  const initial = await service.progress(profile)
  assert.ok(initial.part.form)
  await service.create(profile, undefined, input, initial.part.form)
  const progress = await service.progress(profile)
  assert.equal(progress.part.form, undefined)
  assert.match(progress.content, /临床样本 \| 100 \| 0 \| 100 \| 0.0%/)
  assert.match(progress.content, /本地演示数据/)
})
