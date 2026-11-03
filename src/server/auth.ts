import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

import { redisKey, type RedisClient } from './cache.js'
import type { AppConfig } from './config.js'
import { syncUser, type Database } from './db.js'
import type { CurrentUser, Gpas2UserInfo } from './domain.js'

type Gpas2UserInfoResponse = {
  code: number
  message?: string
  data?: Gpas2UserInfo
}

export class AuthenticationError extends Error {
  statusCode: number
  code: string

  constructor(message: string, statusCode = 401, code = 'unauthorized') {
    super(message)
    this.name = 'AuthenticationError'
    this.statusCode = statusCode
    this.code = code
  }
}

export const mockUserInfoResponse: Gpas2UserInfoResponse = {
  code: 200,
  message: 'get user info success',
  data: {
    userId: 'user-00000000000000000000000000000001',
    realName: '演示用户',
    userName: '100001',
    ownteamId: 'team-00000000000000000000000000000001',
    ownteamName: '演示团队',
    email: 'demo.user@example.com',
    emailBindStatus: 0,
    phone: '13800000000',
    phoneBindStatus: 0,
    status: 0,
    jobTitle: '研究员',
    natureId: '1',
    role: 1,
    sex: 0,
    correspondenceAddress: '',
    mark: '',
    workUnit: '',
    researchField: '',
    lastIP: '192.0.2.10',
    lastUA:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    lastLogin: '2026-07-30T11:15:40+08:00',
    comment: '',
    display: '',
    createTime: '2026-04-15T17:36:32+08:00',
    updateTime: '2026-07-30T11:15:40+08:00',
  },
}

export async function loadProfile(
  request: FastifyRequest,
  config: AppConfig,
): Promise<Gpas2UserInfo> {
  if (config.gpas2AuthMode === 'mock') {
    return mockUserInfoResponse.data as Gpas2UserInfo
  }

  const cookie = request.headers.cookie

  if (!cookie) {
    throw new AuthenticationError('GPAS2 session cookie is missing')
  }

  let response: Response

  try {
    response = await fetch(config.gpas2UserInfoUrl as string, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AuthenticationError(
      'GPAS2 user service is unavailable',
      502,
      'identity_upstream_unavailable',
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError('GPAS2 session is invalid')
  }

  if (!response.ok) {
    throw new AuthenticationError(
      'GPAS2 user service returned an error',
      502,
      'identity_upstream_error',
    )
  }

  let payload: Gpas2UserInfoResponse

  try {
    payload = (await response.json()) as Gpas2UserInfoResponse
  } catch {
    throw new AuthenticationError(
      'GPAS2 user response is invalid',
      502,
      'identity_invalid_response',
    )
  }

  if (payload.code !== 200 || !payload.data?.userId) {
    throw new AuthenticationError('GPAS2 session is invalid')
  }

  if (payload.data.status !== 0) {
    throw new AuthenticationError(
      'GPAS2 account is not active',
      403,
      'account_inactive',
    )
  }

  return payload.data
}

function authCacheKey(request: FastifyRequest, config: AppConfig): string {
  const credential = config.gpas2AuthMode === 'mock'
    ? 'mock'
    : request.headers.cookie ?? ''
  const digest = createHash('sha256').update(credential).digest('hex')
  return redisKey(config, `auth:user:${digest}`)
}

/**
 * Ticket polling, SSE and page loads all authenticate. Without a cache each one
 * costs a GPAS round trip plus a `User` UPSERT, which dominated the PostgreSQL
 * pool under load. A revoked session may stay valid for AUTH_CACHE_TTL_SECONDS;
 * durable ingress always re-validates the stored cookie before side effects.
 */
/**
 * A small in-process copy of the identity cache: it keeps authentication off
 * GPAS and PostgreSQL when Redis is slow or down, and lets concurrent requests
 * for the same session share one lookup.
 */
const LOCAL_AUTH_CACHE_LIMIT = 2_000
const localAuthCache = new Map<string, { user: CurrentUser; expiresAt: number }>()
const inflightAuth = new Map<string, Promise<CurrentUser>>()

function readLocalAuth(key: string): CurrentUser | null {
  const entry = localAuthCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    localAuthCache.delete(key)
    return null
  }
  return entry.user
}

function writeLocalAuth(key: string, user: CurrentUser, ttlSeconds: number): void {
  localAuthCache.delete(key)
  localAuthCache.set(key, { user, expiresAt: Date.now() + ttlSeconds * 1_000 })
  if (localAuthCache.size > LOCAL_AUTH_CACHE_LIMIT) {
    localAuthCache.delete(localAuthCache.keys().next().value!)
  }
}

export async function resolveCurrentUser(
  request: FastifyRequest,
  config: AppConfig,
  database: Database,
  redis?: RedisClient,
): Promise<CurrentUser> {
  const ttl = config.authCacheTtlSeconds ?? 0
  const cacheable = ttl > 0 &&
    (config.gpas2AuthMode === 'mock' || Boolean(request.headers.cookie))
  if (!cacheable) return syncUser(database, await loadProfile(request, config))
  const key = authCacheKey(request, config)

  const local = readLocalAuth(key)
  if (local) return local
  const inflight = inflightAuth.get(key)
  if (inflight) return inflight

  const lookup = (async () => {
    if (redis?.isReady) {
      const cached = await redis.get(key).catch(() => null)
      if (cached) {
        try {
          const user = JSON.parse(cached) as CurrentUser
          writeLocalAuth(key, user, ttl)
          return user
        } catch {
          // Fall through to the authoritative path.
        }
      }
    }
    const profile = await loadProfile(request, config)
    const user = await syncUser(database, profile)
    writeLocalAuth(key, user, ttl)
    if (redis?.isReady) {
      await redis.set(key, JSON.stringify(user), { EX: ttl }).catch(() => undefined)
    }
    return user
  })()
  inflightAuth.set(key, lookup)
  try {
    return await lookup
  } finally {
    inflightAuth.delete(key)
  }
}

/** For tests: forget cached identities. */
export function clearLocalAuthCache(): void {
  localAuthCache.clear()
}
