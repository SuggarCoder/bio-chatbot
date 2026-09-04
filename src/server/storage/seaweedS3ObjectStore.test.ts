import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ObjectStorageConfig } from '../config.js'
import { ObjectStoreError } from './objectStore.js'
import { SeaweedS3ObjectStore } from './seaweedS3ObjectStore.js'

const config: ObjectStorageConfig = {
  enabled: true,
  endpoint: 'http://s3:8333',
  region: 'us-east-1',
  bucket: 'artifact-test',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  forcePathStyle: true,
  maxAttempts: 1,
}

function s3Error(name: string, statusCode: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: statusCode },
  })
}

test('bucket initialization leaves an existing bucket unchanged', async () => {
  const commands: unknown[] = []
  const client = {
    send: async (command: unknown) => {
      commands.push(command)
      return {}
    },
  } as unknown as S3Client
  const objectStore = new SeaweedS3ObjectStore(config, client)

  assert.equal(await objectStore.ensureBucket(), 'existing')
  assert.equal(commands.length, 1)
  assert.ok(commands[0] instanceof HeadBucketCommand)
})

test('bucket initialization creates a missing bucket and verifies it', async () => {
  const commands: unknown[] = []
  const client = {
    send: async (command: unknown) => {
      commands.push(command)
      if (commands.length === 1) throw s3Error('NotFound', 404)
      return {}
    },
  } as unknown as S3Client
  const objectStore = new SeaweedS3ObjectStore(config, client)

  assert.equal(await objectStore.ensureBucket(), 'created')
  assert.equal(commands.length, 3)
  assert.ok(commands[0] instanceof HeadBucketCommand)
  assert.ok(commands[1] instanceof CreateBucketCommand)
  assert.ok(commands[2] instanceof HeadBucketCommand)
})

test('bucket initialization does not create after an authorization error', async () => {
  const commands: unknown[] = []
  const client = {
    send: async (command: unknown) => {
      commands.push(command)
      throw s3Error('AccessDenied', 403)
    },
  } as unknown as S3Client
  const objectStore = new SeaweedS3ObjectStore(config, client)

  await assert.rejects(
    objectStore.ensureBucket(),
    (error) => error instanceof ObjectStoreError &&
      error.code === 'access_denied',
  )
  assert.equal(commands.length, 1)
  assert.ok(commands[0] instanceof HeadBucketCommand)
})
