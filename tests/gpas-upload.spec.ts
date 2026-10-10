import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const chatId = 'c9345da6-998b-4462-a539-2d803f184e25'
const timestamp = '2026-10-07T00:00:00.000Z'

const fastq = (prefix: string, end: 1 | 2 | null, count = 12) => Buffer.from(
  Array.from({ length: count }, (_, index) => `@${prefix}:${index}${end ? ` ${end}:N:0:ACGT` : ''}\nACGT\n+\nIIII\n`).join(''),
)
const upload = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/octet-stream', buffer })

type Recorded = { messageBodies: Record<string, any>[]; tasks: Record<string, any>[]; slices: string[] }

const allTypes = ['clinic', 'media', 'environment', 'lab']

async function mockApis(
  page: Page,
  slice: (url: string, count: number) => { status: number; body?: unknown } | 'hang',
  sampleTypes: string[] = allTypes,
) {
  const recorded: Recorded = { messageBodies: [], tasks: [], slices: [] }
  let seq = 0
  const summary = { id: chatId, title: '上传', chatType: 'general', status: 'active', createdAt: timestamp, updatedAt: timestamp }
  const message = (role: string, content: string, extra: unknown[] = []) => ({
    id: `d9345da6-998b-4462-a539-${String(++seq).padStart(12, '0')}`,
    seq, role, status: 'completed', content,
    parts: [{ type: 'text', order: 0, text: content }, ...extra],
    createdAt: timestamp, vote: null, executionSteps: [],
  })
  await page.route('**/ai-chatbot/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/requests')) return route.fulfill({ json: { requests: [] } })
    if (path.endsWith('/me')) return route.fulfill({ json: { id: 'u', externalUserId: 'u', externalTeamId: 'team-1', userName: 'demo', realName: '演示用户', name: '演示用户' } })
    if (path.endsWith('/gpas/upload/sample-types')) return route.fulfill({ json: { initialized: sampleTypes !== allTypes, types: sampleTypes } })
    if (path.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } })
    if (path.endsWith('/conversations')) return route.fulfill({ json: { conversations: [summary] } })
    if (path.endsWith('/artifacts')) return route.fulfill({ json: { artifacts: [] } })
    if (path.endsWith(`/conversations/${chatId}`)) return route.fulfill({ json: { ...summary, messages: [], pageInfo: { hasMore: false, beforeSeq: null }, activeGeneration: null } })
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const body = request.postDataJSON()
      recorded.messageBodies.push(body)
      const userMessage = message('user', body.content, body.uploads ? [{ type: 'gpas_upload', order: 1, batch: body.uploads }] : [])
      const assistantMessage = message('assistant', '已收到上传结果。')
      return route.fulfill({ status: 202, json: { id: `ticket-${seq}`, status: 'succeeded', result: { kind: 'business', userMessage, assistantMessage }, error: null } })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route('**/api/gpas2/v1/file/**', async (route) => {
    const request = route.request()
    const url = request.url()
    if (url.endsWith('/file/task')) {
      recorded.tasks.push(request.postDataJSON())
      return route.fulfill({ json: { code: 200, message: 'ok', data: `single-${recorded.tasks.length}` } })
    }
    if (url.endsWith('/file/dual/task')) {
      const body = request.postDataJSON()
      recorded.tasks.push(body)
      return route.fulfill({ json: { code: 200, message: 'ok', data: {
        groupId: 'group-1',
        fileList: [...body.files].reverse().map((file: { name: string }, index: number) => ({ fileId: `dual-${file.name}`, name: file.name, endType: String(index) })),
      } } })
    }
    recorded.slices.push(new URL(url).pathname)
    const result = slice(url, recorded.slices.length)
    if (result === 'hang') return
    return route.fulfill({ status: result.status, json: result.body ?? { code: 200, message: 'ok', data: 'ok' } })
  })
  return recorded
}

const composer = (page: Page) => page.getByPlaceholder('继续提问，或补充更多上下文')
const fileInput = (page: Page) => page.locator('input[type=file]')

test('more than ten files are refused with a link to the GPAS upload page', async ({ page }) => {
  await mockApis(page, () => ({ status: 200 }))
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles(Array.from({ length: 11 }, (_, index) => upload(`s${index}.fq`, fastq(`S${index}`, null))))
  const alert = page.getByRole('alert').filter({ hasText: '单次最多上传 10 个文件' })
  await expect(alert).toBeVisible()
  await expect(alert.getByRole('link')).toHaveAttribute('href', /\/app\/upload$/)
  await expect(page.getByTestId('gpas-upload-file')).toHaveCount(0)
})

test('pairs files, uploads after send with one retried chunk, then sends results to the agent', async ({ page }) => {
  const recorded = await mockApis(page, (_url, count) => (count === 1 ? { status: 503 } : { status: 200 }))
  await page.addInitScript(() => localStorage.setItem('pollingGate_demo_team-1', '{"isEligible":false}'))
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles([upload('demo_R1.fq', fastq('D', 1)), upload('solo.fastq', fastq('O', null))])
  await fileInput(page).setInputFiles([upload('demo_R2.fq', fastq('D', 2))])
  await expect(page.getByText('双端 R1 · 第 1 组')).toBeVisible()
  await expect(page.getByText('双端 R2 · 第 1 组')).toBeVisible()
  await expect(page.getByText('单端', { exact: true })).toBeVisible()

  await composer(page).fill('帮我确认这批文件')
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
  await page.getByRole('radio', { name: '临床样本' }).click()
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('已收到上传结果。')).toBeVisible()
  expect(recorded.messageBodies).toHaveLength(1)
  const body = recorded.messageBodies[0]
  expect(body.content).toBe('帮我确认这批文件')
  expect(body.uploads.sampleType).toBe('clinic')
  expect(body.uploads.items).toEqual([
    expect.objectContaining({ name: 'demo_R1.fq', layout: 'paired', role: 'R1', pairKey: 'P1', status: 'uploaded', fileId: 'dual-demo_R1.fq', groupId: 'group-1' }),
    expect.objectContaining({ name: 'demo_R2.fq', layout: 'paired', role: 'R2', pairKey: 'P1', status: 'uploaded', fileId: 'dual-demo_R2.fq' }),
    expect.objectContaining({ name: 'solo.fastq', layout: 'single', status: 'uploaded', fileId: 'single-2' }),
  ])
  expect(recorded.slices.filter(path => path.includes('/file/dual/upload/'))).toHaveLength(3) // one retried
  expect(recorded.slices.filter(path => path.includes('/file/upload/'))).toHaveLength(1)
  await expect(page.getByTestId('gpas-upload-summary')).toContainText('上传成功 3/3')
  expect(await page.evaluate(() => localStorage.getItem('pollingGate_demo_team-1'))).toBeNull()
})

test('an expired session stops the upload and sends nothing', async ({ page }) => {
  const recorded = await mockApis(page, () => ({ status: 401 }))
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles([upload('only.fq', fastq('A', null))])
  await page.getByRole('radio', { name: '环境样本' }).click()
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '登录已失效' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试失败文件' })).toHaveCount(0)
  expect(recorded.messageBodies).toHaveLength(0)
  expect(recorded.slices).toHaveLength(1)
})

test('cancelling keeps the typed text and selection, and sends nothing', async ({ page }) => {
  const recorded = await mockApis(page, () => 'hang')
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles([upload('slow.fq', fastq('W', null))])
  await composer(page).fill('先别发')
  await page.getByRole('radio', { name: '实验室样本' }).click()
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: '取消上传' }).click()
  await expect(page.getByRole('button', { name: '取消上传' })).toHaveCount(0)
  await expect(composer(page)).toHaveValue('先别发')
  await expect(page.getByTestId('gpas-upload-file')).toHaveCount(1)
  expect(recorded.messageBodies).toHaveLength(0)
})

test('the tray sits above the input, offers only planned sample types and explains a blocked send', async ({ page }) => {
  await mockApis(page, () => ({ status: 200 }), ['clinic', 'environment'])
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles([upload('a.fq', fastq('A', null)), upload('b.fq', fastq('B', null))])
  await expect(page.getByTestId('gpas-upload-file')).toHaveCount(2)

  const tray = page.getByTestId('gpas-upload-tray')
  const trayBox = (await tray.boundingBox())!
  const inputBox = (await composer(page).boundingBox())!
  expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(inputBox.y + 1)
  const lastFile = (await page.getByTestId('gpas-upload-file').last().boundingBox())!
  const typeRow = (await page.getByTestId('gpas-sample-types').boundingBox())!
  expect(typeRow.y).toBeGreaterThanOrEqual(lastFile.y + lastFile.height)

  await expect(page.getByRole('radio')).toHaveText(['临床样本', '环境样本'])
  const send = page.getByRole('button', { name: '发送' })
  await expect(send).toBeDisabled()
  await send.hover({ force: true })
  await expect(page.getByRole('tooltip')).toHaveText('请先选择样本类型')
  await page.getByRole('radio', { name: '环境样本' }).click()
  await expect(send).toBeEnabled()
})

test('a single planned sample type is selected automatically', async ({ page }) => {
  await mockApis(page, () => ({ status: 200 }), ['lab'])
  await page.goto(`/ai-chatbot/${chatId}`)
  await fileInput(page).setInputFiles([upload('a.fq', fastq('A', null))])
  await expect(page.getByRole('radio', { name: '实验室样本' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
})

const rawBrief = JSON.parse(readFileSync(new URL('./fixtures/gpas-brief.json', import.meta.url), 'utf8'))
type RawCategory = { microbialType: string; microbialName: string; microbialNum: number; maxHazandIndex: number; topInfos: Array<Record<string, any>> | null }
const toBrief = (categories: RawCategory[]) => ({
  categories: categories.map((category) => ({
    type: category.microbialType, name: category.microbialName, speciesCount: category.microbialNum, maxHazard: category.maxHazandIndex,
    top: (category.topInfos ?? []).map((item) => ({
      cnName: item.taxCnName, enName: item.taxEnName, taxId: item.taxId, abundancePct: Number.parseFloat(item.abundance), hazard: item.hazardIndex,
    })),
  })),
  totalReads: 38959015, dataVolume: 10677513218, tools: ['Guardian'],
})
const card = (fileId: string, brief: unknown, analysisId: string | null = null) => ({
  groupId: 'g-1', paired: true, files: [{ fileId, fileName: `${fileId}_R1.fq.gz`, sizeBytes: 8 * 1024 ** 3 }, { fileId: `${fileId}-2`, fileName: `${fileId}_R2.fq.gz`, sizeBytes: 7 * 1024 ** 3 }],
  sampleType: 'clinic', status: 'uploaded', analysisStatus: brief ? 'success' : 'running', metaStatus: 'missing', uploadTime: '2026-01-06 20:54:10', analysisId, brief,
})

async function showCards(page: Page, cards: unknown[]) {
  await mockApis(page, () => ({ status: 200 }))
  await page.route(`**/ai-chatbot/api/conversations/${chatId}`, (route) => route.fulfill({ json: {
    id: chatId, title: '上传', chatType: 'general', status: 'active', createdAt: timestamp, updatedAt: timestamp,
    pageInfo: { hasMore: false, beforeSeq: null }, activeGeneration: null,
    messages: [
      { id: 'e9345da6-998b-4462-a539-000000000001', seq: 1, role: 'user', status: 'completed', content: '查一下', parts: [], createdAt: timestamp, vote: null, executionSteps: [] },
      { id: 'e9345da6-998b-4462-a539-000000000002', seq: 2, role: 'assistant', status: 'completed', content: '这批文件的分析摘要如下。',
        parts: [{ type: 'text', order: 0, text: '这批文件的分析摘要如下。' }, { type: 'gpas', order: 1, files: cards }],
        createdAt: timestamp, vote: null, executionSteps: [] },
    ],
  } }))
  await page.goto(`/ai-chatbot/${chatId}`)
  await expect(page.getByTestId('gpas-file-cards').first()).toBeVisible()
}

test('analysis cards describe the brief as a per-category top-5 summary with species shares', async ({ page }) => {
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo))])
  const first = page.getByTestId('gpas-file-card').first()
  await expect(first.getByTestId('gpas-brief-category')).toHaveCount(3)
  await expect(first).toContainText('细菌 · 检出 188 种 · 占比 95.4%')
  await expect(first).toContainText('病毒 · 检出 4 种 · 占比 2%')
  await expect(first.getByText('丰度前 3', { exact: true })).toHaveCount(3)
  await expect(first.getByTestId('gpas-brief-rest').first()).toContainText('其它 185 种')
  await expect(first).toContainText('未检出：动物等')
  await expect(first.getByRole('img', { name: '危害等级 3' }).first()).toBeVisible()
  await expect(first).toContainText('38.96M Reads')
  await expect(first).toContainText('26/01/06 20:54')
  await expect(page.getByText(/Count\/mL/)).toHaveCount(0)
})

test('a single sample without a brief says so on its card', async ({ page }) => {
  await showCards(page, [card('s2', null)])
  await expect(page.getByTestId('gpas-file-card')).toContainText('暂无分析摘要')
  await expect(page.getByTestId('gpas-file-table')).toHaveCount(0)
})

test('several samples are listed in one table with a composition bar per sample', async ({ page }) => {
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo), 'task-1'), card('s2', null)])
  await expect(page.getByTestId('gpas-file-card')).toHaveCount(0)
  const table = page.getByTestId('gpas-file-table')
  await expect(table).toContainText('病原体分类分布 · 2 个样本')
  await expect(table.getByRole('columnheader')).toHaveText(['样本', '物种组成', '检出种数', '最高风险', 'Reads', '操作'])
  const rows = table.getByTestId('gpas-file-row')
  await expect(rows).toHaveCount(2)
  // Bacteria, viral, fungi in their fixed category order; 动物等 (0 species) has no segment.
  const segments = rows.first().getByTestId('gpas-composition-segment')
  await expect(segments).toHaveCount(3)
  await expect(segments.first()).toHaveAttribute('title', '细菌 188 种 · 95.4%')
  await expect(rows.first()).toContainText('197')
  await expect(rows.first().getByRole('img', { name: '危害等级 3' })).toBeVisible()
  await expect(rows.first()).toContainText('38.96M')
  await expect(rows.first().getByTestId('gpas-view-detail')).toBeVisible()
  await expect(rows.nth(1)).toContainText('暂无分析摘要')
  await expect(rows.nth(1).getByTestId('gpas-view-detail')).toHaveCount(0)
  if (process.env.SHOTS) await table.screenshot({ path: `${process.env.SHOTS}/file-table.png` })

  // The table's 查看详情 asks for the detail like the card does.
  const sent: unknown[] = []
  await page.route('**/ai-chatbot/api/conversations/*/messages', async (route) => {
    sent.push(route.request().postDataJSON().detail)
    await route.fulfill({ status: 500, json: {} })
  })
  await rows.first().getByTestId('gpas-view-detail').click()
  await expect.poll(() => sent).toEqual([{ taskId: 'task-1' }])
})

test('the sample table fits a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo), 'task-1'), card('s2', null)])
  await expect(page.getByTestId('gpas-file-table')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('more than five detected categories fold into one "其他" block', async ({ page }) => {
  const names = ['细菌', '病毒', '真菌', '古菌', '寄生虫', '动物等', '其他真核']
  const categories = names.map((name, index) => ({
    microbialType: `t${index}`, microbialName: name, microbialNum: 70 - index * 10, maxHazandIndex: 1,
    topInfos: [{ taxCnName: `${name}甲`, taxEnName: '', taxId: String(index), abundance: '40%', hazardIndex: 1 }],
  }))
  await showCards(page, [card('s1', toBrief(categories))])
  const blocks = page.getByTestId('gpas-brief-category')
  await expect(blocks).toHaveCount(5)
  await expect(blocks.last()).toContainText('其他 · 3 类 · 占比 21.4%')
  await expect(blocks.last()).toContainText('寄生虫 · 检出 30 种 · 10.7%')
  await expect(blocks.last()).toContainText('其他真核 · 检出 10 种 · 3.6%')
})

test('analysis cards fit a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo))])
  const overflow = await page.getByTestId('gpas-file-card').first().evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

const resultRow = (index: number, speciesType: string, page: number) => ({
  id: `${speciesType}-${page}-${index}`, taskId: 'task-1', speciesType: speciesType || 'bacteria',
  taxCname: `物种${page}-${index}`, taxEname: `Species ${page}-${index}`, coverage: `${(index * 3.7).toFixed(1)}%`,
  coverageUrl: index === 0 ? 'https://gpas.example/cov.png' : null, colonization: index === 0 ? '定植' : '', colonizationE: '',
  color: '#2c7378', barcodeId: 'B01', taxId: String(1177574 + index), hazardIndex: index % 6, coverageValue: (index * 3.7) / 100,
  selfAlignRatio: 1, onlyMatching: 10 + index * 20, unifPvalue: 12.94, abundance: index === 0 ? 0.005 : index * 0.2, ani95SpeciesNums: index % 3,
})

test('"查看详情" asks for the analysis detail and the panel pages each category on demand', async ({ page }) => {
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo), 'task-1')])
  const queries: Array<Record<string, string>> = []
  await page.route('**/ai-chatbot/api/gpas/file/results**', async (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams)
    queries.push(query)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const pageNumber = Number(query.page)
    const speciesType = query.speciesType ?? ''
    const total = speciesType ? 3 : 45
    const count = speciesType ? 3 : pageNumber < 3 ? 20 : 5
    await route.fulfill({ json: {
      taskId: 'task-1', speciesType: speciesType || null, page: pageNumber, pageSize: 20, total, totalPage: Math.ceil(total / 20),
      rows: Array.from({ length: count }, (_, index) => resultRow(index, speciesType, pageNumber)),
    } })
  })
  const sent: Array<Record<string, unknown>> = []
  await page.route('**/ai-chatbot/api/conversations/*/messages', async (route) => {
    const body = route.request().postDataJSON()
    sent.push({ content: body.content, detail: body.detail })
    const message = (id: string, role: string, content: string, extra: unknown[] = []) => ({
      id, seq: 3, role, status: 'completed', content, parts: [{ type: 'text', order: 0, text: content }, ...extra],
      createdAt: timestamp, vote: null, executionSteps: [],
    })
    await route.fulfill({ status: 202, json: { id: 'ticket-1', status: 'succeeded', error: null, result: {
      kind: 'business',
      userMessage: message('e9345da6-998b-4462-a539-000000000003', 'user', body.content, [{ type: 'gpas_detail', order: 1, taskId: body.detail.taskId }]),
      assistantMessage: message('e9345da6-998b-4462-a539-000000000004', 'assistant', '样本 task-1 共检出 45 条物种结果。',
        [{ type: 'gpas', order: 1, result: { taskId: 'task-1', total: 45 } }]),
    } } })
  })

  await page.getByTestId('gpas-view-detail').click()
  // The analysis id travels in `detail`; the bubble shows only the fixed text.
  await expect.poll(() => sent).toEqual([{ content: '通过分析ID查看样本详情', detail: { taskId: 'task-1' } }])
  await expect(page.getByText('通过分析ID查看样本详情', { exact: true })).toBeVisible()
  await expect(page.getByText(/task-1/).filter({ hasText: '查看' })).toHaveCount(0)

  // The reply opens the panel; tabs are the card's detected categories.
  const panel = page.getByTestId('gpas-result-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab')).toHaveText(['全部', '细菌', '病毒', '真菌'])
  await expect(panel.getByTestId('gpas-result-skeleton')).toBeVisible()
  await expect(panel.getByTestId('gpas-result-row')).toHaveCount(20)
  // Statistics from the card's briefAnalysis.
  await expect(panel.getByTestId('gpas-stat-species')).toContainText('197')
  await expect(panel.getByTestId('gpas-stat-legend')).toContainText('细菌')
  await expect(panel.getByTestId('gpas-stat-legend')).toContainText('95.4%')
  // The donut stands alone (no ring around it); top species are plain list rows.
  await expect(panel.getByTestId('gpas-stat-donut')).toBeVisible()
  expect(await panel.getByTestId('gpas-stat-donut').evaluate((svg) => getComputedStyle(svg.parentElement!).backgroundImage)).toBe('none')
  // Each category's most abundant species, in the tab order.
  const topRows = panel.getByTestId('gpas-stat-top').getByRole('listitem')
  await expect(topRows).toHaveCount(3)
  await expect(topRows.nth(0)).toContainText('空肠普雷沃菌')
  await expect(topRows.nth(0)).toContainText('细菌')
  await expect(topRows.nth(1)).toContainText('甲型流感病毒')
  await expect(topRows.nth(2)).toContainText('不完全链格孢')
  // The species table.
  await expect(panel.getByRole('columnheader')).toHaveText(['序号', '生物学编号', '物种名称', '定植特性', '风险分级', '覆盖度', '可信度'])
  await expect(panel.getByTestId('gpas-result-index').first()).toHaveText('1')
  await expect(panel.getByTestId('gpas-result-row').nth(3)).toContainText('1177577')
  await expect(panel.getByTestId('gpas-hazard-stars').first()).toHaveAttribute('aria-label', '危害等级 1')
  if (process.env.SHOTS) {
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${process.env.SHOTS}/table.png` })
  }

  // The mini radar opens the full evidence radar.
  await panel.getByRole('button', { name: '查看 物种1-0 证据雷达' }).click()
  const dialog = page.getByRole('dialog', { name: '物种1-0 物种证据雷达' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('gpas-evidence-radar')).toContainText('DETECTED', { ignoreCase: true })
  await expect(dialog.getByTestId('gpas-radar-value')).toHaveText(['1', '0', '10', '12.94', '<0.01%', '0'])
  for (const name of ['物种自比对率', '基因组覆盖度', '唯一匹配 Reads', '基因组均一度', '样本内物种丰度', '物种混淆度']) {
    await expect(dialog.getByText(name).first()).toBeVisible()
  }
  if (process.env.SHOTS) {
    await dialog.screenshot({ path: `${process.env.SHOTS}/radar.png` })
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '查看 物种1-0 证据雷达' })).toBeFocused()
  await expect(panel.getByRole('tab', { name: /全部/ })).toContainText('45')
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('1 / 3')
  await expect(panel.getByRole('link', { name: '覆盖度图' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(queries).toEqual([{ taskId: 'task-1', page: '1', pageSize: '20' }])

  await panel.getByRole('button', { name: '下一页' }).click()
  await expect(panel.getByTestId('gpas-result-skeleton')).toBeVisible()
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('2 / 3')
  await expect(panel.getByText('物种2-0', { exact: true })).toBeVisible()
  await expect(panel.getByTestId('gpas-result-index').first()).toHaveText('21')

  await panel.getByRole('tab', { name: '病毒' }).click()
  await expect(panel.getByTestId('gpas-result-row')).toHaveCount(3)
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('1 / 1')

  // Pages already seen come from the cache.
  await panel.getByRole('tab', { name: /全部/ }).click()
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('2 / 3')
  expect(queries).toEqual([
    { taskId: 'task-1', page: '1', pageSize: '20' },
    { taskId: 'task-1', page: '2', pageSize: '20' },
    { taskId: 'task-1', speciesType: 'viral', page: '1', pageSize: '20' },
  ])

  // The entry card reopens the panel on the same tab and page, from the cache.
  const requestsBefore = queries.length
  await page.getByRole('button', { name: 'Close Artifact panel' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByTestId('gpas-result-entry').click()
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('2 / 3')
  await expect(panel.getByRole('tab', { name: /全部/ })).toHaveAttribute('aria-selected', 'true')

  // Clicking 查看详情 again on the same card opens the loaded detail: no new message.
  await page.getByRole('button', { name: 'Close Artifact panel' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('gpas-view-detail')).toHaveAttribute('title', '打开已加载的分析详情')
  await page.getByTestId('gpas-view-detail').click()
  await expect(panel.getByTestId('gpas-result-page')).toHaveText('2 / 3')
  expect(sent).toHaveLength(1)
  expect(queries).toHaveLength(requestsBefore)
})

test('cards without an analysis id have no detail button', async ({ page }) => {
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo))])
  await expect(page.getByTestId('gpas-file-card')).toHaveCount(1)
  await expect(page.getByTestId('gpas-view-detail')).toHaveCount(0)
})

test('the analysis detail panel fits a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await mockApis(page, () => ({ status: 200 }))
  await page.route(`**/ai-chatbot/api/conversations/${chatId}`, (route) => route.fulfill({ json: {
    id: chatId, title: '详情', chatType: 'general', status: 'active', createdAt: timestamp, updatedAt: timestamp,
    pageInfo: { hasMore: false, beforeSeq: null }, activeGeneration: null,
    messages: [
      { id: 'e9345da6-998b-4462-a539-000000000001', seq: 1, role: 'user', status: 'completed', content: '查看样本:task-1分析详情', parts: [], createdAt: timestamp, vote: null, executionSteps: [] },
      { id: 'e9345da6-998b-4462-a539-000000000002', seq: 2, role: 'assistant', status: 'completed', content: '详情如下。',
        parts: [
          { type: 'text', order: 0, text: '详情如下。' },
          { type: 'gpas', order: 1, files: [card('s1', toBrief(rawBrief.microbialInfo), 'task-1')], result: { taskId: 'task-1', total: 3 } },
        ],
        createdAt: timestamp, vote: null, executionSteps: [] },
    ],
  } }))
  await page.route('**/ai-chatbot/api/gpas/file/results**', (route) => route.fulfill({ json: {
    taskId: 'task-1', speciesType: null, page: 1, pageSize: 20, total: 3, totalPage: 1,
    rows: Array.from({ length: 3 }, (_, index) => resultRow(index, '', 1)),
  } }))
  await page.goto(`/ai-chatbot/${chatId}`)
  await page.getByTestId('gpas-result-entry').click()
  const panel = page.getByTestId('gpas-result-panel')
  await expect(panel.getByTestId('gpas-result-row')).toHaveCount(3)
  await expect(panel.getByTestId('gpas-brief-stats')).toBeVisible()
  // Narrow: the 生物学编号 column folds under the name; the table scrolls inside its own box.
  await expect(panel.getByRole('columnheader')).toHaveCount(6)
  await expect(panel.getByTestId('gpas-result-row').first()).toContainText('1177574')
  const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  if (process.env.SHOTS) {
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${process.env.SHOTS}/panel-mobile.png` })
  }
})

test('a typed sample-name request opens the detail panel when the reply lands, history does not', async ({ page }) => {
  await showCards(page, [card('s1', toBrief(rawBrief.microbialInfo), 'task-1')])
  await page.route('**/ai-chatbot/api/gpas/file/results**', (route) => route.fulfill({ json: {
    taskId: 'task-1', speciesType: null, page: 1, pageSize: 20, total: 3, totalPage: 1,
    rows: Array.from({ length: 3 }, (_, index) => resultRow(index, '', 1)),
  } }))
  await page.route('**/ai-chatbot/api/conversations/*/messages', async (route) => {
    const body = route.request().postDataJSON()
    const message = (id: string, role: string, content: string, extra: unknown[] = []) => ({
      id, seq: 3, role, status: 'completed', content, parts: [{ type: 'text', order: 0, text: content }, ...extra],
      createdAt: timestamp, vote: null, executionSteps: [],
    })
    expect(body.detail).toBeUndefined()
    await route.fulfill({ status: 202, json: { id: 'ticket-2', status: 'succeeded', error: null, result: {
      kind: 'business',
      userMessage: message('e9345da6-998b-4462-a539-000000000005', 'user', body.content),
      assistantMessage: message('e9345da6-998b-4462-a539-000000000006', 'assistant', 's1 共检出 3 条物种结果。',
        [{ type: 'gpas', order: 1, result: { taskId: 'task-1', total: 3 } }]),
    } } })
  })
  // History alone never opens the panel.
  await expect(page.getByTestId('gpas-result-panel')).toHaveCount(0)

  await composer(page).fill('查看样本 s1 分析结果')
  await page.getByRole('button', { name: '发送' }).click()
  const panel = page.getByTestId('gpas-result-panel')
  await expect(panel.getByTestId('gpas-result-row')).toHaveCount(3)
  // The sample name stands in for the analysis id.
  await expect(page.getByRole('heading', { name: 's1 分析详情' })).toBeVisible()
  await expect(page.getByTestId('gpas-result-entry')).toContainText('s1 分析详情')
  await expect(page.getByTestId('gpas-result-entry')).not.toContainText('task-1')
})
