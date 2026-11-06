import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'

import {
  closeDatabase,
  createChat,
  createDatabase,
  createGenerationStart,
  migrateDatabase,
  requestGenerationCancellation,
} from './db.js'
import { generations, outboxEvents, users } from './db/schema.js'
import { markOutboxFailed } from './generationQueue.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test(
  'a generation that ends before dispatch keeps no encrypted Cookie',
  { skip: !databaseUrl },
  async () => {
    const database = createDatabase(databaseUrl as string)
    await migrateDatabase(database)
    const [user] = await database
      .insert(users)
      .values({ externalUserId: `test-${crypto.randomUUID()}` })
      .returning({ id: users.id })
    const userId = user.id

    const start = async () => {
      const chat = await createChat(database, userId, 'Credential test')
      const generationId = crypto.randomUUID()
      await createGenerationStart(database, {
        userId,
        chatId: chat.id,
        clientMessageId: crypto.randomUUID(),
        content: 'prompt',
        generationId,
        streamId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        provider: 'test',
        model: 'test-model',
        credential: 'sealed-cookie',
      })
      return generationId
    }
    const read = async (id: string) => {
      const [row] = await database
        .select({ status: generations.status, credential: generations.credential })
        .from(generations)
        .where(eq(generations.id, id))
      return row
    }

    try {
      const cancelled = await start()
      assert.equal((await read(cancelled))?.credential, 'sealed-cookie')
      await requestGenerationCancellation(database, userId, cancelled)
      assert.deepEqual(await read(cancelled), { status: 'cancelled', credential: null })

      const undeliverable = await start()
      const [outbox] = await database
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, undeliverable))
      assert.ok(outbox)
      await markOutboxFailed(database, { ...outbox, attempts: 19, generationAttempt: 0, schedulingWeight: 1 }, new Error('redis down'))
      assert.deepEqual(await read(undeliverable), { status: 'failed', credential: null })
    } finally {
      await database.delete(users).where(eq(users.id, userId))
      await closeDatabase(database)
    }
  },
)
