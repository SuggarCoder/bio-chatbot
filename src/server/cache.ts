import { createClient, type RedisClientType } from 'redis'

import type { AppConfig } from './config.js'
import { getMonthlyTokenUsage, type ChatContext, type Database } from './db.js'

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

const rateLimitScript = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local userLimit = tonumber(ARGV[3])
local ipLimit = tonumber(ARGV[4])
local member = ARGV[5]
local ttl = tonumber(ARGV[6])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

local userCount = redis.call('ZCARD', KEYS[1])
local ipCount = redis.call('ZCARD', KEYS[2])

if userCount >= userLimit or ipCount >= ipLimit then
  local retryAfter = 0
  if userCount >= userLimit then
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    if oldest[2] then
      retryAfter = math.max(retryAfter, tonumber(oldest[2]) + window - now)
    end
  end
  if ipCount >= ipLimit then
    local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    if oldest[2] then
      retryAfter = math.max(retryAfter, tonumber(oldest[2]) + window - now)
    end
  end
  return {0, math.max(retryAfter, 1), math.max(userLimit - userCount, 0), math.max(ipLimit - ipCount, 0)}
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('ZADD', KEYS[2], now, member)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
return {1, 0, userLimit - userCount - 1, ipLimit - ipCount - 1}
`

export type GenerationRateLimitResult = {
  allowed: boolean
  retryAfterMs: number
  remainingUser: number
  remainingIp: number
}

export async function consumeGenerationRateLimit(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  ip: string,
): Promise<GenerationRateLimitResult> {
  if (!redis.isReady) {
    throw new Error('Redis is unavailable')
  }

  const now = Date.now()
  const windowMs = 60_000
  const result = await redis.eval(rateLimitScript, {
    keys: [
      redisKey(config, `rl:user:${userId}:generation`),
      redisKey(config, `rl:ip:${ip}:generation`),
    ],
    arguments: [
      String(now),
      String(windowMs),
      String(config.chatRateLimitPerMinute),
      String(config.chatRateLimitPerMinute * 5),
      `${now}:${crypto.randomUUID()}`,
      String(windowMs + 1_000),
    ],
  })
  const values = Array.isArray(result) ? result : []

  return {
    allowed: Number(values[0]) === 1,
    retryAfterMs: Math.max(0, Number(values[1]) || 0),
    remainingUser: Math.max(0, Number(values[2]) || 0),
    remainingIp: Math.max(0, Number(values[3]) || 0),
  }
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
): Promise<ChatContext | null> {
  if (!redis.isReady) {
    return null
  }

  const value = await redis.get(
    redisKey(config, `chat:ctx:${chatId}`),
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
      `chat:ctx:${context.chatId}`,
    ),
    JSON.stringify(context),
    {
      EX: 2 * 60 * 60,
    },
  )
}

const advanceChatContextScript = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ok, decoded = pcall(cjson.decode, current)
if not ok or tonumber(decoded.revision) ~= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`

export async function advanceCachedChatContext(
  redis: RedisClient,
  config: AppConfig,
  expectedRevision: number,
  context: ChatContext,
): Promise<boolean> {
  if (!redis.isReady) {
    return false
  }

  const result = await redis.eval(advanceChatContextScript, {
    keys: [redisKey(config, `chat:ctx:${context.chatId}`)],
    arguments: [
      String(expectedRevision),
      JSON.stringify(context),
      String(2 * 60 * 60),
    ],
  })
  return Number(result) === 1
}

export async function notifyGenerationStateChanged(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
  status: string,
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  await redis.publish(
    redisKey(config, `notify:user:${userId}`),
    JSON.stringify({
      type: `generation.${status}`,
      generationId,
    }),
  )
}
