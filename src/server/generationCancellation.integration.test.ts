import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, inArray, sql } from 'drizzle-orm'

import {
  closeDatabase,
  createChat,
  createDatabase,
  createGenerationStart,
  finalizeGeneration,
  getChatDetail,
  markGenerationStreaming,
  migrateDatabase,
  rebuildChatContext,
  requestGenerationCancellation,
} from './db.js'
import {
  generations,
  messages,
  usageEvents,
  users,
} from './db/schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test(
  'cancel intent permits the next generation and persists partial output',
  { skip: !databaseUrl },
  async () => {
    const database = createDatabase(databaseUrl as string)
    await migrateDatabase(database)
    await migrateDatabase(database)
    const catalog = await database.execute<{
      messageTable: string | null
      voteTable: string | null
    }>(sql`
      select
        to_regclass('"Message"')::text as "messageTable",
        to_regclass('"Vote"')::text as "voteTable"
    `)
    assert.ok(catalog.rows[0]?.messageTable)
    assert.ok(catalog.rows[0]?.voteTable)
    const externalUserId = `test-${crypto.randomUUID()}`
    const [user] = await database
      .insert(users)
      .values({ externalUserId })
      .returning({ id: users.id })
    const userId = user.id
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
      await assert.rejects(
        database
          .update(messages)
          .set({ sharedText: 'rewritten' })
          .where(eq(messages.id, first.userMessage.id)),
        (error) => {
          const cause =
            typeof error === 'object' && error !== null && 'cause' in error
              ? String(error.cause)
              : ''
          return `${String(error)} ${cause}`.includes(
            'Message rows are immutable after insert',
          )
        },
      )
      await database
        .update(generations)
        .set({ status: 'scheduled' })
        .where(eq(generations.id, first.generationId))
      assert.equal(
        await markGenerationStreaming(database, first.generationId),
        true,
      )
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
        executionSteps: [
          {
            id: 'context',
            kind: 'context',
            label: '加载会话上下文',
            status: 'completed',
          },
          {
            id: 'response',
            kind: 'response',
            label: '生成回答',
            status: 'active',
          },
        ],
      })

      assert.equal(finalized.generation.status, 'cancelled')
      assert.equal(finalized.assistantMessage?.status, 'cancelled')
      assert.equal(finalized.assistantMessage?.content, 'partial answer')
      assert.equal(
        finalized.assistantMessage?.executionSteps.at(-1)?.status,
        'interrupted',
      )

      const detail = await getChatDetail(database, userId, chat.id)
      const cancelledMessage = detail?.messages.find(
        (message) => message.id === finalized.assistantMessage?.id,
      )
      assert.equal(
        cancelledMessage?.status,
        'cancelled',
      )
      assert.equal(
        cancelledMessage?.executionSteps.at(-1)?.status,
        'interrupted',
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
      await database
        .delete(usageEvents)
        .where(inArray(usageEvents.generationId, generationIds))
      await database
        .delete(generations)
        .where(inArray(generations.id, generationIds))
      await database.delete(users).where(eq(users.id, userId))
      await closeDatabase(database)
    }
  },
)
