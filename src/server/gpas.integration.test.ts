import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createBusinessExchange, createChat, createDatabase, closeDatabase, getChatDetail, findBusinessExchange, migrateDatabase } from './db.js'
import { users } from './db/schema.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test('business exchanges enforce ownership, persist forms and deduplicate concurrent requests', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl!)
  let userId: string | undefined
  try {
    await migrateDatabase(database)
    const [owner] = await database.insert(users).values({ externalUserId: `gpas-test-${crypto.randomUUID()}` }).returning()
    userId = owner.id
    const chat = await createChat(database, owner.id, 'GPAS integration test')
    const request = { userId: owner.id, chatId: chat.id, content: '我的任务进度', clientMessageId: crypto.randomUUID() }
    let calls = 0
    const form = { projectCode: 'DEMO', projectName: '演示项目', phone: '13800000000', teamId: 'team-test' }
    const execute = async () => {
      calls += 1
      return { content: '请初始化项目', part: { type: 'gpas' as const, order: 1, form } }
    }
    await assert.rejects(createBusinessExchange(database, { ...request, userId: crypto.randomUUID() }, execute), /会话不存在/)
    assert.equal(calls, 0)
    const [first, replay] = await Promise.all([
      createBusinessExchange(database, request, execute),
      createBusinessExchange(database, request, execute),
    ])
    assert.equal(first.assistantMessage.id, replay.assistantMessage.id)
    assert.equal(calls, 1)
    assert.equal((await findBusinessExchange(database, owner.id, chat.id, request.clientMessageId))?.assistantMessage.id, first.assistantMessage.id)
    assert.equal(await findBusinessExchange(database, crypto.randomUUID(), chat.id, request.clientMessageId), null)
    assert.equal(await findBusinessExchange(database, owner.id, chat.id, crypto.randomUUID()), null)
    const detail = await getChatDetail(database, owner.id, chat.id)
    assert.equal(detail?.messages.length, 2)
    assert.deepEqual(detail?.messages[1].parts[1], { type: 'gpas', order: 1, form })
    const submission = { ...request, content: '确认初始化项目', clientMessageId: crypto.randomUUID(), sourceMessageId: first.assistantMessage.id, teamId: 'team-test' }
    await assert.rejects(createBusinessExchange(database, { ...submission, sourceMessageId: crypto.randomUUID() }, execute), /表单不存在/)
    await createBusinessExchange(database, submission, async (savedForm) => {
      assert.deepEqual(savedForm, form)
      return { content: '初始化成功', part: { type: 'gpas', order: 1 } }
    })
    const updated = await getChatDetail(database, owner.id, chat.id)
    assert.deepEqual(updated?.messages.map((message) => message.seq), [1, 2, 3, 4])
  } finally {
    if (userId) await database.delete(users).where(eq(users.id, userId))
    await closeDatabase(database)
  }
})
