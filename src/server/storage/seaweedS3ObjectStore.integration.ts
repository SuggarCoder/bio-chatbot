import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { readObjectStorageConfig } from '../config.js'
import { SeaweedS3ObjectStore } from './seaweedS3ObjectStore.js'

async function readText(stream: Readable): Promise<string> {
  let text = ''

  for await (const chunk of stream) {
    text += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
  }

  return text
}

test('SeaweedFS S3 adapter writes, reads ranges, heads, and deletes', async () => {
  const config = readObjectStorageConfig()

  if (!config.enabled) {
    throw new Error('OBJECT_STORAGE_ENABLED=true is required')
  }

  const objectStore = new SeaweedS3ObjectStore(config)
  const key = `integration-tests/${randomUUID()}/object`
  const content = 'SeaweedFS integration payload'

  try {
    await objectStore.healthCheck()
    const stored = await objectStore.putStream({
      key,
      body: Readable.from([content]),
      contentType: 'text/plain; charset=utf-8',
      metadata: { purpose: 'integration-test' },
    })

    assert.equal(stored.sizeBytes, BigInt(Buffer.byteLength(content)))
    assert.equal(stored.sha256.length, 64)

    const head = await objectStore.head(key)
    assert.equal(head?.sizeBytes, stored.sizeBytes)
    assert.equal(head?.metadata.purpose, 'integration-test')

    const ranged = await objectStore.getStream(key, 'bytes=0-8')
    assert.ok(ranged)
    assert.equal(await readText(ranged.body), 'SeaweedFS')
    assert.match(ranged.contentRange || '', /^bytes 0-8\//)

    const complete = await objectStore.getStream(key)
    assert.ok(complete)
    assert.equal(await readText(complete.body), content)
  } finally {
    await objectStore.delete(key).catch(() => undefined)
    objectStore.close()
  }

  const verifier = new SeaweedS3ObjectStore(config)

  try {
    assert.equal(await verifier.head(key), null)
  } finally {
    verifier.close()
  }
})
