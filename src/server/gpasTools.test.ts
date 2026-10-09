import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'

import { createGpasCapabilities } from './capabilities/gpas.js'
import type { AppConfig } from './config.js'
import type { Gpas2UserInfo } from './domain.js'
import { GpasService } from './gpas.js'
import { GpasClient } from './gpas/client.js'
import { defineGpasTool, identityFieldPattern } from './gpas/defineTool.js'
import { createGpasTools } from './gpas/tools/index.js'
import { mergeDuplicateRows, parseBrief } from './gpas/tools/file.js'
import { gpasPartSchema, sampleNameOf } from './gpasContracts.js'

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
    'user.profile', 'project.progress', 'project.status', 'project.initialize', 'file.list', 'file.result',
    'project.reinitialize', 'system.unavailable',
  ])
  assert.deepEqual(registry.toolIds(), ['user.profile', 'project.progress', 'project.status', 'project.initialize', 'file.list', 'file.result'])
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

const gpasFile = (fileId: string, overrides: Record<string, unknown> = {}) => ({
  fileId, fileName: `${fileId}.fq.gz`, groupId: 'g-1', sampleType: 'clinic', size: 1024,
  status: 'uploaded', analysisStatus: 'pending', metaStatus: 'missing', uploadTime: '2026-10-07 10:00:00',
  hash: 'private-hash', ownUserId: 'someone', ...overrides,
})

test('file list tool looks up the uploaded batch by file name', async (t) => {
  const queries: Array<Record<string, string>> = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, '/api/gpas2/v1/file/dual/merge/list')
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.equal(new Headers(init.headers).get('cookie'), 'session=mine')
    queries.push(Object.fromEntries(url.searchParams))
    // The name filter may match loosely: a similar name comes back too.
    const name = url.searchParams.get('fileName')
    const dataList = name === 'f-9.fq.gz' ? [] : [
      { isPair: true, file1: gpasFile('f-1', { analysisId: 'task-1' }), file2: gpasFile('f-2', { metaStatus: 'complete' }) },
      { isPair: false, file1: gpasFile('old', { groupId: null, fileName: `copy-${name}` }) },
    ]
    return Response.json({ code: 200, message: 'ok', maxPageSize: 100, dataPage: {
      currentCnt: dataList.length, page: 1, pageSize: 10, totalData: dataList.length, totalPage: 1, dataList,
    } })
  })
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'file.list')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const data = await tool.run(context, tool.input.parse({ fileNames: ['f-1.fq.gz', 'f-2.fq.gz', 'f-9.fq.gz', 'f-1.fq.gz'] })) as {
    total: number; rows: Array<{ paired: boolean; files: Array<Record<string, unknown>> }>
    cards: Array<{ analysisId: string | null }>; missingFileNames: string[]
  }

  // One query per distinct name.
  assert.deepEqual(queries.map((query) => query.fileName), ['f-1.fq.gz', 'f-2.fq.gz', 'f-9.fq.gz'])
  assert.deepEqual(queries[0], { fileName: 'f-1.fq.gz', page: '1', pageSize: '10', ownTeamId: 'team-test' })
  // Both ends found the same pair; loosely matched names are dropped.
  assert.equal(data.total, 1)
  assert.equal(data.rows[0].paired, true)
  assert.deepEqual(data.rows[0].files.map((file) => file.fileId), ['f-1', 'f-2'])
  assert.equal(data.cards[0].analysisId, 'task-1')
  assert.deepEqual(data.missingFileNames, ['f-9.fq.gz'])
  const model = tool.toModel(data) as { note: string; samples: Array<{ taskId: string | null; sampleName: string }> }
  assert.equal(model.samples[0].taskId, 'task-1')
  assert.equal(model.samples[0].sampleName, 'f')
  assert.match(model.note, /不要展示给用户/)
  // Only allowlisted fields reach the model.
  assert.doesNotMatch(JSON.stringify(model), /private-hash|someone|session=mine/)

  const reply = tool.toReply(data, context).content
  assert.match(reply, /\| f-1\.fq\.gz \| 双端 R1 \| 临床样本 \| uploaded \|/)
  assert.match(reply, /\| f-2\.fq\.gz \| 双端 R2 \|/)
  assert.match(reply, /暂未出现在列表中.*f-9\.fq\.gz/)
})

test('file list tool forwards filters and rejects malformed pages', async (t) => {
  let query: Record<string, string> = {}
  let payload: unknown = { code: 200, dataPage: { dataList: [], totalData: 0 } }
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    query = Object.fromEntries(url.searchParams)
    return Response.json(payload)
  })
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'file.list')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const data = await tool.run(context, tool.input.parse({ fileName: 'S01', status: 'uploaded;failed', page: 2, pageSize: 10 }))
  assert.deepEqual(query, { fileName: 'S01', status: 'uploaded;failed', page: '2', pageSize: '10', ownTeamId: 'team-test' })
  assert.match(tool.toReply(data, context).content, /没有查询到上传文件/)
  assert.equal(tool.input.safeParse({ pageSize: 500 }).success, false)

  payload = { code: 200, dataPage: { dataList: 'nope', totalData: 0 } }
  await assert.rejects(tool.run(context, tool.input.parse({})),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'gpas_invalid_response')
})

test('project status reports the sample types every project has planned', async (t) => {
  let summary: unknown
  let exists = true
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.includes('/project/exist/')
    ? Response.json({ code: 200, data: exists, info: { projectCode: 'P', userName: '项目', teamId: 'team-test' } })
    : Response.json({ code: 200, projectPlanInfo: summary, realSubmitInfo: [] }))
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'project.status')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const types = async () => ((await tool.run(context, {})) as { sampleTypes: string[] }).sampleTypes

  summary = { name: '甲', id: 'p1', clinic: 10, media: 0, environment: 5, lab: 0 }
  assert.deepEqual(await types(), ['clinic', 'environment'])
  // Several projects combine with AND.
  summary = [summary, { name: '乙', id: 'p2', clinic: 3, media: 8, environment: 0, lab: 1 }]
  assert.deepEqual(await types(), ['clinic'])
  // A team without a project may upload any of the four types.
  exists = false
  assert.deepEqual(await types(), ['clinic', 'media', 'environment', 'lab'])
})

const sampleBrief = readFileSync(new URL('../../tests/fixtures/gpas-brief.json', import.meta.url), 'utf8')

test('brief parsing keeps a top-5 summary per category, from a once- or twice-encoded string', () => {
  for (const raw of [sampleBrief, JSON.stringify(sampleBrief), JSON.parse(sampleBrief)]) {
    const brief = parseBrief(raw)!
    assert.deepEqual(brief.categories.map((category) => [category.name, category.speciesCount, category.top.length]), [
      ['细菌', 188, 3], ['病毒', 4, 3], ['真菌', 5, 3], ['动物等', 0, 0],
    ])
    assert.deepEqual(brief.categories[0].top[0], {
      cnName: '空肠普雷沃菌', enName: 'Prevotella jejuni', taxId: '1177574', abundancePct: 36.3, hazard: 3,
    })
    assert.equal(brief.totalReads, 38959015)
    assert.equal(brief.dataVolume, 10677513218)
    assert.deepEqual(brief.tools, ['Guardian'])
  }
  // More species than the summary keeps: highest abundance first, at most five.
  const many = JSON.parse(sampleBrief)
  many.microbialInfo[0].topInfos.push(
    { taxCnName: '甲', abundance: '50%', hazardIndex: 1 },
    { taxCnName: '乙', abundance: '1%', hazardIndex: 0 },
    { taxCnName: '丙', abundance: '0.5%', hazardIndex: 0 },
  )
  assert.deepEqual(parseBrief(many)!.categories[0].top.map((item) => item.cnName), ['甲', '空肠普雷沃菌', '产黑色普雷沃菌', '乳脂马杜拉放线菌', '乙'])
  for (const bad of ['', 'not json', '{"code":"500","microbialInfo":[]}', '{"code":"0","microbialInfo":"x"}', null, 42]) {
    assert.equal(parseBrief(bad), null, String(bad))
  }
})

test('duplicate rows merge by groupId, then analysisId; single-end files by fileId', () => {
  const row = (paired: boolean, files: Array<ReturnType<typeof gpasFile>>) =>
    ({ paired, groupId: files[0].groupId as string | null, files }) as unknown as Parameters<typeof mergeDuplicateRows>[0][number]
  const merged = mergeDuplicateRows([
    row(true, [gpasFile('a2', { groupId: null, analysisId: 77 }), gpasFile('a1', { groupId: null, analysisId: 77 })]),
    row(true, [gpasFile('b1', { groupId: null, analysisId: 77, briefAnalysis: sampleBrief }), gpasFile('b2', { groupId: null })]),
    row(true, [gpasFile('c1', { groupId: null }), gpasFile('c2', { groupId: null })]),
    row(false, [gpasFile('s1')]),
    row(false, [gpasFile('s2')]),
  ])
  assert.deepEqual(merged.map((item) => item.files.map((file) => file.fileId)), [['b1', 'b2'], ['c1', 'c2'], ['s1'], ['s2']])
})

test('file list tool returns one analysis card per sample and wording rules for the model', async (t) => {
  // The same pair (one groupId) listed twice, R2/R1 without analysis first and
  // with other fileIds, collapses into one R1/R2 card.
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, dataPage: { totalData: 3, dataList: [
    { isPair: true, file1: gpasFile('f-2b', { fileName: 'f-2.fq.gz', analysisStatus: 'noanalysis' }), file2: gpasFile('f-1b', { fileName: 'f-1.fq.gz' }) },
    { isPair: true, file1: gpasFile('f-1', { briefAnalysis: sampleBrief }), file2: gpasFile('f-2') },
    { isPair: false, file1: gpasFile('f-3', { briefAnalysis: 'broken', analysisStatus: 'running' }) },
  ] } }))
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'file.list')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const data = await tool.run(context, tool.input.parse({}))

  assert.equal(data.total, 2)
  assert.equal(data.rows.length, 2)
  const part = tool.toReply(data, context).part
  assert.equal(part.files?.length, 2)
  assert.equal(part.files![0].paired, true)
  assert.deepEqual(part.files![0].files.map((file) => file.fileId), ['f-1', 'f-2'])
  assert.equal(part.files![0].brief?.categories[0].speciesCount, 188)
  assert.equal(part.files![1].brief, null)
  assert.equal(gpasPartSchema.safeParse(part).success, true)

  const model = tool.toModel(data) as { note: string; samples: Array<{ brief: { categories: Array<Record<string, unknown>> } | null }> }
  assert.match(model.note, /前 topN/)
  assert.match(model.note, /不是只检出这几种/)
  assert.deepEqual(model.samples[0].brief!.categories[0], {
    name: '细菌', speciesCount: 188, sharePct: 95.4, topN: 3, maxHazard: 3,
    top: ['空肠普雷沃菌 36.3% 危害3', '产黑色普雷沃菌 24% 危害3', '乳脂马杜拉放线菌 3.6% 危害0'],
  })
  assert.equal(model.samples[1].brief, null)
  // The raw brief string never reaches the model.
  assert.doesNotMatch(JSON.stringify(model), /microbialInfo|tool_code/)
})

test('file result tool pages one task through the session and keeps safe fields only', async (t) => {
  const queries: Array<Record<string, string>> = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, '/api/gpas2/v1/file/result/list')
    assert.equal(init.method, 'GET')
    assert.equal(new Headers(init.headers).get('cookie'), 'session=mine')
    queries.push(Object.fromEntries(url.searchParams))
    return Response.json({ code: 200, message: 'ok', dataPage: {
      currentCnt: 2, page: 2, pageSize: 20, totalData: 42, totalPage: 3,
      dataList: [
        { id: 'r1', taskId: 'task-1', speciesType: 'bacteria', taxCname: '空肠普雷沃菌', taxEname: 'Prevotella jejuni', coverage: '12.5%',
          coverageUrl: 'https://gpas.example/cov/1.png', colonization: '定植', colonizationE: 'colonized', color: '#2c7378', barcodeId: 'B01',
          taxid: 1177574, hazardIndex: '3', selfAlignRatio: 1, onlyMatching: '10', unifPvalue: 12.94, abundance: '0.005%', ani95SpeciesNums: 0,
          createTime: '2026-01-01', updateTime: '2026-01-02', secret: 'x' },
        { id: 2, speciesType: 'bacteria', taxCname: '', taxEname: 'Unnamed', coverage: 3, coverageUrl: 'javascript:alert(1)',
          colonization: null, colonizationE: null, color: 'red;background:url(x)', barcodeId: null, taxId: '9606' },
      ],
    } })
  })
  const service = new GpasService(config)
  const tool = createGpasTools(service).find((item) => item.id === 'file.result')!
  const context = { profile, cookie: 'session=mine', client: service.client }
  const data = await tool.run(context, tool.input.parse({ taskId: 'task-1', speciesType: 'bacteria', page: 2 })) as {
    total: number; totalPage: number; rows: Array<Record<string, unknown>>
  }

  assert.deepEqual(queries[0], { taskId: 'task-1', speciesType: 'bacteria', page: '2', pageSize: '20' })
  assert.equal(data.total, 42)
  assert.equal(data.totalPage, 3)
  assert.deepEqual(data.rows[0], {
    id: 'r1', speciesType: 'bacteria', taxCname: '空肠普雷沃菌', taxEname: 'Prevotella jejuni', coverage: '12.5%',
    coverageUrl: 'https://gpas.example/cov/1.png', colonization: '定植', colonizationE: 'colonized', color: '#2c7378', barcodeId: 'B01',
    taxId: '1177574', hazardIndex: 3, coverageValue: 0.125,
    selfAlignRatio: 1, onlyMatching: 10, unifPvalue: 12.94, abundance: 0.005, ani95SpeciesNums: 0,
  })
  // Unsafe links and colors are dropped; a missing Chinese name falls back to the Latin one.
  assert.equal(data.rows[1].coverageUrl, null)
  assert.equal(data.rows[1].color, null)
  assert.equal(data.rows[1].taxCname, 'Unnamed')
  // 生物学编号 comes from `taxid`; a `taxId` field is read as a fallback.
  assert.equal(data.rows[1].taxId, '9606')
  // Missing evidence stays null rather than becoming zero.
  assert.equal(data.rows[1].hazardIndex, null)
  assert.equal(data.rows[1].selfAlignRatio, null)
  assert.equal(data.rows[1].coverageValue, 0.03)

  const model = tool.toModel(data) as { page: number; rows: Array<Record<string, unknown>> }
  assert.equal(model.page, 2)
  assert.deepEqual(Object.keys(model.rows[0]).sort(), [
    'abundance', 'ani95SpeciesNums', 'colonization', 'colonizationE', 'coverage', 'hazardIndex', 'onlyMatching',
    'selfAlignRatio', 'speciesType', 'taxCname', 'taxEname', 'taxId', 'unifPvalue',
  ])
  assert.doesNotMatch(JSON.stringify(model), /session=mine|secret|cov\/1\.png/)

  const reply = tool.toReply(data, context)
  assert.deepEqual(reply.part.result, { taskId: 'task-1', total: 42 })
  assert.equal(gpasPartSchema.safeParse(reply.part).success, true)
  assert.match(reply.content, /共检出 42 条/)

  for (const bad of [{}, { taskId: '../x' }, { taskId: 't', pageSize: 51 }, { taskId: 't', speciesType: 'a b' }]) {
    assert.equal(tool.input.safeParse(bad).success, false, JSON.stringify(bad))
  }
})

test('sample names drop sequencing suffixes and the R1/R2 end marker', () => {
  assert.equal(sampleNameOf(['KY14599-1-T233R_R1.clean.fastq.gz', 'KY14599-1-T233R_R2.clean.fastq.gz']), 'KY14599-1-T233R')
  assert.equal(sampleNameOf(['a.fq.gz']), 'a')
  assert.equal(sampleNameOf(['S1_R1.fq']), 'S1')
  assert.equal(sampleNameOf(['x.R1.fastq', 'x.R2.fastq']), 'x')
  assert.equal(sampleNameOf(['T1_1.fq.gz', 'T1_2.fq.gz']), 'T1')
  assert.equal(sampleNameOf(['sample-12.fastq.gz']), 'sample-12')
  // Unrelated names fall back to the first file name.
  assert.equal(sampleNameOf(['abc', 'xyz']), 'abc')
})

test('the detail tool is described for sample-name requests, resolved through the file list', () => {
  const tools = createGpasTools(new GpasService(config))
  const result = tools.find((item) => item.id === 'file.result')!
  const list = tools.find((item) => item.id === 'file.list')!
  assert.match(result.description, /先用上传文件列表工具按样本名查到 taskId/)
  assert.ok(result.examples.some((example) => /KY14599-1-T233R/.test(example)))
  assert.match(list.description, /按样本名查找样本的 taskId/)
})
