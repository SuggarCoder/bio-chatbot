import { expect, test, type Page } from '@playwright/test'

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
