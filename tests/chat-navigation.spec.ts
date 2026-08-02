import { expect, test } from '@playwright/test'

const timestamp = '2026-08-02T00:00:00.000Z'

const summaries = [
  {
    id: 'conversation-a',
    title: 'Conversation A',
    chatType: 'chat',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: 'conversation-b',
    title: 'Conversation B',
    chatType: 'chat',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
]

function detail(id: 'conversation-a' | 'conversation-b') {
  const suffix = id === 'conversation-a' ? 'A' : 'B'
  return {
    ...summaries.find((summary) => summary.id === id),
    messages: [{
      id: `message-${suffix.toLowerCase()}`,
      seq: 1,
      role: 'assistant',
      status: 'completed',
      content: `Message from ${suffix}`,
      parts: [{ type: 'text', order: 0, text: `Message from ${suffix}` }],
      createdAt: timestamp,
      vote: null,
      executionSteps: [],
    }],
    activeGeneration: null,
  }
}

test('switching directly between sessions loads the destination messages', async ({ page }) => {
  const detailRequests: string[] = []
  await page.route('**/ai-chatbot/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/api/health')) {
      await route.fulfill({ json: {
        status: 'ok',
        service: 'ai-chatbot',
        commit: 'test',
        time: timestamp,
      } })
      return
    }
    if (pathname.endsWith('/api/me')) {
      await route.fulfill({ json: {
        id: 'test-user',
        externalUserId: 'test-user',
        externalTeamId: null,
        realName: 'Test User',
        userName: 'tester',
        jobTitle: null,
        researchField: null,
        email: 'test@example.com',
        name: 'Test User',
        image: null,
        gpas2Role: null,
      } })
      return
    }
    if (pathname.endsWith('/api/chats')) {
      await route.fulfill({ json: { chats: summaries } })
      return
    }
    const match = pathname.match(/\/api\/chats\/(conversation-[ab])$/)
    if (match) {
      detailRequests.push(match[1])
      if (match[1] === 'conversation-b') {
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      await route.fulfill({
        json: detail(match[1] as 'conversation-a' | 'conversation-b'),
      })
      return
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } })
  })

  await page.goto('/ai-chatbot/conversation-a')
  await expect(page.getByText('Message from A')).toBeVisible()

  const sidebar = page.locator('aside').first()
  await sidebar.getByAltText('GPAS').first().click()
  await page.getByText('Conversation B', { exact: true }).click()

  await expect(page).toHaveURL(/\/ai-chatbot\/conversation-b$/)
  await expect(page.getByText('Message from B')).toBeVisible()
  await expect(page.getByText('Message from A')).toHaveCount(0)
  expect(detailRequests).toEqual(['conversation-a', 'conversation-b'])
})
