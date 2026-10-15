import { expect, test, type Page } from '@playwright/test'

const chatId = 'c9345da6-998b-4462-a539-2d803f184e26'
const timestamp = '2026-10-07T00:00:00.000Z'

async function showPart(page: Page, part: Record<string, unknown>) {
  const summary = { id: chatId, title: '卡片', chatType: 'general', status: 'active', createdAt: timestamp, updatedAt: timestamp }
  await page.route('**/ai-chatbot/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/requests')) return route.fulfill({ json: { requests: [] } })
    if (path.endsWith('/me')) return route.fulfill({ json: { id: 'u', externalUserId: 'u', externalTeamId: 'team-1', userName: 'demo', realName: '演示用户', name: '演示用户' } })
    if (path.endsWith('/gpas/upload/sample-types')) return route.fulfill({ json: { initialized: true, types: ['clinic'] } })
    if (path.endsWith('/conversations')) return route.fulfill({ json: { conversations: [summary] } })
    if (path.endsWith('/artifacts')) return route.fulfill({ json: { artifacts: [] } })
    if (path.endsWith(`/conversations/${chatId}`)) return route.fulfill({ json: {
      ...summary, pageInfo: { hasMore: false, beforeSeq: null }, activeGeneration: null,
      messages: [
        { id: 'f9345da6-998b-4462-a539-000000000001', seq: 1, role: 'user', status: 'completed', content: '查询', parts: [], createdAt: timestamp, vote: null, executionSteps: [] },
        { id: 'f9345da6-998b-4462-a539-000000000002', seq: 2, role: 'assistant', status: 'completed', content: '结果如下。',
          parts: [{ type: 'text', order: 0, text: '结果如下。' }, { type: 'gpas', order: 1, ...part }], createdAt: timestamp, vote: null, executionSteps: [] },
      ],
    } })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(`/ai-chatbot/${chatId}`)
}

const profile = { realName: '张三', userName: 'zhangsan', teamName: '病原监测组', jobTitle: '研究员', researchField: null, email: 'zs@example.com', phone: '13800000000' }

const counts = (clinic: number, media = 0, environment = 0, lab = 0) => ({ clinic, media, environment, lab })
const progress = {
  projectName: '2026 年度病原监测', teamName: '病原监测组', demo: false,
  samples: [
    { type: 'clinic', label: '临床样本', plan: 120, submitted: 86, remaining: 34, completionRate: 71.7 },
    { type: 'media', label: '虫媒样本', plan: 60, submitted: 64, remaining: 0, completionRate: 106.7 },
    { type: 'environment', label: '环境样本', plan: 0, submitted: 0, remaining: 0, completionRate: null },
    { type: 'lab', label: '实验室样本', plan: 40, submitted: 12, remaining: 28, completionRate: 30 },
  ],
  monthly: [
    { month: '2026-03', counts: counts(10, 8, 0, 2) },
    { month: '2026-04', counts: counts(14, 12, 0, 3) },
    { month: '2026-05', counts: counts(18, 14, 0, 2) },
    { month: '2026-06', counts: counts(20, 16, 0, 3) },
    { month: '2026-07', counts: counts(24, 14, 0, 2) },
  ],
}

test('the profile reply shows a card with the user, team and copyable contacts', async ({ page }) => {
  await showPart(page, { profile })
  const card = page.getByTestId('gpas-profile-card')
  await expect(card.getByRole('heading', { name: '张三' })).toBeVisible()
  await expect(card).toContainText('@zhangsan')
  await expect(card).toContainText('研究员')
  await expect(card).toContainText('病原监测组')
  await expect(card.getByTestId('gpas-profile-field').filter({ hasText: '研究方向' })).toContainText('未填写')
  await expect(card.getByRole('button', { name: '复制邮箱' })).toHaveCount(1)
  if (process.env.SHOTS) await card.screenshot({ path: `${process.env.SHOTS}/profile.png` })
})

test('the progress reply shows totals, a cumulative line chart and a table', async ({ page }) => {
  await showPart(page, { progress })
  const card = page.getByTestId('gpas-progress-card')
  await expect(card).toContainText('2026 年度病原监测')
  // 162 of 220 planned.
  await expect(card.getByTestId('gpas-progress-total')).toHaveText('73.6%')
  // One line per planned type; environment has no plan.
  await expect(card.getByTestId('gpas-progress-line')).toHaveCount(3)
  await expect(card.getByTestId('gpas-progress-end-label')).toHaveText(['● 临床 71.7%', '● 虫媒 106.7%', '● 实验室 30%'])
  await expect(card.getByTestId('gpas-progress-row')).toHaveCount(4)
  await expect(card.getByTestId('gpas-progress-row').nth(1)).toContainText('已完成')
  await expect(card.getByTestId('gpas-progress-row').nth(2)).toContainText('未设置计划')
  await expect(card.getByTestId('gpas-progress-totals')).toContainText('220')

  const chart = card.getByTestId('gpas-progress-chart').locator('svg')
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  const tooltip = card.getByTestId('gpas-progress-tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('2026-04')
  await expect(tooltip).toContainText('临床')
  if (process.env.SHOTS) {
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SHOTS}/progress.png`, fullPage: true })
  }
  await page.mouse.move(0, 0)
  await expect(tooltip).toHaveCount(0)
})

test('progress with a single month shows no chart, and both cards fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await showPart(page, { progress: { ...progress, monthly: progress.monthly.slice(0, 1) }, profile })
  await expect(page.getByTestId('gpas-progress-chart-empty')).toHaveText('暂无按月数据')
  await expect(page.getByTestId('gpas-profile-card')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/cards-mobile.png`, fullPage: true })
})
