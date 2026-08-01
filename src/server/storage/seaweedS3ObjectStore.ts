import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'node:stream'

import type { ObjectStorageConfig } from '../config.js'
import {
  createMeasuredStream,
  normalizeObjectMetadata,
  ObjectStoreError,
  type ObjectReadStream,
  type ObjectStore,
  type PutObjectInput,
  type PutObjectResult,
  type StoredObject,
  validateObjectKey,
  validateObjectRange,
} from './objectStore.js'

type S3Error = {
  name?: unknown
  message?: unknown
  $metadata?: { httpStatusCode?: unknown }
}

function cleanEtag(etag: string | undefined): string | null {
  return etag?.replace(/^"|"$/g, '') || null
}

function isNotFound(error: unknown): boolean {
  const candidate = error as S3Error
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  )
}

function mapStorageError(error: unknown): ObjectStoreError {
  if (error instanceof ObjectStoreError) {
    return error
  }

  const candidate = error as S3Error
  const name = String(candidate?.name || '')
  const statusCode = candidate?.$metadata?.httpStatusCode

  if (
    name === 'AbortError' ||
    name === 'RequestAbortedError'
  ) {
    return new ObjectStoreError(
      'storage_aborted',
      'Object storage operation was aborted',
      { cause: error },
    )
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(name)
  ) {
    return new ObjectStoreError(
      'access_denied',
      'Object storage access was denied',
      { cause: error },
    )
  }

  if (
    name.includes('Timeout') ||
    name === 'ETIMEDOUT'
  ) {
    return new ObjectStoreError(
      'storage_timeout',
      'Object storage operation timed out',
      { cause: error },
    )
  }

  return new ObjectStoreError(
    'storage_unavailable',
    'Object storage is unavailable',
    { cause: error },
  )
}

function requireEnabledConfig(config: ObjectStorageConfig) {
  if (
    !config.enabled ||
    !config.endpoint ||
    !config.bucket ||
    !config.accessKeyId ||
    !config.secretAccessKey
  ) {
    throw new Error('Object storage configuration is not enabled')
  }

  return {
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  }
}

function asReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body
  }

  throw new ObjectStoreError(
    'storage_invalid_response',
    'Object storage returned a non-streaming response',
  )
}

export class SeaweedS3ObjectStore implements ObjectStore {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(private readonly config: ObjectStorageConfig) {
    const enabled = requireEnabledConfig(config)
    this.bucket = enabled.bucket
    this.client = new S3Client({
      endpoint: enabled.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      maxAttempts: config.maxAttempts,
      credentials: {
        accessKeyId: enabled.accessKeyId,
        secretAccessKey: enabled.secretAccessKey,
      },
    })
  }

  async healthCheck(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal: AbortSignal.timeout(3_000) },
      )
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  async putStream(input: PutObjectInput): Promise<PutObjectResult> {
    const key = validateObjectKey(input.key)
    const metadata = normalizeObjectMetadata(input.metadata)
    const measured = createMeasuredStream(input.body)
    const upload = new Upload({
      client: this.client,
      leavePartsOnError: false,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: measured.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: metadata,
        ServerSideEncryption: this.config.serverSideEncryption
          ? ServerSideEncryption.AES256
          : undefined,
      },
    })
    const abort = () => {
      void upload.abort().catch(() => undefined)
      measured.body.destroy(
        new ObjectStoreError(
          'storage_aborted',
          'Object storage operation was aborted',
        ),
      )
    }

    if (input.signal?.aborted) {
      abort()
      throw new ObjectStoreError(
        'storage_aborted',
        'Object storage operation was aborted',
      )
    }

    input.signal?.addEventListener('abort', abort, { once: true })

    try {
      const completed = await upload.done()
      const measurement = measured.result()
      const head = await this.head(key, input.signal)

      if (!head || head.sizeBytes !== measurement.sizeBytes) {
        throw new ObjectStoreError(
          'storage_invalid_response',
          'Stored object size verification failed',
        )
      }

      return {
        ...head,
        etag: cleanEtag(completed.ETag) ?? head.etag,
        sha256: measurement.sha256,
      }
    } catch (error) {
      throw mapStorageError(error)
    } finally {
      input.signal?.removeEventListener('abort', abort)
    }
  }

  async head(
    rawKey: string,
    signal?: AbortSignal,
  ): Promise<StoredObject | null> {
    const key = validateObjectKey(rawKey)

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
        { abortSignal: signal },
      )

      if (response.ContentLength === undefined) {
        throw new ObjectStoreError(
          'storage_invalid_response',
          'Object storage omitted the object length',
        )
      }

      return {
        key,
        etag: cleanEtag(response.ETag),
        sizeBytes: BigInt(response.ContentLength),
        sha256: response.Metadata?.sha256 || null,
        contentType: response.ContentType || null,
        metadata: response.Metadata || {},
      }
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }

      throw mapStorageError(error)
    }
  }

  async getStream(
    rawKey: string,
    rawRange?: string,
    signal?: AbortSignal,
  ): Promise<ObjectReadStream | null> {
    const key = validateObjectKey(rawKey)
    const range = rawRange ? validateObjectRange(rawRange) : undefined

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range,
        }),
        { abortSignal: signal },
      )

      return {
        body: asReadable(response.Body),
        key,
        etag: cleanEtag(response.ETag),
        contentLength: response.ContentLength === undefined
          ? null
          : BigInt(response.ContentLength),
        contentRange: response.ContentRange || null,
        contentType: response.ContentType || null,
        lastModified: response.LastModified || null,
        metadata: response.Metadata || {},
      }
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }

      throw mapStorageError(error)
    }
  }

  async delete(rawKey: string, signal?: AbortSignal): Promise<void> {
    const key = validateObjectKey(rawKey)

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
        { abortSignal: signal },
      )
    } catch (error) {
      if (!isNotFound(error)) {
        throw mapStorageError(error)
      }
    }
  }

  close(): void {
    this.client.destroy()
  }
}
