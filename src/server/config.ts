import 'dotenv/config'

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  serveClient: boolean
  trustedProxyCidrs: string | false
  databaseUrl: string
  pgPoolMax: number
  redisUrl: string
  redisPrefix: string
  qwenApiKey: string
  qwenBaseUrl: string
  qwenModel: string
  qwenMaxOutputTokens: number
  gpas2AuthMode: 'mock' | 'upstream'
  gpas2UserInfoUrl?: string
  chatRateLimitPerMinute: number
  monthlyTokenLimit: number
  globalGenerationConcurrency: number
  providerGenerationConcurrency: number
  modelGenerationConcurrency: number
  generationTimeoutMs: number
  generationLockLeaseMs: number
  generationLockRenewIntervalMs: number
  generationCancelPollIntervalMs: number
  generationSnapshotIntervalMs: number
  artifactProtocolEnabled: boolean
  objectStorage: ObjectStorageConfig
}

export type ObjectStorageConfig = {
  enabled: boolean
  endpoint?: string
  region: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle: boolean
  maxAttempts: number
  serverSideEncryption?: 'AES256'
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

function booleanValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase()

  if (!raw) {
    return fallback
  }

  if (raw === 'true') {
    return true
  }

  if (raw === 'false') {
    return false
  }

  throw new Error(`${name} must be true or false`)
}

function storageRequired(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required when OBJECT_STORAGE_ENABLED=true`)
  }

  return value
}

export function readObjectStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnv = environment.NODE_ENV?.trim() || 'development',
): ObjectStorageConfig {
  const enabled = booleanValue(
    environment,
    'OBJECT_STORAGE_ENABLED',
    false,
  )
  const region = environment.S3_REGION?.trim() || 'us-east-1'
  const forcePathStyle = booleanValue(
    environment,
    'S3_FORCE_PATH_STYLE',
    true,
  )
  const maxAttemptsRaw = environment.S3_MAX_ATTEMPTS?.trim()
  const maxAttempts = maxAttemptsRaw ? Number(maxAttemptsRaw) : 3

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('S3_MAX_ATTEMPTS must be an integer greater than or equal to 1')
  }

  const encryption = environment.S3_SERVER_SIDE_ENCRYPTION?.trim()

  if (encryption && encryption !== 'AES256') {
    throw new Error('S3_SERVER_SIDE_ENCRYPTION must be empty or AES256')
  }
  const serverSideEncryption = encryption === 'AES256'
    ? encryption
    : undefined

  if (!enabled) {
    return {
      enabled,
      region,
      forcePathStyle,
      maxAttempts,
      serverSideEncryption,
    }
  }

  const endpoint = storageRequired(environment, 'S3_ENDPOINT')
  const parsedEndpoint = new URL(endpoint)

  if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) {
    throw new Error('S3_ENDPOINT must use HTTP or HTTPS')
  }

  if (nodeEnv === 'production' && parsedEndpoint.protocol !== 'https:') {
    throw new Error('S3_ENDPOINT must use HTTPS in production')
  }

  return {
    enabled,
    endpoint: parsedEndpoint.toString().replace(/\/$/, ''),
    region,
    bucket: storageRequired(environment, 'S3_BUCKET'),
    accessKeyId: storageRequired(environment, 'S3_ACCESS_KEY_ID'),
    secretAccessKey: storageRequired(environment, 'S3_SECRET_ACCESS_KEY'),
    forcePathStyle,
    maxAttempts,
    serverSideEncryption,
  }
}

export function readTrustedProxyCidrs(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnv = environment.NODE_ENV?.trim() || 'development',
): string | false {
  const value = environment.TRUSTED_PROXY_CIDRS?.trim()

  if (!value) {
    if (nodeEnv === 'production') {
      throw new Error(
        'TRUSTED_PROXY_CIDRS is required in production because the application runs behind a reverse proxy',
      )
    }

    return false
  }

  const trustedRanges = value.split(',').map((range) => range.trim())

  if (trustedRanges.some((range) => /\/0$/.test(range))) {
    throw new Error(
      'TRUSTED_PROXY_CIDRS must not trust every address; configure only the reverse proxy IP address or CIDR',
    )
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
  const trustedProxyCidrs = readTrustedProxyCidrs(process.env, nodeEnv)
  const pgPoolMax = positiveInteger('PG_POOL_MAX', 4)
  if (pgPoolMax > 4) {
    throw new Error('PG_POOL_MAX must not exceed 4 in the 10-connection deployment')
  }
  const generationLockLeaseMs = positiveInteger(
    'GENERATION_LOCK_LEASE_MS',
    30_000,
  )
  const generationLockRenewIntervalMs = positiveInteger(
    'GENERATION_LOCK_RENEW_INTERVAL_MS',
    10_000,
  )
  if (generationLockRenewIntervalMs >= generationLockLeaseMs) {
    throw new Error(
      'GENERATION_LOCK_RENEW_INTERVAL_MS must be less than GENERATION_LOCK_LEASE_MS',
    )
  }

  return {
    nodeEnv,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: positiveInteger('PORT', 8090),
    serveClient: process.env.SERVE_CLIENT !== 'false',
    trustedProxyCidrs,
    databaseUrl: required('DATABASE_URL'),
    pgPoolMax,
    redisUrl: required('REDIS_URL'),
    redisPrefix:
      process.env.REDIS_KEY_PREFIX?.trim() ||
      `gpas2cb:${environmentName}:v3:`,
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
    monthlyTokenLimit: positiveInteger('MONTHLY_TOKEN_LIMIT', 0, true),
    globalGenerationConcurrency: positiveInteger('GLOBAL_GENERATION_CONCURRENCY', 4),
    providerGenerationConcurrency: positiveInteger('PROVIDER_GENERATION_CONCURRENCY', 4),
    modelGenerationConcurrency: positiveInteger('MODEL_GENERATION_CONCURRENCY', 4),
    generationTimeoutMs: positiveInteger('GENERATION_TIMEOUT_MS', 180_000),
    generationLockLeaseMs,
    generationLockRenewIntervalMs,
    generationCancelPollIntervalMs: positiveInteger(
      'GENERATION_CANCEL_POLL_INTERVAL_MS',
      300,
    ),
    generationSnapshotIntervalMs: positiveInteger(
      'GENERATION_SNAPSHOT_INTERVAL_MS',
      1_000,
    ),
    artifactProtocolEnabled: booleanValue(
      process.env,
      'ARTIFACT_PROTOCOL_ENABLED',
      false,
    ),
    objectStorage: readObjectStorageConfig(process.env, nodeEnv),
  }
}
