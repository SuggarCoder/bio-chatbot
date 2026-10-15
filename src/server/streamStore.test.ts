import assert from 'node:assert/strict'
import test from 'node:test'

import type { RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import type { StreamEvent } from './domain.js'
import {
  GenerationStreamHub,
  GenerationStreamStore,
  generationStreamKey,
} from './streamStore.js'

type Entry = {
  id: string
  message: { event: string }
}

class FakeRedis {
  isOpen = true
  isReady = true
  entries = new Map<string, Entry[]>()
  expirations = new Map<string, number>()
  published: Array<{ channel: string; payload: string }> = []
  private sequence = 0
  private subscriptions = new Map<string, (payload: string) => void>()

  duplicate() {
    const owner = this
    return {
      isOpen: false,
      on() {},
      async connect() {
        this.isOpen = true
      },
      async subscribe(channel: string, callback: (payload: string) => void) {
        owner.subscriptions.set(channel, callback)
      },
      async close() {
        this.isOpen = false
      },
    }
  }

  async xAdd(
    key: string,
    _id: string,
    message: { event: string },
  ): Promise<string> {
    this.sequence += 1
    const id = `${1_000 + this.sequence}-0`
    const entries = this.entries.get(key) ?? []
    entries.push({ id, message })
    this.entries.set(key, entries)
    return id
  }

  async xRange(
    key: string,
    start: string,
    _end: string,
    options: { COUNT: number },
  ): Promise<Entry[]> {
    const exclusive = start.startsWith('(') ? start.slice(1) : null
    const entries = this.entries.get(key) ?? []
    const filtered = exclusive
      ? entries.filter((entry) => entry.id !== exclusive && entry.id > exclusive)
      : entries
    return filtered.slice(0, options.COUNT)
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.expirations.set(key, seconds)
    return true
  }

  async exists(key: string): Promise<number> {
    return this.entries.has(key) ? 1 : 0
  }

  async publish(channel: string, payload: string): Promise<number> {
    this.published.push({ channel, payload })
    this.subscriptions.get(channel)?.(payload)
    return 1
  }
}

const config = {
  redisPrefix: 'test:v3:',
} as unknown as AppConfig

function deltaEvent(eventId: number, delta: string): StreamEvent {
  return {
    type: 'message.delta',
    generationId: '11111111-1111-4111-8111-111111111111',
    streamId: 'logical-stream',
    messageId: '22222222-2222-4222-8222-222222222222',
    eventId,
    sequence: eventId,
    startIndex: eventId - 1,
    delta,
  }
}

test('native Redis stream uses a user-scoped key and terminal retention', async () => {
  const redis = new FakeRedis()
  const store = new GenerationStreamStore(
    config,
    redis as unknown as RedisClient,
  )
  const userId = '33333333-3333-4333-8333-333333333333'
  const generationId = '11111111-1111-4111-8111-111111111111'
  const key = generationStreamKey(config, userId, generationId)

  const firstId = await store.append(userId, generationId, deltaEvent(1, 'A'))
  assert.equal(firstId, '1001-0')
  assert.equal(key, `test:v3:stream:${userId}:${generationId}`)
  assert.equal(redis.expirations.get(key), 60 * 60)

  await store.append(userId, generationId, {
    type: 'message.finish',
    generationId,
    streamId: 'logical-stream',
    messageId: '22222222-2222-4222-8222-222222222222',
    eventId: 2,
    finishReason: 'error',
    assistantMessage: null,
    error: { code: 'failed', message: 'failed' },
  })
  assert.equal(redis.expirations.get(key), 30 * 60)
  assert.equal(redis.published.at(-1)?.channel, 'test:v3:stream:events')
})

test('stream hub resumes strictly after the Redis Stream cursor', async () => {
  const redis = new FakeRedis()
  const client = redis as unknown as RedisClient
  const store = new GenerationStreamStore(config, client)
  const hub = new GenerationStreamHub(config, client)
  const userId = '33333333-3333-4333-8333-333333333333'
  const generationId = '11111111-1111-4111-8111-111111111111'
  const firstId = await store.append(userId, generationId, deltaEvent(1, 'A'))
  await hub.start()
  await store.append(userId, generationId, {
    type: 'message.finish',
    generationId,
    streamId: 'logical-stream',
    messageId: '22222222-2222-4222-8222-222222222222',
    eventId: 2,
    finishReason: 'stop',
    assistantMessage: null,
  })
  const reader = hub.subscribe(userId, generationId, firstId).getReader()

  const chunk = await reader.read()
  assert.equal(chunk.done, false)
  assert.match(chunk.value ?? '', /^id: 1002-0/m)
  assert.match(chunk.value ?? '', /"type":"message.finish"/)
  assert.equal((await reader.read()).done, true)
  await hub.close()
})

test('SSE JSON round trip preserves real newlines in deltas', async () => {
  const redis = new FakeRedis()
  const client = redis as unknown as RedisClient
  const store = new GenerationStreamStore(config, client)
  const hub = new GenerationStreamHub(config, client)
  const userId = '33333333-3333-4333-8333-333333333333'
  const generationId = '11111111-1111-4111-8111-111111111111'
  const delta = 'first line\n  indented line'

  await store.append(userId, generationId, deltaEvent(1, delta))
  const reader = hub.subscribe(userId, generationId).getReader()
  const chunk = await reader.read()
  const data = chunk.value
    ?.split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length)

  assert.ok(data)
  const event = JSON.parse(data) as StreamEvent
  assert.equal(event.type, 'message.delta')
  if (event.type === 'message.delta') assert.equal(event.delta, delta)
  await reader.cancel()
  await hub.close()
})

test('independent catch-up cursors never advance another subscriber', async () => {
  const redis = new FakeRedis()
  const pending: Array<(entries: Entry[]) => void> = []
  redis.xRange = async () => new Promise<Entry[]>(resolve => pending.push(resolve))
  const hub = new GenerationStreamHub(config, redis as unknown as RedisClient)
  const a = hub.subscribe('u', 'g', '1002-0').getReader()
  const b = hub.subscribe('u', 'g', '0-0').getReader()
  const entry = (n: number): Entry => ({ id: `${1000 + n}-0`, message: { event: JSON.stringify(deltaEvent(n, String(n))) } })
  try {
    pending[0]([entry(3)])
    await new Promise(resolve => setImmediate(resolve))
    pending[1]([entry(1), entry(2), entry(3)])
    await new Promise(resolve => setImmediate(resolve))
    assert.match((await a.read()).value ?? '', /^id: 1003-0/)
    for (const n of [1, 2, 3]) assert.match((await b.read()).value ?? '', new RegExp(`^id: ${1000 + n}-0`))
  } finally { await a.cancel(); await b.cancel(); await hub.close() }
})

test('100 SSE subscribers discover a durable terminal with no finish in Redis', async () => {
  const redis = new FakeRedis()
  let terminal = false
  let reads = 0
  const hub = new GenerationStreamHub(config, redis as unknown as RedisClient, async (_user, generationId) => {
    reads += 1
    return terminal ? {
      type: 'message.finish', generationId, streamId: 's', messageId: 'm', eventId: 0,
      finishReason: 'error', assistantMessage: null,
      error: { code: 'generation_interrupted', message: 'Worker interrupted' },
    } : null
  }, 1)
  const readers = Array.from({ length: 100 }, (_, n) => hub.subscribe(`u${n}`, `g${n}`).getReader())
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    terminal = true
    // Redis is unavailable too; periodic SQL reconciliation must still work.
    redis.xRange = async () => { throw new Error('offline') }
    // Hub timers are deliberately unref'ed; keep this isolated test alive.
    await new Promise(resolve => setTimeout(resolve, 2_100))
    const results = await Promise.all(readers.map(reader => reader.read()))
    assert.equal(results.length, 100)
    for (const result of results) assert.match(result.value ?? '', /generation_interrupted/)
    for (const reader of readers) assert.equal((await reader.read()).done, true)
    assert.ok(reads >= 200)
  } finally { await hub.close() }
})

test('terminal database checks are coalesced for multiple tabs of one generation', async () => {
  const redis = new FakeRedis()
  let reads = 0
  const hub = new GenerationStreamHub(config, redis as unknown as RedisClient, async () => { reads += 1; return null })
  const readers = Array.from({ length: 10 }, () => hub.subscribe('u', 'g').getReader())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
  await Promise.all(readers.map(reader => reader.cancel()))
  await hub.close()
})
