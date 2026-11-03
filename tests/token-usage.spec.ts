import { expect, test, type Page } from '@playwright/test'

const timestamp = '2026-11-12T02:00:00.000Z'

const quota = (overrides: Record<string, unknown> = {}) => ({
  weekly: { used: 720_000, limit: 1_000_000, percent: 72, resetsAt: '2026-11-15T16:00:00.000Z' },
  monthly: { used: 2_240_000, limit: 4_000_000, percent: 56, resetsAt: '2026-11-30T16:00:00.000Z' },
  resetVouchers: 2,
  lastResetAt: null,
  ...overrides,
})

async function mockApi(page: Page, onReset: () => void, quotaDelayMs: () => number = () => 0) {
  await page.route('**/ai-chatbot/api/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith('/requests')) return route.fulfill({ json: { requests: [] } })
    if (pathname.endsWith('/api/health')) {
      return route.fulfill({ json: { status: 'ok', service: 'ai-chatbot', commit: 'test', time: timestamp } })
    }
    if (pathname.endsWith('/api/me')) {
      return route.fulfill({ json: {
        id: 'test-user', externalUserId: 'test-user', externalTeamId: null,
        realName: '张三', userName: 'tester', jobTitle: null, researchField: null,
        email: 'test@example.com', name: '张三', image: null, gpas2Role: null,
        serviceTier: 'free', schedulingWeight: 1, generationConcurrencyLimit: 1, maxQueuedGenerations: 5,
      } })
    }
    if (pathname.endsWith('/api/conversations')) return route.fulfill({ json: { conversations: [] } })
    if (pathname.endsWith('/api/usage/quota') && request.method() === 'GET') {
      const delay = quotaDelayMs()
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      return route.fulfill({ json: quota() }).catch(() => undefined)
    }
    if (pathname.endsWith('/api/usage/quota/reset') && request.method() === 'POST') {
      onReset()
      return route.fulfill({ json: quota({
        weekly: { used: 0, limit: 1_000_000, percent: 0, resetsAt: '2026-11-15T16:00:00.000Z' },
        monthly: { used: 0, limit: 4_000_000, percent: 0, resetsAt: '2026-11-30T16:00:00.000Z' },
        resetVouchers: 1,
        lastResetAt: timestamp,
      }) })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found' } } })
  })
}

async function openTokenUsage(page: Page) {
  await page.getByRole('button', { name: '打开账户菜单' }).first().click()
  await page.getByText('Tokens 使用量').first().click()
  return page.getByRole('dialog', { name: 'Token 使用量' })
}

/** Waits for the open animation, then reads the panel's box. */
async function settledBox(page: Page, dialog: ReturnType<Page['getByRole']>) {
  await page.waitForTimeout(350)
  const box = await dialog.boundingBox()
  if (!box) throw new Error('dialog has no box')
  return box
}

test('the card keeps its position and size while the usage loads', async ({ page }) => {
  await mockApi(page, () => undefined, () => 1_500)
  await page.goto('/ai-chatbot/')

  const dialog = await openTokenUsage(page)
  await expect(dialog).toHaveAttribute('aria-busy', 'true')
  const loading = await settledBox(page, dialog)
  await expect(dialog).toHaveAttribute('aria-busy', 'false', { timeout: 5_000 })
  const loaded = await settledBox(page, dialog)

  expect(Math.abs(loaded.y - loading.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(loaded.height - loading.height)).toBeLessThanOrEqual(1)
})

test('reopening shows the last usage at once while it refreshes', async ({ page }) => {
  let delay = 0
  await mockApi(page, () => undefined, () => delay)
  await page.goto('/ai-chatbot/')

  let dialog = await openTokenUsage(page)
  await expect(dialog.getByRole('progressbar', { name: '周限额已使用' })).toHaveAttribute('aria-valuenow', '72')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  delay = 10_000
  dialog = await openTokenUsage(page)
  await expect(dialog.getByRole('progressbar', { name: '周限额已使用' })).toHaveAttribute('aria-valuenow', '72', { timeout: 1_000 })
})

test('the account menu opens token usage, and a Reset 卷 resets both limits after confirmation', async ({ page }) => {
  let resets = 0
  await mockApi(page, () => { resets += 1 })
  await page.goto('/ai-chatbot/')

  const dialog = await openTokenUsage(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('progressbar', { name: '周限额已使用' })).toHaveAttribute('aria-valuenow', '72')
  await expect(dialog.getByRole('progressbar', { name: '月限额已使用' })).toHaveAttribute('aria-valuenow', '56')
  await expect(dialog.getByText('已用 72万 / 100万 · 11月16日 00:00 重置')).toBeVisible()
  await expect(dialog.getByText('Reset 卷可重置全部限制（周限额与月限额）。')).toBeVisible()

  if (process.env.TOKEN_USAGE_SCREENSHOT) {
    await dialog.screenshot({ path: process.env.TOKEN_USAGE_SCREENSHOT })
  }

  // Redemption needs an explicit confirmation; cancelling spends nothing.
  await dialog.getByRole('button', { name: /使用 Reset 卷/ }).click()
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(resets).toBe(0)

  await dialog.getByRole('button', { name: /使用 Reset 卷/ }).click()
  await dialog.getByRole('button', { name: '确认使用' }).click()
  await expect(dialog.getByText('已使用 1 张 Reset 卷，周限额与月限额已重置。')).toBeVisible()
  await expect(dialog.getByRole('progressbar', { name: '周限额已使用' })).toHaveAttribute('aria-valuenow', '0')
  expect(resets).toBe(1)
  // Nothing is used now, so another voucher would change nothing.
  await expect(dialog.getByRole('button', { name: /使用 Reset 卷/ })).toBeDisabled()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
