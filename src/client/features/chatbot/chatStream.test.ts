import assert from 'node:assert/strict'
import test from 'node:test'

import { ChatApiError } from './chatApi'
import {
  reconnectDelay,
  runChatStream,
  transientRetryDelay,
  type ChatStreamEvent,
} from './chatStream'

const identity = { generationId: 'g1', streamId: 's1', messageId: 'm1' }

function sse(events: Array<{ id: string; data: object }>) {
  return new Response(
    events.map((event) => `id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function request(onEvent: (event: ChatStreamEvent) => void, states: string[] = []) {
  return {
    userId: 'u1',
    conversationId: 'c1',
    generationId: 'g1',
    streamId: 's1',
    signal: new AbortController().signal,
    onEvent,
    onConnectionState: (state: string) => states.push(state),
  }
}

test('reconnect delays keep the 1-2-4-5 s schedule, jittered', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((retry) => reconnectDelay(retry, () => 0.5)), [1_000, 2_000, 4_000, 5_000, 5_000])
  assert.equal(reconnectDelay(1, () => 0), 500)
  assert.equal(reconnectDelay(5, () => 0.999), 7_495)
})

test('transient stream failures use full jitter and honour Retry-After', () => {
  assert.equal(transientRetryDelay(0, undefined, () => 0.5), 500)
  assert.equal(transientRetryDelay(4, undefined, () => 0.999), 15_984)
  assert.equal(transientRetryDelay(9, undefined, () => 0.5), 8_000)
  assert.equal(transientRetryDelay(0, 7_000, () => 0.5), 7_000)
})

test('a 503 on the stream is retried, then the stream is consumed', async (context) => {
  context.mock.method(Math, 'random', () => 0)
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    if (calls <= 2) {
      return Response.json(
        { error: { code: 'redis_unavailable', message: 'down' } },
        { status: 503, headers: { 'retry-after': '0' } },
      )
    }
    return sse([
      { id: '1-1', data: { ...identity, eventId: 1, type: 'message.delta', sequence: 1, startIndex: 0, delta: 'Hel' } },
      // Coalesced deltas: one event, the first start index, the text concatenated.
      { id: '1-3', data: { ...identity, eventId: 3, type: 'message.delta', sequence: 3, startIndex: 3, delta: 'lo!' } },
      { id: '1-4', data: { ...identity, eventId: 4, type: 'message.finish', finishReason: 'stop', assistantMessage: null } },
    ])
  })
  const events: ChatStreamEvent[] = []
  const states: string[] = []
  await runChatStream(request((event) => events.push(event), states))
  assert.equal(calls, 3)
  assert.deepEqual(events.map((event) => event.type), ['message.delta', 'message.delta', 'message.finish'])
  assert.deepEqual(states, ['reconnecting', 'reconnecting', 'connected'])
})

test('a persistent 503 gives up after a bounded number of attempts', async (context) => {
  context.mock.method(Math, 'random', () => 0)
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return Response.json({ error: { code: 'redis_unavailable', message: 'down' } }, { status: 503 })
  })
  await assert.rejects(
    runChatStream(request(() => undefined)),
    (error) => error instanceof ChatApiError && error.status === 503,
  )
  assert.equal(calls, 7)
})

test('other HTTP errors are not retried', async (context) => {
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return Response.json({ error: { code: 'generation_not_found', message: 'gone' } }, { status: 404 })
  })
  await assert.rejects(runChatStream(request(() => undefined)), { status: 404 })
  assert.equal(calls, 1)
})
