import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatApiError, createGeneration, fetchChat, parseApiError, retryRequest } from './chatApi'

test('lost acceptance response retries the same key, then polls durable completion', async context => {
  let posts = 0
  const keys: string[] = []
  const result = { kind: 'business', userMessage: { id: 'user' }, assistantMessage: { id: 'assistant' } }
  context.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; keys.push(new Headers(init.headers).get('Idempotency-Key')!)
      if (posts === 1) throw new TypeError('API restarted after database commit')
      return Response.json({ id: 'ticket', status: 'queued', result: null, error: null }, { status: 202 })
    }
    return Response.json({ id: 'ticket', status: 'succeeded', result, error: null })
  })
  assert.deepEqual(await createGeneration('chat', { content: 'hello', clientMessageId: 'stable-key' }), result)
  assert.deepEqual(keys, ['stable-key', 'stable-key'])
})
test('conversation reload discovers pending durable requests before loading messages', async context => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    const path = String(input); paths.push(path)
    if (path.endsWith('/conversations/chat/requests')) return Response.json({ requests: [{ id: 'ticket', status: 'running' }] })
    if (path.endsWith('/requests/ticket')) return Response.json({ id: 'ticket', status: 'succeeded', result: { kind: 'business' } })
    return Response.json({ id: 'chat', messages: [{ id: 'saved' }] })
  })
  assert.equal((await fetchChat('chat')).messages[0].id, 'saved')
  assert.equal(paths.length, 3)
  assert.ok(paths[1].endsWith('/requests/ticket'))
})
test('retries are bounded and stop at client errors', async () => {
  let calls = 0
  await assert.rejects(retryRequest(async () => {
    calls++
    throw new ChatApiError(503, 'unavailable', 'down')
  }, { baseMs: 1, capMs: 1 }), { status: 503 })
  assert.equal(calls, 6)

  calls = 0
  await assert.rejects(retryRequest(async () => {
    calls++
    throw new ChatApiError(409, 'conflict', 'no')
  }, { baseMs: 1 }), { status: 409 })
  assert.equal(calls, 1)
})
test('a retry waits at least the Retry-After the server sent', async () => {
  let calls = 0
  const started = Date.now()
  await assert.rejects(retryRequest(async () => {
    calls++
    throw await parseApiError(new Response(
      JSON.stringify({ error: { code: 'busy', message: 'busy' } }),
      { status: 503, headers: { 'retry-after': '0.3' } },
    ))
  }, { maxAttempts: 2, baseMs: 1, capMs: 1 }), { status: 503, retryAfterMs: 300 })
  assert.equal(calls, 2)
  assert.ok(Date.now() - started >= 290, 'waited for Retry-After')
})
test('an aborted request stops retrying at once', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = retryRequest(async () => {
    calls++
    if (calls === 1) setTimeout(() => controller.abort(), 10)
    throw new TypeError('network down')
  }, { signal: controller.signal, baseMs: 60_000, capMs: 60_000, random: () => 1 })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
})
