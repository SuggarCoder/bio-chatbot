import { expect, test } from '@playwright/test'

test('query identity and progress, restore the form, validate and submit project initialization', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1080 })
  const chatId = 'a9345da6-998b-4462-a539-2d803f184e25'
  const timestamp = '2026-09-05T00:00:00.000Z'
  const summary = { id: chatId, title: '项目任务', chatType: 'general', status: 'active', createdAt: timestamp, updatedAt: timestamp }
  const messages: Record<string, unknown>[] = []
  let created = false
  let createCalls = 0
  let failNextCreate = true
  let seq = 0
  const message = (role: string, content: string, part?: Record<string, unknown>) => ({
    id: `b9345da6-998b-4462-a539-${String(++seq).padStart(12, '0')}`,
    seq, role, status: 'completed', content,
    parts: [{ type: 'text', order: 0, text: content }, ...(part ? [part] : [])],
    createdAt: timestamp, vote: null, executionSteps: [],
  })
  await page.route('**/ai-chatbot/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/me')) return route.fulfill({ json: { id: 'test-user', name: '演示用户', realName: '演示用户', externalUserId: 'test-user' } })
    if (path.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } })
    if (path.endsWith('/conversations')) return route.fulfill({ json: { conversations: [summary] } })
    if (path.endsWith('/artifacts')) return route.fulfill({ json: { artifacts: [] } })
    if (path.endsWith(`/conversations/${chatId}`)) return route.fulfill({ json: { ...summary, messages, pageInfo: { hasMore: false, beforeSeq: null }, activeGeneration: null } })
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const body = request.postDataJSON()
      let content = ''
      let part: Record<string, unknown> = { type: 'gpas', order: 1 }
      if (body.projectInput) {
        createCalls += 1
        expect(body.projectInput.samples).toEqual({ clinic: 100, media: 200, environment: 300, lab: 400 })
        expect(body.projectInput.projectName).toBe('新的项目名称')
        expect(body.projectInput).not.toHaveProperty('projectCode')
        expect(body.projectInput).not.toHaveProperty('ownTeamId')
        expect(body.projectInput.sourceMessageId).toBe(messages[3].id)
        if (failNextCreate) {
          failNextCreate = false
          return route.fulfill({ status: 502, json: { error: { code: 'gpas_unavailable', message: '项目服务暂时不可用，请重试。' } } })
        }
        created = true
        content = '项目初始化成功。'
      } else if (body.content === '我不能重新初始化这个项目吗？') {
        content = '当前系统不支持重新初始化项目。旧系统仅允许首次初始化。'
        part = { ...part, capability: { id: 'project.reinitialize', intent: 'ask_capability', outcome: 'answer' } }
      } else if (body.content === '我是谁') content = '当前用户：演示用户；团队：演示团队'
      else if (created) content = '临床样本 0/100；虫媒样本 0/200；环境样本 0/300；实验室样本 0/400'
      else {
        content = '你的团队尚未初始化项目。'
        part = { ...part, form: { projectCode: 'DEMO-001', projectName: '默认项目名称', phone: '13800000000', teamId: 'team-test' } }
      }
      const userMessage = message('user', body.content)
      const assistantMessage = message('assistant', content, part)
      messages.push(userMessage, assistantMessage)
      return route.fulfill({ status: 201, json: { kind: 'business', userMessage, assistantMessage } })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(`/ai-chatbot/${chatId}`)
  const composer = page.getByPlaceholder('继续提问，或补充更多上下文')
  await composer.fill('我是谁')
  await composer.press('Enter')
  await expect(page.getByText('当前用户：演示用户；团队：演示团队')).toBeVisible()
  await composer.fill('我的任务进度')
  await composer.press('Enter')
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('默认项目名称')
  await page.reload()
  await expect(page.getByLabel('项目编码')).toHaveValue('DEMO-001')
  await expect(page.getByLabel('项目编码')).toHaveAttribute('readonly', '')
  await page.getByLabel('项目名称', { exact: true }).fill('新的项目名称')
  await page.getByLabel('临床样本', { exact: true }).fill('-1')
  await page.getByRole('button', { name: '确认创建项目', exact: true }).click()
  expect(createCalls).toBe(0)
  for (const [name, count] of [['临床样本', 100], ['虫媒样本', 200], ['环境样本', 300], ['实验室样本', 400]] as const) {
    await page.getByLabel(name, { exact: true }).fill(String(count))
  }
  await page.screenshot({ path: 'dist/gpas-project-form.png', fullPage: true })
  await page.getByRole('button', { name: '确认创建项目', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('项目服务暂时不可用')
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('新的项目名称')
  await page.getByRole('button', { name: '确认创建项目', exact: true }).click()
  await expect(page.getByText('项目初始化成功。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '已处理', exact: true })).toBeDisabled()
  await composer.fill('我的任务进度')
  await composer.press('Enter')
  await expect(page.getByText('临床样本 0/100；虫媒样本 0/200；环境样本 0/300；实验室样本 0/400')).toBeVisible()
  await composer.fill('我不能重新初始化这个项目吗？')
  await composer.press('Enter')
  await expect(page.getByText('当前系统不支持重新初始化项目。旧系统仅允许首次初始化。', { exact: true })).toBeVisible()
  await expect(page.getByText('临床样本 0/100；虫媒样本 0/200；环境样本 0/300；实验室样本 0/400')).toHaveCount(1)
  await page.reload()
  await expect(page.getByText('当前系统不支持重新初始化项目。旧系统仅允许首次初始化。', { exact: true })).toBeVisible()
  expect(createCalls).toBe(2)
})
