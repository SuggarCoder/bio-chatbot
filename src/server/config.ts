import 'dotenv/config'

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  serveClient: boolean
  databaseUrl: string
  pgPoolMax: number
  redisUrl: string
  redisPrefix: string
  qwenApiKey: string
  qwenBaseUrl: string
  qwenModel: string
  qwenTokenizerPath: string
  qwenContextWindowTokens: number
  qwenMaxInputTokens: number
  qwenMaxOutputTokens: number
  chatHistoryTokenBudget: number
  chatSummaryTokenBudget: number
  summaryTriggerTokens: number
  instructionsTokenBudget: number
  artifactProtocolTokenBudget: number
  artifactOutlineTokenBudget: number
  artifactFragmentTokenBudget: number
  contextMemoryEnabled: boolean
  userMemoryEnabled: boolean
  artifactContextV2Enabled: boolean
  artifactPatchEnabled: boolean
  backgroundModel: string
  backgroundMaxOutputTokens: number
  backgroundConcurrency: number
  backgroundTimeoutMs: number
  embeddingModelPath: string
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
  const allowInsecureHttp = booleanValue(
    environment,
    'S3_ALLOW_INSECURE_HTTP',
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

  if (nodeEnv === 'production' && parsedEndpoint.protocol === 'http:') {
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname)) {
      throw new Error(
        'S3_ENDPOINT must not use a loopback host in production containers; use host.docker.internal or a Docker network service name',
      )
    }

    if (!allowInsecureHttp) {
      throw new Error(
        'S3_ENDPOINT must use HTTPS in production unless S3_ALLOW_INSECURE_HTTP=true is explicitly set for a private local network',
      )
    }
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

  const qwenContextWindowTokens = positiveInteger(
    'QWEN_CONTEXT_WINDOW_TOKENS',
    1_000_000,
  )
  const qwenMaxInputTokens = positiveInteger(
    'QWEN_MAX_INPUT_TOKENS',
    991_808,
  )
  const qwenMaxOutputTokens = positiveInteger(
    'QWEN_MAX_OUTPUT_TOKENS',
    65_536,
  )
  if (qwenMaxInputTokens > qwenContextWindowTokens) {
    throw new Error('QWEN_MAX_INPUT_TOKENS must not exceed QWEN_CONTEXT_WINDOW_TOKENS')
  }
  if (qwenMaxOutputTokens > qwenContextWindowTokens) {
    throw new Error('QWEN_MAX_OUTPUT_TOKENS must not exceed QWEN_CONTEXT_WINDOW_TOKENS')
  }

  const chatHistoryTokenBudget = positiveInteger(
    'CHAT_HISTORY_TOKEN_BUDGET',
    131_072,
  )
  const chatSummaryTokenBudget = positiveInteger(
    'CHAT_SUMMARY_TOKEN_BUDGET',
    8_192,
  )
  if (chatHistoryTokenBudget + chatSummaryTokenBudget > qwenMaxInputTokens) {
    throw new Error('Chat history and summary budgets must fit QWEN_MAX_INPUT_TOKENS')
  }
  const contextMemoryEnabled = booleanValue(
    process.env,
    'CONTEXT_MEMORY_ENABLED',
    false,
  )
  const userMemoryEnabled = booleanValue(
    process.env,
    'USER_MEMORY_ENABLED',
    false,
  )
  const artifactContextV2Enabled = booleanValue(
    process.env,
    'ARTIFACT_CONTEXT_V2_ENABLED',
    false,
  )
  const artifactPatchEnabled = booleanValue(
    process.env,
    'ARTIFACT_PATCH_ENABLED',
    false,
  )
  if (artifactPatchEnabled && !artifactContextV2Enabled) {
    throw new Error(
      'ARTIFACT_PATCH_ENABLED requires ARTIFACT_CONTEXT_V2_ENABLED=true',
    )
  }

  return {
    nodeEnv,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: positiveInteger('PORT', 8090),
    serveClient: process.env.SERVE_CLIENT !== 'false',
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
      'qwen3.6-flash',
    qwenTokenizerPath:
      process.env.QWEN_TOKENIZER_PATH?.trim() || 'models/qwen-tokenizer',
    qwenContextWindowTokens,
    qwenMaxInputTokens,
    qwenMaxOutputTokens,
    chatHistoryTokenBudget,
    chatSummaryTokenBudget,
    summaryTriggerTokens: positiveInteger('SUMMARY_TRIGGER_TOKENS', 16_384),
    instructionsTokenBudget: positiveInteger(
      'INSTRUCTIONS_TOKEN_BUDGET',
      32_768,
    ),
    artifactProtocolTokenBudget: positiveInteger(
      'ARTIFACT_PROTOCOL_TOKEN_BUDGET',
      4_096,
    ),
    artifactOutlineTokenBudget: positiveInteger(
      'ARTIFACT_OUTLINE_TOKEN_BUDGET',
      8_192,
    ),
    artifactFragmentTokenBudget: positiveInteger(
      'ARTIFACT_FRAGMENT_TOKEN_BUDGET',
      16_384,
    ),
    contextMemoryEnabled,
    userMemoryEnabled,
    artifactContextV2Enabled,
    artifactPatchEnabled,
    backgroundModel:
      process.env.BACKGROUND_MODEL?.trim() || 'qwen3.6-flash',
    backgroundMaxOutputTokens: positiveInteger(
      'BACKGROUND_MAX_OUTPUT_TOKENS',
      4_096,
    ),
    backgroundConcurrency: positiveInteger('BACKGROUND_CONCURRENCY', 1),
    backgroundTimeoutMs: positiveInteger('BACKGROUND_TIMEOUT_MS', 120_000),
    embeddingModelPath:
      process.env.EMBEDDING_MODEL_PATH?.trim() || 'models/bge-small-zh-v1.5',
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
