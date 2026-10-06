import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppConfig } from './config.js'
import { redisKey, type RedisClient } from './cache.js'

// Shared by planner, generation streams and background requests, across processes.
export const acquireModelPermit = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 1 end
local expired=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now-60000)
local total=tonumber(redis.call('GET',KEYS[4]) or '0')
for _,id in ipairs(expired) do
  total=total-tonumber(redis.call('HGET',KEYS[3],id) or '0')
  redis.call('HDEL',KEYS[3],id)
end
total=math.max(0,total); redis.call('SET',KEYS[4],total,'PX',120000)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now-60000)
if tonumber(ARGV[4])>0 then
  if tonumber(ARGV[5])>tonumber(ARGV[4]) then return -1 end
  if total+tonumber(ARGV[5])>tonumber(ARGV[4]) then return 0 end
end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
if tonumber(ARGV[3])>0 and redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) then return 0 end
redis.call('ZADD',KEYS[1],now+30000,ARGV[1]); redis.call('PEXPIRE',KEYS[1],60000)
redis.call('ZADD',KEYS[2],now,ARGV[1]); redis.call('PEXPIRE',KEYS[2],120000)
redis.call('HSET',KEYS[3],ARGV[1],ARGV[5]); redis.call('PEXPIRE',KEYS[3],120000)
redis.call('INCRBY',KEYS[4],ARGV[5]); redis.call('PEXPIRE',KEYS[4],120000)
return 1`
const renewModelPermit = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local expires=redis.call('ZSCORE',KEYS[1],ARGV[1])
if not expires or tonumber(expires)<=now then return 0 end
redis.call('ZADD',KEYS[1],now+30000,ARGV[1]); redis.call('PEXPIRE',KEYS[1],60000); return 1`

export function modelBudgetFetch(config: AppConfig, redis: RedisClient): typeof fetch {
  return async (input, init) => {
    const token = randomUUID()
    const key = redisKey(config, 'model-budget:active')
    const rateKey = redisKey(config, 'model-budget:rpm')
    const tokensKey = redisKey(config, 'model-budget:tokens')
    const totalKey = redisKey(config, 'model-budget:token-total')
    // Reserve a conservative byte-based input bound plus the declared output cap.
    // This is deliberately NOT a throughput prediction or exact billed token count.
    const rawBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : ''
    const body = rawBody ? JSON.parse(rawBody) as { max_output_tokens?: number } : {}
    const reservedTokens = Buffer.byteLength(rawBody, 'utf8') + (body.max_output_tokens ?? config.qwenMaxOutputTokens ?? 65536) + 1024
    const controller = new AbortController()
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = AbortSignal.any([controller.signal, ...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(10 * 60_000)])
    const waitUntil = Date.now() + 60_000
    let acquired = false
    let timer: ReturnType<typeof setInterval> | undefined
    let renewing = false
    let released = false
    const release = async () => {
      if (released) return
      released = true
      clearInterval(timer)
      signal.removeEventListener('abort', onAbort)
      if (acquired) await redis.eval("return redis.call('ZREM',KEYS[1],ARGV[1])", { keys: [key], arguments: [token] }).catch(() => {})
    }
    const onAbort = () => { void release() }
    try {
      while (!acquired) {
        signal.throwIfAborted()
        const granted = Number(await redis.eval(acquireModelPermit, { keys: [key, rateKey, tokensKey, totalKey], arguments: [token, String(config.upstreamConcurrency ?? 8), String(config.upstreamRequestsPerMinute ?? 0), String(config.upstreamTokensPerMinute ?? 0), String(reservedTokens)] }))
        if (granted === -1) throw new Error('Request exceeds shared upstream token reservation budget')
        acquired = granted === 1
        if (!acquired) {
          if (Date.now() >= waitUntil) throw new Error('Shared model budget is busy')
          await delay(200 + Math.random() * 100, undefined, { signal })
        }
      }
      signal.throwIfAborted()
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setInterval(() => {
        if (renewing) return
        renewing = true
        void redis.eval(renewModelPermit, { keys: [key], arguments: [token] })
          .then(value => { if (Number(value) !== 1) controller.abort() })
          .catch(() => controller.abort()).finally(() => { renewing = false })
      }, 10_000)
      timer.unref()
      const response = await fetch(input, { ...init, signal })
      if (!response.body) { await release(); return response }
      const reader = response.body.getReader()
      // A streamed generation retains its permit until the body ends, not headers.
      const body = new ReadableStream<Uint8Array>({
        async pull(sink) {
          try {
            const next = await reader.read()
            if (next.done) { await release(); sink.close() } else sink.enqueue(next.value)
          } catch (error) { await release(); sink.error(error) }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { controller.abort(); await release() } },
      })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) { controller.abort(); await release(); throw error }
  }
}
