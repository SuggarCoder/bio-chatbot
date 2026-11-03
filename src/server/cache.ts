import { createClient, type RedisClientType } from 'redis'

import type { AppConfig } from './config.js'
import { metrics } from './metrics.js'
import { getTokenUsage, type ChatContext, type Database } from './db.js'
import { quotaPeriods, type QuotaPeriod } from './quotaPeriods.js'
import type { BudgetedContextResult } from './conversationMemory.js'

export type RedisClient = RedisClientType

/**
 * Redis did not answer (down, overloaded, out of memory, deadline). Callers
 * use it to fail open (caches) or reject with 503 (queues, limits).
 */
export class RedisUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RedisUnavailableError'
  }
}

export function createRedisClient(config: AppConfig): RedisClient {
  const client = createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 2_048,
    commandOptions: { timeout: 2_000 },
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

  return withRedisDeadlines(client)
}

/** The installed redis client only times out UNSENT commands. Bound the
 * response wait as well; the underlying queue is independently capped above.
 * Commands may have executed before a timeout, so callers must be idempotent. */
export function withRedisDeadlines<T extends object>(client: T, timeoutMs = 2_000): T {
  const commands = new Set(['get', 'set', 'del', 'exists', 'expire', 'eval', 'publish', 'xAdd', 'xDel', 'xRange', 'subscribe', 'connect', 'close'])
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'duplicate') return (...args: unknown[]) => withRedisDeadlines(value.apply(target, args), timeoutMs)
      if (!commands.has(String(property))) return value.bind(target)
      return (...args: unknown[]) => {
        const command = String(property)
        const stopTimer = metrics.redisCommandDuration.startTimer({ command })
        return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Startup can report degraded health while reconnect continues in the
          // background. Shutdown must not wait forever on an unresponsive peer.
          if (property === 'close') {
            const destroy = Reflect.get(target, 'destroy', target)
            // destroy() of an already closed client throws; nothing to clean up then.
            if (typeof destroy === 'function') {
              try { destroy.call(target) } catch { /* already closed */ }
            }
          }
          reject(new RedisUnavailableError(`Redis ${command} response deadline exceeded`))
        }, property === 'connect' ? Math.max(timeoutMs, 5_000) : timeoutMs)
        Promise.resolve().then(() => value.apply(target, args)).then(resolve, (error: unknown) => {
          reject(error instanceof Error && !(error instanceof RedisUnavailableError)
            ? new RedisUnavailableError(error.message, { cause: error })
            : error)
        })
          .finally(() => clearTimeout(timer))
        }).then((result) => {
          stopTimer()
          return result
        }, (error: unknown) => {
          stopTimer()
          metrics.redisCommandErrors.inc({ command })
          throw error
        })
      }
    },
  })
}

/**
 * Context caches only help retries and the next turns soon after; a new key
 * is written for every turn, so a long lifetime is mostly wasted memory.
 */
const CONTEXT_CACHE_SECONDS = 15 * 60

export function redisKey(config: AppConfig, key: string): string {
  return `${config.redisPrefix}${key}`
}

const rateLimitScript = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local userLimit = tonumber(ARGV[3])
local member = ARGV[4]
local ttl = tonumber(ARGV[5])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local userCount = redis.call('ZCARD', KEYS[1])

if userCount >= userLimit then
  local retryAfter = 0
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    retryAfter = math.max(retryAfter, tonumber(oldest[2]) + window - now)
  end
  return {0, math.max(retryAfter, 1), math.max(userLimit - userCount, 0)}
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], ttl)
return {1, 0, userLimit - userCount - 1}
`

export type GenerationRateLimitResult = {
  allowed: boolean
  retryAfterMs: number
  remainingUser: number
}

export async function consumeGenerationRateLimit(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  bucket: 'generation' | 'capability' = 'generation',
): Promise<GenerationRateLimitResult> {
  if (!redis.isReady) {
    throw new RedisUnavailableError('Redis is unavailable')
  }

  const now = Date.now()
  const windowMs = 60_000
  const result = await redis.eval(rateLimitScript, {
    keys: [redisKey(config, `rl:user:${userId}:${bucket}`)],
    arguments: [
      String(now),
      String(windowMs),
      String(config.chatRateLimitPerMinute),
      `${now}:${crypto.randomUUID()}`,
      String(windowMs + 1_000),
    ],
  })
  const values = Array.isArray(result) ? result : []

  return {
    allowed: Number(values[0]) === 1,
    retryAfterMs: Math.max(0, Number(values[1]) || 0),
    remainingUser: Math.max(0, Number(values[2]) || 0),
  }
}

export async function readPeriodUsage(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  period: QuotaPeriod,
): Promise<number> {
  if (!redis.isReady) {
    throw new RedisUnavailableError('Redis is unavailable')
  }

  const key = redisKey(config, `quota:user:${userId}:${period.key}`)
  const cached = await redis.get(key)

  if (cached !== null) {
    return Number(cached)
  }

  const total = await getTokenUsage(
    database,
    userId,
    period.start,
    period.end,
  )
  // PostgreSQL usage events are the source of truth. The cached total is
  // re-read from them at least hourly, so any drift (lost increments, a
  // Redis restart, background-job usage) heals on its own.
  await redis.set(key, String(total), {
    EX: Math.min(period.ttlSeconds, QUOTA_CACHE_SECONDS),
  })
  return total
}

/** Full-period token totals (before any Reset 卷 baseline is subtracted). */
export async function readQuotaUsage(
  database: Database,
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  now = new Date(),
) {
  const periods = quotaPeriods(now)
  const [weekly, monthly] = await Promise.all([
    readPeriodUsage(database, redis, config, userId, periods.weekly),
    readPeriodUsage(database, redis, config, userId, periods.monthly),
  ])
  return { periods, weekly, monthly }
}

/** How long a cached period total is trusted before re-reading PostgreSQL. */
const QUOTA_CACHE_SECONDS = 3_600
/** A generation's usage is applied at most once within this window. */
const QUOTA_APPLIED_MARKER_SECONDS = 86_400

/**
 * Adds a finished generation's tokens to the cached weekly and monthly
 * totals, once. A missing total is NOT created here: INCRBY on a missing key
 * would start from zero and undercount until it expired; the next read
 * rebuilds it from PostgreSQL.
 */
const applyQuotaScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
for index = 2, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    redis.call('INCRBY', KEYS[index], ARGV[1])
  end
end
return 1
`

export async function applyQuotaUsage(
  redis: RedisClient,
  config: AppConfig,
  userId: string,
  generationId: string,
  totalTokens: number,
  now = new Date(),
): Promise<void> {
  if (!redis.isReady) {
    return
  }

  const periods = quotaPeriods(now)
  await redis.eval(applyQuotaScript, {
    keys: [
      redisKey(config, `quota:applied:${generationId}`),
      redisKey(config, `quota:user:${userId}:${periods.weekly.key}`),
      redisKey(config, `quota:user:${userId}:${periods.monthly.key}`),
    ],
    arguments: [String(totalTokens), String(QUOTA_APPLIED_MARKER_SECONDS)],
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
      EX: CONTEXT_CACHE_SECONDS,
    },
  )
}

function budgetedContextKey(
  config: AppConfig,
  input: {
    chatId: string
    contextMaxSeq: number
    summaryVersion?: number
    policyFingerprint: string
  },
): string {
  return redisKey(
    config,
    `chat:ctx:v3:${input.policyFingerprint}:${input.chatId}:${input.contextMaxSeq}:${input.summaryVersion ?? 0}`,
  )
}

export async function getCachedBudgetedChatContext(
  redis: RedisClient,
  config: AppConfig,
  input: {
    chatId: string
    contextMaxSeq: number
    summaryVersion?: number
    policyFingerprint: string
  },
): Promise<BudgetedContextResult | null> {
  if (!redis.isReady) return null
  const value = await redis.get(budgetedContextKey(config, input))
  if (!value) return null
  try {
    return JSON.parse(value) as BudgetedContextResult
  } catch {
    return null
  }
}

export async function setCachedBudgetedChatContext(
  redis: RedisClient,
  config: AppConfig,
  input: {
    chatId: string
    contextMaxSeq: number
    summaryVersion?: number
    policyFingerprint: string
  },
  context: BudgetedContextResult,
): Promise<void> {
  if (!redis.isReady) return
  await redis.set(budgetedContextKey(config, input), JSON.stringify(context), {
    EX: CONTEXT_CACHE_SECONDS,
  })
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
