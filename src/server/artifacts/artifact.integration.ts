import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'

import {
  closeDatabase,
  createDatabase,
  migrateDatabase,
} from '../db.js'
import {
  artifacts,
  artifactVersions,
  chats,
  generations,
  messages,
  users,
} from '../db/schema.js'
import { SeaweedS3ObjectStore } from '../storage/seaweedS3ObjectStore.js'
import { commitPreparedArtifact, getArtifactVersionForUser } from './repository.js'
import { ArtifactService } from './service.js'

const run = process.env.RUN_ARTIFACT_INTEGRATION === 'true'
const databaseUrl = process.env.TEST_DATABASE_URL
const endpoint = process.env.TEST_S3_ENDPOINT
const bucket = process.env.TEST_S3_BUCKET

test('Artifact create/replace is append-only and tenant isolated', {
  skip: !run || !databaseUrl || !endpoint || !bucket,
}, async () => {
  if (!databaseUrl || !endpoint || !bucket) return
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')
  const parsedDatabase = new URL(databaseUrl)
  const parsedStorage = new URL(endpoint)
  if (
    !['localhost', '127.0.0.1'].includes(parsedDatabase.hostname) ||
    !['localhost', '127.0.0.1'].includes(parsedStorage.hostname)
  ) {
    throw new Error('Artifact integration tests require local TEST_* services')
  }

  const database = createDatabase(databaseUrl)
  await migrateDatabase(database)
  const objectStore = new SeaweedS3ObjectStore({
    enabled: true,
    endpoint,
    bucket,
    region: process.env.TEST_S3_REGION || 'us-east-1',
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY || 'test',
    forcePathStyle: true,
    maxAttempts: 2,
  })
  const service = new ArtifactService(database, objectStore)
  const userId = randomUUID()
  const otherUserId = randomUUID()
  const chatId = randomUUID()
  const messageId = randomUUID()
  const generationId = randomUUID()
  const preparedKeys: string[] = []

  try {
    await database.insert(users).values([
      { id: userId, externalUserId: `artifact-test-${userId}` },
      { id: otherUserId, externalUserId: `artifact-test-${otherUserId}` },
    ])
    await database.insert(chats).values({ id: chatId, userId, title: 'Artifact test' })
    await database.insert(messages).values({
      id: messageId,
      chatId,
      seq: 1n,
      role: 'assistant',
      status: 'completed',
      parts: [],
    })
    await database.insert(generations).values({
      id: generationId,
      chatId,
      userId,
      provider: 'test',
      model: 'test',
      requestId: `artifact-test-${generationId}`,
    })

    const prepare = async (
      content: string,
      op: 'create' | 'replace',
      baseVersion?: number,
    ) => {
      const sha256 = createHash('sha256').update(content).digest('hex')
      const prepared = await service.prepare(userId, chatId, {
        streamArtifactId: randomUUID(),
        metadata: {
          v: '1',
          id: 'dashboard',
          op,
          type: 'text/html',
          title: 'Dashboard',
          ...(baseVersion ? { base_version: baseVersion } : {}),
        },
        content,
        byteLength: Buffer.byteLength(content),
        sha256,
      })
      preparedKeys.push(prepared.storageKey)
      return prepared
    }

    const first = await prepare('<h1>one</h1>', 'create')
    await database.transaction((transaction) => commitPreparedArtifact(transaction, {
      userId,
      chatId,
      messageId,
      generationId,
      prepared: first,
    }))
    const second = await prepare('<h1>two</h1>', 'replace', 1)
    await database.transaction((transaction) => commitPreparedArtifact(transaction, {
      userId,
      chatId,
      messageId,
      generationId,
      prepared: second,
    }))

    const history = await database
      .select({ version: artifactVersions.version })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, first.artifactId))
      .orderBy(artifactVersions.version)
    assert.deepEqual(history.map((item) => item.version), [1, 2])
    assert.equal(
      await getArtifactVersionForUser(database, otherUserId, first.artifactId, 2),
      null,
    )
  } finally {
    await Promise.allSettled(preparedKeys.map((key) => objectStore.delete(key)))
    await database.delete(artifactVersions).where(eq(artifactVersions.sourceGenerationId, generationId))
    await database.delete(artifacts).where(eq(artifacts.chatId, chatId))
    await database.delete(generations).where(eq(generations.id, generationId))
    await database.delete(messages).where(eq(messages.id, messageId))
    await database.delete(chats).where(eq(chats.id, chatId))
    await database.delete(users).where(eq(users.id, userId))
    await database.delete(users).where(eq(users.id, otherUserId))
    objectStore.close()
    await closeDatabase(database)
  }
})

