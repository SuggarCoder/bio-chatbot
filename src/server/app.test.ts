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
      trustedProxyCidrs: false,
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

test('client IP headers are accepted only from a trusted proxy', async () => {
  const app = await buildApp({
    config: {
      nodeEnv: 'test',
      serveClient: false,
      trustedProxyCidrs: '10.0.0.10',
      gpas2AuthMode: 'mock',
    } as AppConfig,
    database: {} as Database,
    redis: {} as RedisClient,
    generations: {} as GenerationService,
    streamHub: {} as GenerationStreamHub,
    objectStore: null,
    artifactService: null,
  })

  app.get('/test-client-ip', async (request) => ({ ip: request.ip }))

  try {
    const proxied = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    })
    assert.equal(proxied.json().ip, '198.51.100.20')

    const spoofed = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '203.0.113.30',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    })
    assert.equal(spoofed.json().ip, '203.0.113.30')
  } finally {
    await app.close()
  }
})
