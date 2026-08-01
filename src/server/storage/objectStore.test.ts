import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { readObjectStorageConfig } from '../config.js'
import {
  createMeasuredStream,
  ObjectStoreError,
  validateObjectKey,
  validateObjectRange,
} from './objectStore.js'

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

test('object keys accept opaque relative paths and reject traversal', () => {
  assert.equal(
    validateObjectKey(
      'artifacts/users/00000000-0000-4000-8000-000000000001/file-id',
    ),
    'artifacts/users/00000000-0000-4000-8000-000000000001/file-id',
  )

  for (const key of ['', '/absolute', 'a//b', 'a/../b', 'a\\b', 'a/']) {
    assert.throws(
      () => validateObjectKey(key),
      (error) =>
        error instanceof ObjectStoreError &&
        error.code === 'invalid_object_key',
    )
  }
})

test('object ranges accept one RFC 9110 byte range', () => {
  assert.equal(validateObjectRange('bytes=0-99'), 'bytes=0-99')
  assert.equal(validateObjectRange('bytes=100-'), 'bytes=100-')
  assert.equal(validateObjectRange('bytes=-100'), 'bytes=-100')

  for (const range of ['bytes=-', 'bytes=10-1', 'items=0-1', 'bytes=0-1,3-4']) {
    assert.throws(
      () => validateObjectRange(range),
      (error) =>
        error instanceof ObjectStoreError &&
        error.code === 'invalid_object_range',
    )
  }
})

test('measured streams preserve bytes and calculate sha256 without buffering input', async () => {
  const measured = createMeasuredStream(
    Readable.from(['hello', Buffer.from(' seaweed')]),
  )
  const body = await consume(measured.body)

  assert.equal(body.toString(), 'hello seaweed')
  assert.deepEqual(measured.result(), {
    sizeBytes: 13n,
    sha256: '7c3b5850457a332b2a35e89154b841d53bf554e66b9cd147566f40e0ca8347ec',
  })
  assert.deepEqual(measured.result(), measured.result())
})

test('storage configuration is optional until explicitly enabled', () => {
  assert.deepEqual(readObjectStorageConfig({}), {
    enabled: false,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 3,
    serverSideEncryption: undefined,
  })

  assert.throws(
    () => readObjectStorageConfig({ OBJECT_STORAGE_ENABLED: 'true' }),
    /S3_ENDPOINT is required/,
  )
})

test('enabled storage validates endpoint security and returns credentials', () => {
  const environment = {
    OBJECT_STORAGE_ENABLED: 'true',
    S3_ENDPOINT: 'http://127.0.0.1:8333/',
    S3_BUCKET: 'artifact-test',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  }

  assert.deepEqual(readObjectStorageConfig(environment), {
    enabled: true,
    endpoint: 'http://127.0.0.1:8333',
    region: 'us-east-1',
    bucket: 'artifact-test',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
    maxAttempts: 3,
    serverSideEncryption: undefined,
  })
  assert.throws(
    () => readObjectStorageConfig(environment, 'production'),
    /must use HTTPS in production/,
  )
})
