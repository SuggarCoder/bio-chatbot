import 'dotenv/config'

import { readObjectStorageConfig } from './config.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'

const config = readObjectStorageConfig()

if (!config.enabled || !config.endpoint || !config.bucket) {
  throw new Error(
    'Set OBJECT_STORAGE_ENABLED=true and configure the S3 connection first',
  )
}

const objectStore = new SeaweedS3ObjectStore(config)

try {
  await objectStore.healthCheck()

  const unsignedUrl = new URL(config.endpoint)
  unsignedUrl.pathname = [
    unsignedUrl.pathname.replace(/\/$/, ''),
    encodeURIComponent(config.bucket),
  ].filter(Boolean).join('/')
  unsignedUrl.searchParams.set('list-type', '2')
  unsignedUrl.searchParams.set('max-keys', '1')

  const unsignedResponse = await fetch(unsignedUrl, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(3_000),
  })

  if (![401, 403].includes(unsignedResponse.status)) {
    throw new Error(
      `Anonymous bucket access must be denied; received HTTP ${unsignedResponse.status}`,
    )
  }

  console.log(
    `Object storage is ready: signed access succeeded and anonymous access was denied for bucket ${config.bucket}`,
  )
} finally {
  objectStore.close()
}
