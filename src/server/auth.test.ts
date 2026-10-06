import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { FastifyRequest } from 'fastify'

import {
  AuthenticationError,
  loadProfile,
  mockUserInfoResponse,
  resolveCurrentUser,
} from './auth.js'
import type { RedisClient } from './cache.js'
import type { Database } from './db.js'
import type { CurrentUser } from './domain.js'
import type { AppConfig } from './config.js'

function config(
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    requestEncryptionKey: Buffer.alloc(32).toString('base64'), ingressConcurrency: 8, plannerConcurrency: 4, upstreamConcurrency: 8, upstreamRequestsPerMinute: 0, upstreamTokensPerMinute: 0,
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 8090,
    serveClient: false,
    databaseUrl: 'postgres://test',
    pgPoolMax: 4,
    authCacheTtlSeconds: 0,
    redisUrl: 'redis://test',
    redisPrefix: 'gpas2cb:test:v3:',
    qwenApiKey: 'test',
    qwenBaseUrl: 'https://example.test/v1',
    qwenModel: 'qwen3.6-flash',
    qwenTokenizerPath: 'models/qwen-tokenizer',
    qwenContextWindowTokens: 1_000_000,
    qwenMaxInputTokens: 991_808,
    qwenMaxOutputTokens: 4096,
    chatHistoryTokenBudget: 131_072,
    chatSummaryTokenBudget: 8_192,
    summaryTriggerTokens: 16_384,
    instructionsTokenBudget: 32_768,
    artifactProtocolTokenBudget: 4_096,
    artifactOutlineTokenBudget: 8_192,
    artifactFragmentTokenBudget: 16_384,
    contextMemoryEnabled: false,
    userMemoryEnabled: false,
    artifactContextV2Enabled: false,
    artifactPatchEnabled: false,
    backgroundModel: 'qwen3.6-flash',
    backgroundMaxOutputTokens: 4_096,
    backgroundConcurrency: 1,
    backgroundTimeoutMs: 120_000,
    embeddingModelPath: 'models/bge-small-zh-v1.5',
    gpas2AuthMode: 'mock',
    chatRateLimitPerMinute: 10,
    monthlyTokenLimit: 0,
    globalGenerationConcurrency: 4,
    providerGenerationConcurrency: 4,
    modelGenerationConcurrency: 4,
    generationTimeoutMs: 180_000,
    generationLockLeaseMs: 30_000,
    generationLockRenewIntervalMs: 10_000,
    generationCancelPollIntervalMs: 300,
    generationSnapshotIntervalMs: 1_000,
    artifactProtocolEnabled: false,
    objectStorage: {
      enabled: false,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 3,
    },
    ...overrides,
  }
}

function request(cookie?: string): FastifyRequest {
  return {
    headers: cookie ? { cookie } : {},
  } as FastifyRequest
}

test('mock identity returns the configured GPAS2 user', async () => {
  const profile = await loadProfile(request(), config())

  assert.equal(
    profile.userId,
    mockUserInfoResponse.data?.userId,
  )
  assert.equal(profile.realName, '郑书发')
})

test('upstream identity requires a GPAS2 cookie', async () => {
  await assert.rejects(
    loadProfile(
      request(),
      config({
        gpas2AuthMode: 'upstream',
        gpas2UserInfoUrl: 'https://gpas.example.test/api/gpas2/v1/user/info',
      }),
    ),
    (error: unknown) =>
      error instanceof AuthenticationError &&
      error.statusCode === 401,
  )
})

test('upstream identity forwards the original cookie', async () => {
  const originalFetch = globalThis.fetch
  let forwardedCookie: string | null = null

  globalThis.fetch = async (_input, init) => {
    forwardedCookie = new Headers(init?.headers).get('cookie')
    return new Response(
      JSON.stringify(mockUserInfoResponse),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )
  }

  try {
    const profile = await loadProfile(
      request('gpas_session=opaque-value'),
      config({
        gpas2AuthMode: 'upstream',
        gpas2UserInfoUrl: 'https://gpas.example.test/api/gpas2/v1/user/info',
      }),
    )

    assert.equal(forwardedCookie, 'gpas_session=opaque-value')
    assert.equal(
      profile.userId,
      mockUserInfoResponse.data?.userId,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upstream identity rejects an inactive GPAS2 account', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ...mockUserInfoResponse,
        data: {
          ...mockUserInfoResponse.data,
          status: 1,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )

  try {
    await assert.rejects(
      loadProfile(
        request('gpas_session=opaque-value'),
        config({
          gpas2AuthMode: 'upstream',
          gpas2UserInfoUrl:
            'https://gpas.example.test/api/gpas2/v1/user/info',
        }),
      ),
      (error: unknown) =>
        error instanceof AuthenticationError &&
        error.statusCode === 403 &&
        error.code === 'account_inactive',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

function memoryRedis(ready = true) {
  const values = new Map<string, string>()
  const redis = {
    isReady: ready,
    async get(key: string) { return values.get(key) ?? null },
    async set(key: string, value: string) { values.set(key, value); return 'OK' },
  } as unknown as RedisClient
  return { redis, values }
}

const cachedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  externalUserId: 'cached-user',
  generationConcurrencyLimit: 3,
} as CurrentUser

test('cached identity skips the GPAS round trip and the user upsert', async () => {
  const { redis, values } = memoryRedis()
  const upstream = config({
    gpas2AuthMode: 'upstream',
    gpas2UserInfoUrl: 'https://gpas.example.test/api/gpas2/v1/user/info',
    authCacheTtlSeconds: 30,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('GPAS must not be called on a cache hit') }
  try {
    const key = `gpas2cb:test:v3:auth:user:${createHash('sha256')
      .update('gpas_session=a').digest('hex')}`
    values.set(key, JSON.stringify(cachedUser))
    const user = await resolveCurrentUser(
      request('gpas_session=a'),
      upstream,
      {} as Database,
      redis,
    )
    assert.deepEqual(user, cachedUser)

    // A different session must never reuse another cookie's cached identity.
    await assert.rejects(resolveCurrentUser(
      request('gpas_session=b'),
      upstream,
      {} as Database,
      redis,
    ), (error: unknown) => error instanceof AuthenticationError && error.statusCode === 502)

    // Redis unavailable: fall back to the authoritative path instead of the cache.
    await assert.rejects(resolveCurrentUser(
      request('gpas_session=a'),
      upstream,
      {} as Database,
      memoryRedis(false).redis,
    ), (error: unknown) => error instanceof AuthenticationError && error.statusCode === 502)
  } finally {
    globalThis.fetch = originalFetch
  }
})
