import assert from 'node:assert/strict'
import test from 'node:test'
import { and, eq, inArray } from 'drizzle-orm'

import {
  closeDatabase,
  createDatabase,
  deleteMessageVote,
  migrateDatabase,
  setMessageVote,
} from './db.js'
import {
  chats,
  messages,
  users,
  votes,
} from './db/schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test(
  'message votes can be created, changed, and removed by the message owner',
  { skip: !databaseUrl },
  async () => {
    const database = createDatabase(databaseUrl as string)
    const userIds: string[] = []

    try {
      await migrateDatabase(database)
      const insertedUsers = await database
        .insert(users)
        .values([
          { externalUserId: `vote-owner-${crypto.randomUUID()}` },
          { externalUserId: `vote-other-${crypto.randomUUID()}` },
        ])
        .returning({ id: users.id })
      userIds.push(...insertedUsers.map((user) => user.id))
      const [owner, otherUser] = insertedUsers
      const [chat] = await database
        .insert(chats)
        .values({ userId: owner.id, title: 'Vote test' })
        .returning({ id: chats.id })
      const [assistantMessage, userMessage] = await database
        .insert(messages)
        .values([
          {
            userId: owner.id,
            chatId: chat.id,
            seq: 1n,
            role: 'assistant',
            content: 'Test answer',
          },
          {
            userId: owner.id,
            chatId: chat.id,
            seq: 2n,
            role: 'user',
            content: 'Test prompt',
          },
        ])
        .returning({ id: messages.id })

      assert.equal(
        await setMessageVote(database, owner.id, assistantMessage.id, true),
        'up',
      )
      assert.equal(
        await setMessageVote(database, owner.id, assistantMessage.id, false),
        'down',
      )

      const storedVotes = await database
        .select({ isUpvoted: votes.isUpvoted })
        .from(votes)
        .where(and(
          eq(votes.messageId, assistantMessage.id),
          eq(votes.userId, owner.id),
        ))
      assert.deepEqual(storedVotes, [{ isUpvoted: false }])

      assert.equal(
        await setMessageVote(database, otherUser.id, assistantMessage.id, true),
        null,
      )
      assert.equal(
        await setMessageVote(database, owner.id, userMessage.id, true),
        null,
      )
      assert.equal(
        await deleteMessageVote(database, owner.id, assistantMessage.id),
        true,
      )
      assert.equal(
        await deleteMessageVote(database, owner.id, assistantMessage.id),
        false,
      )
    } finally {
      if (userIds.length > 0) {
        await database.delete(users).where(inArray(users.id, userIds))
      }
      await closeDatabase(database)
    }
  },
)
