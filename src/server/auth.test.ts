import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastifyRequest } from 'fastify'

import {
  AuthenticationError,
  loadProfile,
  mockUserInfoResponse,
} from './auth.js'
import type { AppConfig } from './config.js'

function config(
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 8090,
    serveClient: false,
    trustedProxyCidrs: false,
    databaseUrl: 'postgres://test',
    pgPoolMax: 4,
    redisUrl: 'redis://test',
    redisPrefix: 'gpas2cb:test:v3:',
    qwenApiKey: 'test',
    qwenBaseUrl: 'https://example.test/v1',
    qwenModel: 'qwen3.6-flash',
    qwenMaxOutputTokens: 4096,
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
