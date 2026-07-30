import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createChat,
  createDatabase,
  createGenerationStart,
  finalizeGeneration,
  getChatDetail,
  rebuildChatContext,
  requestGenerationCancellation,
} from './db.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test(
  'cancel intent permits the next generation and persists partial output',
  { skip: !databaseUrl },
  async () => {
    const database = createDatabase(databaseUrl as string)
    const externalUserId = `test-${crypto.randomUUID()}`
    const userResult = await database.query<{ id: string }>(
      `INSERT INTO "User" ("externalUserId")
       VALUES ($1)
       RETURNING "id"`,
      [externalUserId],
    )
    const userId = userResult.rows[0].id
    const generationIds = [crypto.randomUUID(), crypto.randomUUID()]

    try {
      const chat = await createChat(database, userId, 'Cancellation test')
      const first = await createGenerationStart(database, {
        userId,
        chatId: chat.id,
        clientMessageId: crypto.randomUUID(),
        content: 'first prompt',
        generationId: generationIds[0],
        streamId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        provider: 'test',
        model: 'test',
      })
      const cancelled = await requestGenerationCancellation(
        database,
        userId,
        first.generationId,
      )
      const repeated = await requestGenerationCancellation(
        database,
        userId,
        first.generationId,
      )

      assert.equal(cancelled?.effectiveStatus, 'cancelling')
      assert.equal(
        repeated?.cancelRequestedAt,
        cancelled?.cancelRequestedAt,
      )

      await createGenerationStart(database, {
        userId,
        chatId: chat.id,
        clientMessageId: crypto.randomUUID(),
        content: 'second prompt',
        generationId: generationIds[1],
        streamId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        provider: 'test',
        model: 'test',
      })

      const finalized = await finalizeGeneration(database, {
        generationId: first.generationId,
        userId,
        desiredStatus: 'completed',
        content: 'partial answer',
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        latencyMs: 20,
        timeToFirstTokenMs: 5,
        finishReason: 'completed',
      })

      assert.equal(finalized.generation.status, 'cancelled')
      assert.equal(finalized.assistantMessage?.status, 'cancelled')
      assert.equal(finalized.assistantMessage?.content, 'partial answer')

      const detail = await getChatDetail(database, userId, chat.id)
      assert.equal(
        detail?.messages.at(-1)?.status,
        'cancelled',
      )
      assert.equal(
        detail?.activeGeneration?.id,
        generationIds[1],
      )

      const context = await rebuildChatContext(database, userId, chat.id)
      assert.deepEqual(
        context?.messages.map((message) => message.content),
        ['first prompt', 'second prompt'],
      )
    } finally {
      await database.query(
        `DELETE FROM "UsageEvent"
          WHERE "generationId" = ANY($1::uuid[])`,
        [generationIds],
      )
      await database.query(
        `DELETE FROM "Generation"
          WHERE "id" = ANY($1::uuid[])`,
        [generationIds],
      )
      await database.query(
        `DELETE FROM "User" WHERE "id" = $1`,
        [userId],
      )
      await database.end()
    }
  },
)
