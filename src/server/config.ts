import 'dotenv/config'

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  serveClient: boolean
  databaseUrl: string
  redisUrl: string
  redisPrefix: string
  qwenApiKey: string
  qwenBaseUrl: string
  qwenModel: string
  qwenMaxOutputTokens: number
  gpas2AuthMode: 'mock' | 'upstream'
  gpas2UserInfoUrl?: string
  chatRateLimitPerMinute: number
  maxConcurrentGenerations: number
  monthlyTokenLimit: number
  generationLeaseSeconds: number
}

function required(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

function positiveInteger(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  const minimum = allowZero ? 0 : 1

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
  }

  return value
}

export function readConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development'
  const defaultAuthMode = nodeEnv === 'production' ? 'upstream' : 'mock'
  const authMode = process.env.GPAS2_AUTH_MODE?.trim() || defaultAuthMode

  if (authMode !== 'mock' && authMode !== 'upstream') {
    throw new Error('GPAS2_AUTH_MODE must be mock or upstream')
  }

  if (nodeEnv === 'production' && authMode === 'mock') {
    throw new Error('GPAS2_AUTH_MODE=mock is not allowed in production')
  }

  const gpas2UserInfoUrl = process.env.GPAS2_USER_INFO_URL?.trim()

  if (authMode === 'upstream') {
    if (!gpas2UserInfoUrl) {
      throw new Error('GPAS2_USER_INFO_URL is required in upstream mode')
    }

    const parsedUrl = new URL(gpas2UserInfoUrl)

    if (parsedUrl.protocol !== 'https:' && nodeEnv === 'production') {
      throw new Error('GPAS2_USER_INFO_URL must use HTTPS in production')
    }
  }

  const environmentName = nodeEnv === 'production' ? 'prod' : 'dev'

  return {
    nodeEnv,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: positiveInteger('PORT', 8090),
    serveClient: process.env.SERVE_CLIENT !== 'false',
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    redisPrefix:
      process.env.REDIS_KEY_PREFIX?.trim() ||
      `gpas2cb:${environmentName}:v2:`,
    qwenApiKey: required('QWEN_API_KEY'),
    qwenBaseUrl:
      process.env.QWEN_BASE_URL?.trim() ||
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    qwenModel:
      process.env.QWEN_MODEL?.trim() ||
      'qwen3.8-max-preview',
    qwenMaxOutputTokens: positiveInteger('QWEN_MAX_OUTPUT_TOKENS', 4096),
    gpas2AuthMode: authMode,
    gpas2UserInfoUrl,
    chatRateLimitPerMinute: positiveInteger('CHAT_RATE_LIMIT_PER_MINUTE', 10),
    maxConcurrentGenerations: positiveInteger('MAX_CONCURRENT_GENERATIONS', 1),
    monthlyTokenLimit: positiveInteger('MONTHLY_TOKEN_LIMIT', 0, true),
    generationLeaseSeconds: positiveInteger('GENERATION_LEASE_SECONDS', 120),
  }
}
