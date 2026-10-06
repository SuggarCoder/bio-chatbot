import assert from 'node:assert/strict'
import test from 'node:test'
import { modelBudgetFetch, acquireModelPermit } from './modelBudget.js'
import type { AppConfig } from './config.js'
import type { RedisClient } from './cache.js'

for (const concurrency of [16, 32, 64, 100]) {
  test(`shared model budget bounds ${concurrency} simultaneous calls across independent clients`, async context => {
    const permits = new Set<string>()
    let peak = 0
    const redis = { eval: async (script: string, options: { arguments: string[] }) => {
      const [token, limit] = options.arguments
      if (script === acquireModelPermit) {
        if (permits.size >= Number(limit)) return 0
        permits.add(token); peak = Math.max(peak, permits.size); return 1
      }
      if (script.includes('ZREM')) { permits.delete(token); return 1 }
      return permits.has(token) ? 1 : 0
    } } as unknown as RedisClient
    context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      async start(controller) { await new Promise(r => setTimeout(r, 5)); controller.enqueue(new Uint8Array([65])); controller.close() },
    })))
    const config = { redisPrefix: 'test:', upstreamConcurrency: 8, upstreamRequestsPerMinute: 0 } as AppConfig
    const clients = [modelBudgetFetch(config, redis), modelBudgetFetch(config, redis), modelBudgetFetch(config, redis)]
    await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
      const response = await clients[i % 3]('https://model.invalid')
      assert.equal(await response.text(), 'A')
    }))
    assert.equal(peak, 8)
    assert.equal(permits.size, 0)
  })
}
test('a stream owns its model permit until cancelled, and provider failure releases it', async context => {
  let permits = 0
  const redis = { eval: async (script: string) => { if (script === acquireModelPermit) permits++; else if (script.includes('ZREM')) permits--; return 1 } } as unknown as RedisClient
  const limited = modelBudgetFetch({ redisPrefix: 'test:', upstreamConcurrency: 1 } as AppConfig, redis)
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream()))
  const response = await limited('https://model.invalid')
  assert.equal(permits, 1)
  await response.body!.cancel()
  assert.equal(permits, 0)
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  await assert.rejects(limited('https://model.invalid'), /offline/)
  assert.equal(permits, 0)
})

test('shared Redis Lua atomically enforces concurrency, RPM and token reservations', { skip: !process.env.TEST_REDIS_URL }, async () => {
  const { createClient } = await import('redis')
  const redis = createClient({ url: process.env.TEST_REDIS_URL })
  await redis.connect()
  const prefix = `model-budget-test:${crypto.randomUUID()}`
  const keys = [`${prefix}:active`, `${prefix}:rpm`, `${prefix}:tokens`, `${prefix}:total`]
  const acquire = (id: string, concurrency: number, rpm: number, tpm: number, tokens: number) => redis.eval(acquireModelPermit, { keys, arguments: [id, String(concurrency), String(rpm), String(tpm), String(tokens)] })
  try {
    assert.equal(await acquire('a', 1, 2, 100, 40), 1)
    assert.equal(await acquire('a', 1, 2, 100, 40), 1)
    assert.equal(await redis.get(keys[3]), '40')
    assert.equal(await acquire('b', 1, 2, 100, 40), 0)
    await redis.zRem(keys[0], 'a')
    assert.equal(await acquire('oversize', 1, 2, 100, 101), -1)
    assert.equal(await acquire('tokens', 1, 2, 100, 61), 0)
    assert.equal(await acquire('b', 1, 2, 100, 40), 1)
    await redis.zRem(keys[0], 'b')
    assert.equal(await acquire('rpm', 1, 2, 100, 1), 0)
    // Expire rate samples but preserve the hash: cleanup must clear reservations too.
    await redis.zAdd(keys[1], [{ score: 0, value: 'a' }, { score: 0, value: 'b' }])
    assert.equal(await acquire('c', 1, 2, 100, 100), 1)
  } finally { await redis.del(keys); await redis.close() }
})
