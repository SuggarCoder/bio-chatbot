import { createClient, type RedisClientType } from 'redis'

import type { AppConfig } from './config.js'
import { getMonthlyTokenUsage, type ChatContext, type Database } from './db.js'
import type { CurrentUser } from './domain.js'

export type RedisClient = RedisClientType

export function createRedisClient(config: AppConfig): RedisClient {
  const client = createClient({
    url: config.redisUrl,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        return Math.min(retries * 100, 3_000)
      },
    },
  })

  client.on('error', () => {
    // Health reporting and request-level fallbacks handle Redis failures.
  })

  return client
}

export function redisKey(config: AppConfig, key: string): string {
  return `${config.redisPrefix}${key}`
}

export async function cacheUserProfile(
  redis: RedisClient,
  config: AppConfig,
  user: CurrentUser,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  const values: Record<string, string> = {
    internalUserId: user.id,
    externalUserId: user.externalUserId,
    cachedAt: String(Math.floor(Date.now() / 1000)),
  }

  const optionalValues = {
    externalTeamId: user.externalTeamId,
    realName: user.realName,
    userName: user.userName,
    jobTitle: user.jobTitle,
    researchField: user.researchField,
    gpas2Role: user.gpas2Role === null ? null : String(user.gpas2Role),
    image: user.image,
  }

  for (const [key, value] of Object.entries(optionalValues)) {
    if (value !== null) {
      values[key] = value
    }
  }

  const key = redisKey(config, `user:profile:${user.externalUserId}`)
  await redis.hSet(key, values)
  await redis.expire(key, 30 * 60)
}

const rateLimitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`

export async function consumeGenerationRateLimit(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  ip: string,
): Promise<boolean> {
  if (!redis.isReady) {
    throw new Error('Redis is unavailable')
  }

  const window = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const userKey = redisKey(config, `rl:user:${userId}:req:${window}`)
  const ipKey = redisKey(config, `rl:ip:${ip}:req:${window}`)
  const [userCount, ipCount] = await Promise.all([
    redis.eval(rateLimitScript, {
      keys: [userKey],
      arguments: ['120'],
    }),
    redis.eval(rateLimitScript, {
      keys: [ipKey],
      arguments: ['120'],
    }),
  ])

  return (
    Number(userCount) <= config.chatRateLimitPerMinute &&
    Number(ipCount) <= config.chatRateLimitPerMinute * 5
  )
}

const acquireConcurrencyScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return 1
`

export async function acquireGenerationLease(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
): Promise<boolean> {
  if (!redis.isReady) {
    throw new Error('Redis is unavailable')
  }

  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + config.generationLeaseSeconds
  const key = redisKey(config, `concurrency:user:${userId}:generation`)
  const result = await redis.eval(acquireConcurrencyScript, {
    keys: [key],
    arguments: [
      String(now),
      String(config.maxConcurrentGenerations),
      String(expiresAt),
      generationId,
      String(config.generationLeaseSeconds * 2),
    ],
  })

  return Number(result) === 1
}

export async function renewGenerationLease(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  const key = redisKey(config, `concurrency:user:${userId}:generation`)
  const expiresAt = Math.floor(Date.now() / 1000) + config.generationLeaseSeconds
  await redis.zAdd(key, [{ score: expiresAt, value: generationId }])
  await redis.expire(key, config.generationLeaseSeconds * 2)
}

export async function releaseGenerationLease(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  await redis.zRem(
    redisKey(config, `concurrency:user:${userId}:generation`),
    generationId,
  )
}

function monthlyPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const expiresAt = new Date(end)
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 7)

  return {
    start,
    end,
    key: `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    ttlSeconds: Math.max(
      60,
      Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
    ),
  }
}

export async function readMonthlyQuota(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  userId: string,
): Promise<number> {
  if (!redis.isReady) {
    throw new Error('Redis is unavailable')
  }

  const period = monthlyPeriod()
  const key = redisKey(config, `quota:user:${userId}:${period.key}`)
  const cached = await redis.get(key)

  if (cached !== null) {
    return Number(cached)
  }

  const total = await getMonthlyTokenUsage(
    database,
    userId,
    period.start,
    period.end,
  )
  await redis.set(key, String(total), {
    EX: period.ttlSeconds,
  })
  return total
}

const applyQuotaScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`

export async function applyMonthlyQuota(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
  totalTokens: number,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  const period = monthlyPeriod()
  await redis.eval(applyQuotaScript, {
    keys: [
      redisKey(config, `quota:applied:${generationId}`),
      redisKey(config, `quota:user:${userId}:${period.key}`),
    ],
    arguments: [String(totalTokens), String(period.ttlSeconds)],
  })
}

export async function getCachedChatContext(
  redis: RedisClient,
  config: AppConfig,
  chatId: string,
  revision: number,
): Promise<ChatContext | null> {
  if (!redis.isReady) {
    return null
  }

  const value = await redis.get(
    redisKey(config, `chat:ctx:${chatId}:r${revision}`),
  )

  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as ChatContext
  } catch {
    return null
  }
}

export async function setCachedChatContext(
  redis: RedisClient,
  config: AppConfig,
  context: ChatContext,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  await redis.set(
    redisKey(
      config,
      `chat:ctx:${context.chatId}:r${context.revision}`,
    ),
    JSON.stringify(context),
    {
      EX: 2 * 60 * 60,
    },
  )
}

export async function setGenerationRealtimeState(
  redis: RedisClient,
  config: AppConfig,
  generationId: string,
  values: Record<string, string>,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  const key = redisKey(config, `generation:${generationId}`)
  await redis.hSet(key, {
    ...values,
    updatedAt: String(Math.floor(Date.now() / 1000)),
  })
  await redis.expire(key, 60 * 60)
}
