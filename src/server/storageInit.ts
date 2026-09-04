import 'dotenv/config'

import { readObjectStorageConfig } from './config.js'
import { SeaweedS3ObjectStore } from './storage/seaweedS3ObjectStore.js'

const environment = { ...process.env }
const adminCredentialsConfigured =
  environment.S3_ADMIN_ACCESS_KEY_ID ||
  environment.S3_ADMIN_SECRET_ACCESS_KEY

if (adminCredentialsConfigured) {
  environment.S3_ACCESS_KEY_ID = environment.S3_ADMIN_ACCESS_KEY_ID
  environment.S3_SECRET_ACCESS_KEY = environment.S3_ADMIN_SECRET_ACCESS_KEY
}

const config = readObjectStorageConfig(environment)

if (!config.enabled) {
  console.log('Object storage is disabled; bucket initialization skipped')
} else {
  const objectStore = new SeaweedS3ObjectStore(config)

  try {
    const result = await objectStore.ensureBucket()
    console.log(`Object storage bucket ${config.bucket} is ${result}`)
  } finally {
    objectStore.close()
  }
}
