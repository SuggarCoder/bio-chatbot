import { expect, test } from '@playwright/test'

const timestamp = '2026-08-02T00:00:00.000Z'

const summaries = [
  {
    id: 'conversation-a',
    title: 'Conversation A',
    chatType: 'general',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: 'conversation-b',
    title: 'Conversation B',
    chatType: 'general',
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
    pageInfo: { hasMore: false, beforeSeq: null },
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
        serviceTier: 'free',
        schedulingWeight: 1,
        generationConcurrencyLimit: 1,
        maxQueuedGenerations: 5,
      } })
      return
    }
    if (pathname.endsWith('/api/conversations')) {
      await route.fulfill({ json: { conversations: summaries } })
      return
    }
    const match = pathname.match(/\/api\/conversations\/(conversation-[ab])$/)
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
  const conversationLink = page.locator(
    'a[href="/ai-chatbot/conversation-b"]',
  )
  await expect(conversationLink).toBeVisible()
  await expect.poll(async () => (
    (await conversationLink.boundingBox())?.height ?? 0
  )).toBeGreaterThanOrEqual(60)
  const linkBox = await conversationLink.boundingBox()
  await conversationLink.click({
    position: {
      x: 8,
      y: (linkBox?.height ?? 60) - 4,
    },
  })

  await expect(page).toHaveURL(/\/ai-chatbot\/conversation-b$/)
  await expect(page.getByText('Message from B')).toBeVisible()
  await expect(page.getByText('Message from A')).toHaveCount(0)
  expect(detailRequests).toEqual(['conversation-a', 'conversation-b'])
})

test('a rejected generation start retries the original request instead of regenerating a local placeholder', async ({ page }) => {
  const chatId = '11111111-1111-4111-8111-111111111111'
  const generationId = '22222222-2222-4222-8222-222222222222'
  const streamId = '33333333-3333-4333-8333-333333333333'
  const userMessageId = '44444444-4444-4444-8444-444444444444'
  const assistantMessageId = '55555555-5555-4555-8555-555555555555'
  const generationBodies: Array<Record<string, unknown>> = []
  const idempotencyKeys: string[] = []
  const regenerateRequests: string[] = []

  await page.route('**/ai-chatbot/api/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
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
        serviceTier: 'free',
        schedulingWeight: 1,
        generationConcurrencyLimit: 1,
        maxQueuedGenerations: 5,
      } })
      return
    }
    if (pathname.endsWith('/api/conversations') && request.method() === 'GET') {
      await route.fulfill({ json: { conversations: [] } })
      return
    }
    if (pathname.endsWith('/api/conversations') && request.method() === 'POST') {
      await route.fulfill({ json: {
        id: chatId,
        title: 'Retry this request',
        chatType: 'general',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      } })
      return
    }
    if (pathname.endsWith(`/api/conversations/${chatId}/messages`)) {
      generationBodies.push(request.postDataJSON() as Record<string, unknown>)
      idempotencyKeys.push(request.headers()['idempotency-key'] ?? '')
      if (generationBodies.length === 1) {
        await route.fulfill({
          status: 429,
          json: { error: {
            code: 'generation_concurrency_exceeded',
            message: 'Another generation is already running',
          } },
        })
        return
      }
      await route.fulfill({
        status: 201,
        json: {
          generation: {
            id: generationId,
            chatId,
            streamId,
            status: 'created',
            effectiveStatus: 'created',
            cancelRequestedAt: null,
            cancelSource: null,
          },
          assistantMessageId,
          userMessage: {
            id: userMessageId,
            seq: 1,
            role: 'user',
            status: 'completed',
            content: 'Retry this request',
            parts: [{ type: 'text', order: 0, text: 'Retry this request' }],
            createdAt: timestamp,
            vote: null,
            executionSteps: [],
          },
          replacesMessageId: null,
        },
      })
      return
    }
    if (pathname.includes('/api/messages/') && pathname.endsWith('/regenerations')) {
      regenerateRequests.push(pathname)
      await route.fulfill({ status: 404, json: { error: {
        code: 'message_not_found',
        message: 'Assistant message not found',
      } } })
      return
    }
    if (pathname.endsWith(`/api/generations/${generationId}/stream`)) {
      const identity = { generationId, streamId, messageId: assistantMessageId }
      const userMessage = {
        id: userMessageId,
        seq: 1,
        role: 'user',
        status: 'completed',
        content: 'Retry this request',
        parts: [{ type: 'text', order: 0, text: 'Retry this request' }],
        createdAt: timestamp,
        vote: null,
        executionSteps: [],
      }
      const assistantMessage = {
        id: assistantMessageId,
        seq: 2,
        role: 'assistant',
        status: 'completed',
        content: 'Recovered answer',
        parts: [{ type: 'text', order: 0, text: 'Recovered answer' }],
        createdAt: timestamp,
        vote: null,
        executionSteps: [],
      }
      const events = [
        { ...identity, eventId: 1, type: 'message.start', userMessage },
        { ...identity, eventId: 2, type: 'message.delta', sequence: 1, startIndex: 0, delta: 'Recovered answer' },
        { ...identity, eventId: 3, type: 'message.finish', finishReason: 'stop', assistantMessage },
      ]
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events.map((event, index) => (
          `id: 1-${index}\ndata: ${JSON.stringify(event)}\n\n`
        )).join(''),
      })
      return
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } })
  })

  await page.goto('/ai-chatbot/')
  const composer = page.locator('textarea').first()
  await composer.fill('Retry this request')
  await composer.press('Enter')

  await expect(page.getByText('Another generation is already running')).toBeVisible()
  await page.locator('button:has(.i-lucide-refresh-cw)').click()

  await expect(page.getByText('Recovered answer')).toBeVisible()
  expect(generationBodies).toHaveLength(2)
  expect(generationBodies[0].clientMessageId).toBeUndefined()
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0])
  expect(regenerateRequests).toEqual([])
})
