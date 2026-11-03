import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import type { Database } from './db.js'
import type { GenerationService } from './generation.js'
import type { GenerationStreamHub } from './streamStore.js'
import type { RedisClient } from './cache.js'

test('all Fastify route schemas compile at startup', async () => {
  const app = await buildApp({
    config: {
      nodeEnv: 'test',
      serveClient: false,
      gpas2AuthMode: 'mock',
    } as AppConfig,
    database: {} as Database,
    redis: {} as RedisClient,
    generations: {} as GenerationService,
    streamHub: {} as GenerationStreamHub,
    objectStore: null,
    artifactService: null,
  })

  try {
    await app.ready()
    const routes = app.printRoutes()
    assert.match(routes, /ai-chatbot\/api\//)
    assert.match(routes, /conversations/)
    assert.match(routes, /generations/)

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/ai-chatbot/api/conversations',
      payload: { title: '' },
    })
    assert.equal(invalidBody.statusCode, 400)
    assert.equal(invalidBody.json().error.code, 'invalid_request')

    const invalidId = await app.inject({
      method: 'POST',
      url: '/ai-chatbot/api/conversations',
      payload: { id: 'not-a-uuid', title: 'x' },
    })
    assert.equal(invalidId.statusCode, 400)

    const invalidParams = await app.inject({
      method: 'GET',
      url: '/ai-chatbot/api/conversations/not-a-uuid',
    })
    assert.equal(invalidParams.statusCode, 400)

    const health = await app.inject({
      method: 'GET',
      url: '/ai-chatbot/api/health',
    })
    assert.equal(health.statusCode, 503)
    assert.equal(health.json().dependencies.postgres, 'unavailable')
    assert.equal(health.json().dependencies.worker, 'unavailable')
  } finally {
    await app.close()
  }
})

test('an overloaded database pool sheds new requests with 503 but keeps health checks', async () => {
  const pool = { waitingCount: 0 }
  const app = await buildApp({
    config: {
      nodeEnv: 'test',
      serveClient: false,
      gpas2AuthMode: 'mock',
      loadShedEventLoopMs: 0,
      loadShedPoolWaiting: 10,
    } as AppConfig,
    database: { $client: pool } as unknown as Database,
    redis: {} as RedisClient,
    generations: {} as GenerationService,
    streamHub: {} as GenerationStreamHub,
    objectStore: null,
    artifactService: null,
  })
  try {
    await app.ready()
    const request = () => app.inject({ method: 'POST', url: '/ai-chatbot/api/conversations', payload: { title: '' } })
    assert.equal((await request()).statusCode, 400, 'accepted (and validated) while the pool is idle')
    pool.waitingCount = 11
    // A queue that just formed is absorbed...
    assert.equal((await request()).statusCode, 400, 'a brief pool queue is not shed')
    // ...one that persists for over a second is shed.
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    const shed = await request()
    assert.equal(shed.statusCode, 503)
    assert.equal(shed.headers['retry-after'], '2')
    assert.equal(shed.json().error.code, 'overloaded')
    const health = await app.inject({ method: 'GET', url: '/ai-chatbot/api/health' })
    assert.notEqual(health.json().error?.code, 'overloaded', 'health is never shed')
  } finally {
    await app.close()
  }
})
