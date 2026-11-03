// Regression guards for the capacity budgets: if one of these fails, a
// change has re-opened a path where one request or one process can grow
// without bound.
import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { eq, sql } from 'drizzle-orm'

import { mockUserInfoResponse } from './auth.js'
import { SearchSlots } from './chatSearch.js'
import {
  closeDatabase,
  createChat,
  createDatabase,
  getChatDetail,
  getSharedChat,
  MESSAGE_PAGE_MAX_BYTES,
  migrateDatabase,
  shareChat,
  syncUser,
} from './db.js'
import { users } from './db/schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL

async function seedMessages(database: ReturnType<typeof createDatabase>, userId: string, chatId: string, count: number, bytes: number) {
  const text = 'x'.repeat(bytes)
  await database.execute(sql`
    insert into "Message" ("userId", "chatId", seq, role, status, content, "sharedText", parts)
    select ${userId}::uuid, ${chatId}::uuid, n, 'user', 'completed', ${text}, ${text},
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', ${text}::text))
    from generate_series(1, ${count}) n
  `)
  await database.execute(sql`update "Chat" set "nextMessageSeq" = ${count + 1} where id = ${chatId}`)
}

test('SearchSlots runs at most N searches at once and rejects waiters after the wait limit', async () => {
  const slots = new SearchSlots(2, 50)
  let running = 0
  let peak = 0
  const slow = () => slots.run(async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 120))
    running -= 1
    return 'ok'
  })
  const results = await Promise.allSettled([slow(), slow(), slow(), slow()])
  assert.equal(peak, 2)
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected'])
  // Slots are released: a later search runs.
  assert.equal(await slow(), 'ok')
})

test('a chat page never exceeds the byte budget but always returns a message', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    try {
      // 20 messages of ~400 KB (text twice: content and parts) = ~16 MB.
      const chat = await createChat(database, user.id, 'big')
      await seedMessages(database, user.id, chat.id, 20, 200_000)
      const detail = await getChatDetail(database, user.id, chat.id)
      assert.ok(detail)
      const bytes = Buffer.byteLength(JSON.stringify(detail.messages))
      assert.ok(detail.messages.length >= 1)
      assert.ok(detail.messages.length < 20, `${detail.messages.length} messages in one page`)
      assert.ok(bytes <= MESSAGE_PAGE_MAX_BYTES * 1.1, `${bytes} bytes in one page`)
      assert.equal(detail.pageInfo.hasMore, true)

      // One message larger than the whole budget is still returned alone.
      const huge = await createChat(database, user.id, 'huge')
      await seedMessages(database, user.id, huge.id, 2, 1_500_000)
      const hugeDetail = await getChatDetail(database, user.id, huge.id)
      assert.equal(hugeDetail?.messages.length, 1)
    } finally {
      await database.delete(users).where(eq(users.id, user.id))
    }
  } finally {
    await closeDatabase(database)
  }
})

test('a shared chat is served in bounded pages', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    const owner = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    const viewer = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    try {
      const chat = await createChat(database, owner.id, 'shared')
      await seedMessages(database, owner.id, chat.id, 250, 100)
      const shared = await shareChat(database, owner.id, chat.id, 'live')
      assert.ok(shared)
      const seen: number[] = []
      let afterSeq: number | undefined
      for (let page = 0; page < 10; page += 1) {
        const result = await getSharedChat(database, viewer.id, shared.shareSlug, { afterSeq, audit: false })
        assert.ok(result)
        assert.ok(result.messages.length <= 100)
        seen.push(...result.messages.map((message) => Number(message.seq)))
        if (!result.pageInfo.hasMore) break
        afterSeq = result.pageInfo.afterSeq ?? undefined
      }
      assert.equal(seen.length, 250)
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'pages are in order without overlap')
      assert.equal(new Set(seen).size, 250)
    } finally {
      await database.delete(users).where(eq(users.id, owner.id))
      await database.delete(users).where(eq(users.id, viewer.id))
    }
  } finally {
    await closeDatabase(database)
  }
})

test('repeated page reads do not grow the heap', { skip: !databaseUrl }, async () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const database = createDatabase(databaseUrl as string)
  try {
    await migrateDatabase(database)
    const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    try {
      const chat = await createChat(database, user.id, 'soak')
      await seedMessages(database, user.id, chat.id, 40, 20_000)
      const round = async () => {
        for (let index = 0; index < 50; index += 1) await getChatDetail(database, user.id, chat.id)
      }
      await round()
      gc()
      const before = process.memoryUsage().heapUsed
      for (let index = 0; index < 4; index += 1) await round()
      gc()
      const grown = process.memoryUsage().heapUsed - before
      assert.ok(grown < 8 * 1024 * 1024, `heap grew ${(grown / 1024 / 1024).toFixed(1)} MiB over 200 page reads`)
    } finally {
      await database.delete(users).where(eq(users.id, user.id))
    }
  } finally {
    await closeDatabase(database)
  }
})
