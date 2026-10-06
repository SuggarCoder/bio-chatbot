import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
  createDatabase, closeDatabase, migrateDatabase, createChat, createBusinessExchange,
  createGenerationStart, requestGenerationCancellation, syncUser,
} from './db.js'
import { businessOperations, generations, users } from './db/schema.js'
import { claimGeneration, loadGenerationWorkItem } from './generationQueue.js'
import { mockUserInfoResponse } from './auth.js'

const url = process.env.TEST_DATABASE_URL

test('business HTTP releases all four pool slots, persists uncertain outcomes and replays results', { skip: !url }, async () => {
  const database = createDatabase(url!, 4)
  await migrateDatabase(database)
  const owner = await syncUser(database, { ...mockUserInfoResponse.data!, userId: `review-${crypto.randomUUID()}` })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = 0
  const pending: Promise<unknown>[] = []
  try {
    const chats = await Promise.all(Array.from({ length: 4 }, () => createChat(database, owner.id, 'pool test')))
    for (const chat of chats) pending.push(createBusinessExchange(database, {
      userId: owner.id, chatId: chat.id, clientMessageId: crypto.randomUUID(), content: 'progress',
    }, async () => { entered += 1; await gate; return { content: 'ok', part: { type: 'gpas', order: 1 } } }))
    const deadline = Date.now() + 5_000
    while (entered < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(entered, 4)
    assert.equal(database.$client.idleCount, database.$client.totalCount)
    await database.execute(sql`select 1`)
    release()
    await Promise.all(pending)

    const chat = await createChat(database, owner.id, 'mutation test')
    const form = await createBusinessExchange(database, {
      userId: owner.id, chatId: chat.id, clientMessageId: crypto.randomUUID(), content: 'form',
    }, async () => ({ content: 'form', part: { type: 'gpas', order: 1,
      form: { projectCode: 'p', projectName: 'p', phone: '1', teamId: 'review-team' } } }))
    const input = { userId: owner.id, chatId: chat.id, clientMessageId: crypto.randomUUID(), content: 'create',
      sourceMessageId: form.assistantMessage.id, teamId: 'review-team' }
    let calls = 0
    await assert.rejects(createBusinessExchange(database, input, async () => { calls += 1; throw new Error('network timeout after send') }))
    await assert.rejects(createBusinessExchange(database, input, async () => { calls += 1; return { content: 'bad', part: { type: 'gpas', order: 1 } } }), /核对/)
    assert.equal(calls, 1)
    const [operation] = await database.select().from(businessOperations).where(eq(businessOperations.requestId, input.clientMessageId))
    assert.equal(operation.status, 'uncertain')

    // Simulate a crash after storing the upstream result but before committing messages.
    const resume = { userId: owner.id, chatId: chats[0].id, clientMessageId: crypto.randomUUID(), content: 'resume' }
    await database.insert(businessOperations).values({ userId: owner.id, chatId: resume.chatId, requestId: resume.clientMessageId,
      token: crypto.randomUUID(), status: 'result_ready', expiresAt: new Date(), result: { content: 'stored', part: { type: 'gpas', order: 1 } } })
    const replay = await createBusinessExchange(database, resume, async () => { throw new Error('must not call upstream again') })
    assert.equal(replay.assistantMessage.content, 'stored')
  } finally {
    release()
    await Promise.allSettled(pending)
    await database.delete(users).where(eq(users.id, owner.id))
    await closeDatabase(database)
  }
})

test('database FIFO rejects C while earlier B is created or queued, regardless of Redis order', { skip: !url }, async () => {
  const database = createDatabase(url!)
  await migrateDatabase(database)
  const owner = await syncUser(database, { ...mockUserInfoResponse.data!, userId: `fifo-${crypto.randomUUID()}` })
  try {
    const chat = await createChat(database, owner.id, 'FIFO test')
    const starts = []
    for (const content of ['A', 'B', 'C']) {
      starts.push(await createGenerationStart(database, { userId: owner.id, chatId: chat.id, content,
        clientMessageId: crypto.randomUUID(), requestId: crypto.randomUUID(), generationId: crypto.randomUUID(),
        streamId: crypto.randomUUID(), provider: 'mock', model: 'mock' }))
    }
    await requestGenerationCancellation(database, owner.id, starts[0].generationId)
    await database.update(generations).set({ status: 'queued' }).where(eq(generations.id, starts[2].generationId))
    const c = await loadGenerationWorkItem(database, { userId: owner.id, generationId: starts[2].generationId, attempt: 0 })
    assert.ok(c)
    assert.equal(await claimGeneration(database, c, 'worker'), false)
    await database.update(generations).set({ status: 'queued' }).where(eq(generations.id, starts[1].generationId))
    assert.equal(await claimGeneration(database, c, 'worker'), false)
    await requestGenerationCancellation(database, owner.id, starts[1].generationId)
    assert.equal(await claimGeneration(database, c, 'worker'), true)
  } finally {
    await database.delete(users).where(eq(users.id, owner.id))
    await closeDatabase(database)
  }
})
