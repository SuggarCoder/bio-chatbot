import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

export type ObjectStoreErrorCode =
  | 'invalid_object_key'
  | 'invalid_object_range'
  | 'object_not_found'
  | 'access_denied'
  | 'storage_aborted'
  | 'storage_timeout'
  | 'storage_unavailable'
  | 'storage_invalid_response'

export class ObjectStoreError extends Error {
  constructor(
    readonly code: ObjectStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ObjectStoreError'
  }
}

export type PutObjectInput = {
  key: string
  body: Readable
  contentType?: string
  contentLength?: number
  metadata?: Record<string, string>
  signal?: AbortSignal
}

export type StoredObject = {
  key: string
  etag: string | null
  sizeBytes: bigint
  sha256: string | null
  contentType: string | null
  metadata: Record<string, string>
}

export type PutObjectResult = StoredObject & {
  sha256: string
}

export type ObjectReadStream = {
  body: Readable
  key: string
  etag: string | null
  contentLength: bigint | null
  contentRange: string | null
  contentType: string | null
  lastModified: Date | null
  metadata: Record<string, string>
}

export interface ObjectStore {
  healthCheck(): Promise<void>
  putStream(input: PutObjectInput): Promise<PutObjectResult>
  head(key: string, signal?: AbortSignal): Promise<StoredObject | null>
  getStream(
    key: string,
    range?: string,
    signal?: AbortSignal,
  ): Promise<ObjectReadStream | null>
  delete(key: string, signal?: AbortSignal): Promise<void>
  close(): void
}

const controlCharacterPattern = /[\u0000-\u001f\u007f]/
const byteRangePattern = /^bytes=(\d*)-(\d*)$/

export function validateObjectKey(key: string): string {
  if (
    !key ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    controlCharacterPattern.test(key) ||
    Buffer.byteLength(key, 'utf8') > 1024
  ) {
    throw new ObjectStoreError(
      'invalid_object_key',
      'Object key is invalid',
    )
  }

  const segments = key.split('/')

  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ObjectStoreError(
      'invalid_object_key',
      'Object key is invalid',
    )
  }

  return key
}

export function validateObjectRange(range: string): string {
  const match = byteRangePattern.exec(range)

  if (!match || (!match[1] && !match[2])) {
    throw new ObjectStoreError(
      'invalid_object_range',
      'Object range is invalid',
    )
  }

  if (match[1] && match[2] && BigInt(match[1]) > BigInt(match[2])) {
    throw new ObjectStoreError(
      'invalid_object_range',
      'Object range is invalid',
    )
  }

  return range
}

export function createMeasuredStream(source: Readable): {
  body: Readable
  result: () => { sizeBytes: bigint; sha256: string }
} {
  const hash = createHash('sha256')
  let sizeBytes = 0n
  let completed = false
  let result: { sizeBytes: bigint; sha256: string } | undefined

  const body = Readable.from((async function* () {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sizeBytes += BigInt(bytes.length)
      hash.update(bytes)
      yield bytes
    }

    completed = true
  })())

  return {
    body,
    result: () => {
      if (!completed) {
        throw new ObjectStoreError(
          'storage_invalid_response',
          'Object stream was not fully consumed',
        )
      }

      result ??= {
        sizeBytes,
        sha256: hash.digest('hex'),
      }
      return result
    },
  }
}

export function normalizeObjectMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined
  }

  const entries = Object.entries(metadata)

  if (entries.length > 20) {
    throw new ObjectStoreError(
      'storage_invalid_response',
      'Object metadata has too many entries',
    )
  }

  return Object.fromEntries(
    entries.map(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase()
      const value = rawValue.trim()

      if (
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key) ||
        !value ||
        Buffer.byteLength(value, 'utf8') > 1024 ||
        controlCharacterPattern.test(value)
      ) {
        throw new ObjectStoreError(
          'storage_invalid_response',
          'Object metadata is invalid',
        )
      }

      return [key, value]
    }),
  )
}
