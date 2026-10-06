import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeneration, fetchChat } from './chatApi'

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
