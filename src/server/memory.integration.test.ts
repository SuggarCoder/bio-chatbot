import assert from 'node:assert/strict'
import test from 'node:test'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { createMemoryToolRunner } from './agent/memoryTools.js'
import type { BackgroundWorkItem } from './backgroundJobs.js'
import type { AppConfig } from './config.js'
import {
  closeDatabase,
  createDatabase,
  deleteChat,
  migrateDatabase,
} from './db.js'
import { chats, EMBEDDING_DIMENSIONS, messageChunks, messages, userMemories, users } from './db/schema.js'
import { MemoryProcessor, type BackgroundModelClient } from './memoryWorker.js'
import { CharacterTokenCounter } from './tokenBudget.js'
import {
  buildUserMemoryInstructions,
  listUserMemories,
  resolveMemoryAccess,
  updateMemorySettings,
  upsertUserMemory,
} from './userMemory.js'
import { episodeKey, MEMORY_POLICY, purgeExpiredMemories } from './memoryPolicy.js'
import { indexChatTurn, listRecentUserChats, searchUserChats } from './chatSearch.js'
import type { Embedder } from './embeddings.js'

const databaseUrl = process.env.TEST_DATABASE_URL

/**
 * A deterministic stand-in for the embedding model: each concept owns one
 * dimension, recognised in Chinese or English, so a query in one language
 * can only match the other through the vector.
 */
const CONCEPTS: RegExp[] = [/耐药|resistance|antibiotic/i, /定量|qpcr|\bpcr\b/i, /真菌|fung/i]
const fakeEmbedder: Embedder = {
  model: 'fake-concepts',
  async embed(texts) {
    return {
      tokens: texts.length,
      vectors: texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
        CONCEPTS.forEach((concept, index) => { if (concept.test(text)) vector[index] = 1 })
        if (!vector.some(Boolean)) vector[EMBEDDING_DIMENSIONS - 1] = 1
        return vector
      }),
    }
  },
}
const failingEmbedder: Embedder = {
  model: 'fake-concepts',
  async embed() { throw new Error('embedding service down') },
}

const config = {
  userMemoryEnabled: true,
  contextMemoryEnabled: true,
  chatSearchEnabled: true,
  userMemoryMaxItems: 40,
  userMemoryTokenBudget: 2_048,
  backgroundModel: 'test-model',
  backgroundMaxOutputTokens: 2_048,
  memoryExtractionMaxPendingTurns: 6,
  memoryConsolidationIntervalHours: 24,
  chatHistoryTokenBudget: 32_768,
} as AppConfig

type Request = { instructions: string; input: string }

function fakeModel(respond: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = []
  const client = {
    responses: {
      create: async (request: Request) => {
        requests.push(request)
        const body = await respond(request)
        return {
          status: 'completed',
          output_text: JSON.stringify(body),
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      },
    },
  } as unknown as BackgroundModelClient
  return { client, requests }
}

function memoryJob(userId: string, chatId: string, assistantSeq: number): BackgroundWorkItem {
  return {
    jobId: crypto.randomUUID(),
    userId,
    attempt: 1,
    type: 'user.memory',
    chatId,
    payload: { assistantSeq },
  }
}

test('cross-chat memory: access rules, search, deletion, tools and debounced extraction', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  const userIds: string[] = []
  try {
    await migrateDatabase(database)
    const [owner] = await database
      .insert(users)
      .values({ externalUserId: `memory-${crypto.randomUUID()}` })
      .returning({ id: users.id })
    userIds.push(owner!.id)
    const userId = owner!.id

    const newChat = async (title: string, extra: Partial<typeof chats.$inferInsert> = {}) => {
      const [chat] = await database.insert(chats).values({ userId, title, ...extra }).returning({ id: chats.id })
      return chat!.id
    }
    const addTurns = async (chatId: string, turns: Array<[string, string]>) => {
      const [chat] = await database.select({ next: chats.nextMessageSeq }).from(chats).where(eq(chats.id, chatId))
      let seq = chat!.next
      const assistantIds: string[] = []
      for (const [user, assistant] of turns) {
        const rows = await database.insert(messages).values([
          { userId, chatId, seq: seq++, role: 'user', content: user },
          { userId, chatId, seq: seq++, role: 'assistant', status: 'completed', content: assistant },
        ]).returning({ id: messages.id, role: messages.role })
        assistantIds.push(rows.find((row) => row.role === 'assistant')!.id)
      }
      await database.update(chats).set({ nextMessageSeq: seq }).where(eq(chats.id, chatId))
      return assistantIds
    }
    const index = async (chatId: string, assistantIds: string[]) => {
      for (const assistantMessageId of assistantIds) {
        await indexChatTurn(database, fakeEmbedder, { userId, chatId, assistantMessageId })
      }
    }

    const current = await newChat('当前对话')
    const metagenome = await newChat('土壤样本分析')
    const deleted = await newChat('已删除的宏基因组', { deletedAt: new Date() })
    await index(current, await addTurns(current, [['宏基因组还要再看吗', '可以']]))
    await index(metagenome, await addTurns(metagenome, [
      ['帮我看下这批土壤宏基因组样本的耐药基因', '检出了 tetM 和 sul1'],
      ['下一步做什么', '建议做定量 PCR 验证'],
    ]))
    await index(deleted, await addTurns(deleted, [['宏基因组耐药旧问题', '旧回答']]))
    const chunkCount = async (chatId: string) =>
      (await database.select({ id: messageChunks.id }).from(messageChunks).where(eq(messageChunks.chatId, chatId))).length
    assert.equal(await chunkCount(metagenome), 2)
    assert.equal(await chunkCount(deleted), 0, 'deleted chats are never indexed')
    // Re-indexing the same turn keeps its vector and makes no second call.
    const [first] = await database.select({ id: messageChunks.assistantMessageId }).from(messageChunks).where(eq(messageChunks.chatId, metagenome)).limit(1)
    assert.equal(await indexChatTurn(database, fakeEmbedder, { userId, chatId: metagenome, assistantMessageId: first!.id }), undefined)

    const search = (query: string, embedder: Embedder | null = fakeEmbedder) =>
      searchUserChats(database, embedder, { userId, query, excludeChatId: current, minSimilarity: 0.35 })
    // Keywords: only visible chats other than the current one.
    const hits = await search('宏基因组 耐药')
    assert.deepEqual(hits.map((hit) => hit.chatId), [metagenome])
    assert.match(hits[0]!.matches[0]!.excerpt, /耐药/)
    // Semantics: an English query finds the Chinese turn through its vector
    // alone, and the unrelated turn of that chat stays below the threshold.
    const semantic = await search('antibiotic resistance genes')
    assert.deepEqual(semantic.map((hit) => hit.chatId), [metagenome])
    assert.equal(semantic[0]!.matches.length, 1)
    assert.equal(semantic[0]!.matches[0]!.similarity, 1)
    assert.match(semantic[0]!.matches[0]!.excerpt, /tetM/)
    // Without the embedding service, keyword search still answers.
    assert.deepEqual((await search('耐药', failingEmbedder)).map((hit) => hit.chatId), [metagenome])
    assert.deepEqual(await search('，。', null), [])
    const recent = await listRecentUserChats(database, { userId, excludeChatId: current })
    assert.deepEqual(recent.map((chat) => chat.chatId), [metagenome])
    assert.match(recent[0]!.overview, /土壤宏基因组/)

    // Access: someone else's chat gets nothing; settings narrow the rest.
    const flags = { userId, userMemoryEnabled: true, chatSearchEnabled: true }
    assert.deepEqual(
      await resolveMemoryAccess(database, { ...flags, chatId: crypto.randomUUID() }),
      { readMemory: false, editMemory: false, searchChats: false },
    )
    assert.deepEqual(
      await resolveMemoryAccess(database, { ...flags, chatId: current }),
      { readMemory: true, editMemory: true, searchChats: true },
    )
    await updateMemorySettings(database, userId, { memoryEnabled: false })
    assert.deepEqual(
      await resolveMemoryAccess(database, { ...flags, chatId: current }),
      { readMemory: false, editMemory: false, searchChats: true },
    )
    await updateMemorySettings(database, userId, { memoryEnabled: true })

    // Tools: save and delete through the model-facing runner.
    const runner = createMemoryToolRunner(
      { database, userId, chatId: current, embedder: fakeEmbedder, minSimilarity: 0.35 },
      { readMemory: true, editMemory: true, searchChats: true },
    )!
    const saved = await runner.execute({
      call_id: 's1',
      name: 'memory__save',
      arguments: JSON.stringify({ content: '用户偏好用 R 做差异分析', category: 'preference', key: 'analysis_tool' }),
    })
    assert.equal(saved.ok, true, saved.error ?? "")
    const searched = await runner.execute({ call_id: 's2', name: 'chat__search', arguments: '{"query":"antibiotic resistance"}' })
    assert.match(searched.output, /tetM|耐药/)
    const removed = await runner.execute({ call_id: 's3', name: 'memory__delete', arguments: '{"keys":["analysis_tool"]}' })
    assert.match(removed.output, /"deleted":1/)

    // Deleting a chat forgets what was learned from it, not what the user wrote.
    await upsertUserMemory(database, { userId, key: 'from_chat', category: 'work', content: '在做土壤耐药基因', source: 'auto', sourceChatId: metagenome })
    await upsertUserMemory(database, { userId, key: 'typed', category: 'identity', content: '在某研究所工作', source: 'user', sourceChatId: null })
    assert.equal(await deleteChat(database, userId, metagenome), true)
    assert.deepEqual((await listUserMemories(database, userId)).map((row) => row.key), ['typed'])
    assert.equal(await chunkCount(metagenome), 0, 'a deleted chat drops its chunks and vectors')

    // Extraction: a burst of turns is read once, by the job of its last turn.
    const burst = await newChat('新课题')
    await addTurns(burst, [
      ['我是做植物病原真菌的', '好的'],
      ['以后回答请尽量简短', '明白'],
    ])
    const model = fakeModel(() => ({
      operations: [
        { action: 'upsert', key: 'research_field', category: 'identity', content: '用户研究植物病原真菌' },
        { action: 'upsert', key: 'answer_style', category: 'preference', content: '用户希望回答尽量简短' },
      ],
    }))
    const processor = new MemoryProcessor(config, database, new CharacterTokenCounter(), undefined, model.client)
    assert.equal(await processor.process(memoryJob(userId, burst, 2)), undefined)
    assert.equal(model.requests.length, 0, 'an earlier turn waits for the last job of the burst')
    const usage = await processor.process(memoryJob(userId, burst, 4))
    assert.equal(usage?.kind, 'memory')
    assert.equal(model.requests.length, 1)
    assert.match(model.requests[0]!.input, /植物病原真菌[\s\S]*尽量简短/)
    assert.match(model.requests[0]!.input, /"source":"user"/)
    const [cursor] = await database.select({ seq: chats.memoryExtractedSeq }).from(chats).where(eq(chats.id, burst))
    assert.equal(cursor!.seq, 4n)
    const learned = await listUserMemories(database, userId)
    assert.deepEqual(
      learned.map((row) => [row.key, row.category, row.source]).sort(),
      [['answer_style', 'preference', 'auto'], ['research_field', 'identity', 'auto'], ['typed', 'identity', 'user']],
    )
    await processor.process(memoryJob(userId, burst, 4))
    assert.equal(model.requests.length, 1, 'already-extracted turns are not read again')

    // A memory change during the model call is retried, not merged blindly.
    await addTurns(burst, [['我换去做线虫了', '好的']])
    await database.update(chats).set({ memoryExtractedSeq: 4n }).where(eq(chats.id, burst))
    const racing = fakeModel(async () => {
      await upsertUserMemory(database, { userId, key: 'concurrent', category: 'other', content: '并发写入', source: 'tool', sourceChatId: current })
      return { operations: [{ action: 'upsert', key: 'research_field', category: 'identity', content: '用户研究线虫' }] }
    })
    const racingProcessor = new MemoryProcessor(config, database, new CharacterTokenCounter(), undefined, racing.client)
    await assert.rejects(racingProcessor.process(memoryJob(userId, burst, 6)), /changed during extraction/)
    const [unchanged] = await database.select({ seq: chats.memoryExtractedSeq }).from(chats).where(eq(chats.id, burst))
    assert.equal(unchanged!.seq, 4n)

    // Deleted chats and paused memory never reach the model.
    const silent = fakeModel(() => ({ operations: [] }))
    const silentProcessor = new MemoryProcessor(config, database, new CharacterTokenCounter(), undefined, silent.client)
    await silentProcessor.process(memoryJob(userId, deleted, 2))
    await updateMemorySettings(database, userId, { memoryEnabled: false })
    await addTurns(burst, [['暂停期间说的话', '好的']])
    await silentProcessor.process(memoryJob(userId, burst, 8))
    assert.equal(silent.requests.length, 0)
    const [skipped] = await database.select({ seq: chats.memoryExtractedSeq }).from(chats).where(eq(chats.id, burst))
    assert.equal(skipped!.seq, 8n, 'turns while memory is paused are skipped for good')
    await updateMemorySettings(database, userId, { memoryEnabled: true })

    // Over the item limit, consolidation rewrites only model-written entries.
    const tight = { ...config, userMemoryMaxItems: 4 } as AppConfig
    for (let index = 0; index < 4; index += 1) {
      await upsertUserMemory(database, { userId, key: `dup_${index}`, category: 'work', content: `项目细节 ${index}`, source: 'auto', sourceChatId: burst })
    }
    await addTurns(burst, [['我在写真菌论文', '好的']])
    const consolidating = fakeModel((request) => request.instructions.includes('整理用户的跨会话长期记忆')
      ? { memories: [{ key: 'projects', category: 'work', content: '用户的项目细节 0-3，并在研究线虫', sources: ['dup_0', 'dup_1', 'dup_2', 'dup_3', 'concurrent', 'research_field', 'answer_style'] }] }
      : { operations: [] })
    const consolidator = new MemoryProcessor(tight, database, new CharacterTokenCounter(), undefined, consolidating.client)
    await consolidator.process(memoryJob(userId, burst, 10))
    assert.equal(consolidating.requests.length, 2)
    assert.match(consolidating.requests[1]!.input, /不可修改[\s\S]*typed/)
    assert.deepEqual(
      (await listUserMemories(database, userId)).map((row) => [row.key, row.source]).sort(),
      [['projects', 'auto'], ['typed', 'user']],
    )
  } finally {
    if (userIds.length > 0) {
      await database.delete(userMemories).where(inArray(userMemories.userId, userIds))
      await database.delete(users).where(inArray(users.id, userIds))
    }
    await closeDatabase(database)
  }
})

test('memory HTTP API: one switch and clear all', { skip: !databaseUrl }, async () => {
  const { buildApp } = await import('./app.js')
  const database = createDatabase(databaseUrl as string)
  await migrateDatabase(database)
  const app = await buildApp({
    config: { nodeEnv: 'test', serveClient: false, gpas2AuthMode: 'mock' } as AppConfig,
    database,
    redis: {} as never,
    generations: {} as never,
    streamHub: {} as never,
    objectStore: null,
    artifactService: null,
  })
  const base = '/ai-chatbot/api'
  let userId: string | undefined
  let chatId: string | undefined
  try {
    await app.ready()
    const chat = await app.inject({ method: 'POST', url: `${base}/conversations`, payload: { title: '记忆接口测试' } })
    assert.equal(chat.statusCode, 201)
    chatId = chat.json().id as string
    const [row] = await database.select({ userId: chats.userId }).from(chats).where(eq(chats.id, chatId))
    userId = row!.userId
    await database.delete(userMemories).where(eq(userMemories.userId, userId))

    const initial = await app.inject({ method: 'GET', url: `${base}/memory/settings` })
    assert.equal(initial.statusCode, 200)
    assert.deepEqual(initial.json(), { memoryEnabled: true, chatSearchEnabled: true })

    const off = await app.inject({ method: 'PATCH', url: `${base}/memory/settings`, payload: { memoryEnabled: false, chatSearchEnabled: false } })
    assert.deepEqual(off.json(), { memoryEnabled: false, chatSearchEnabled: false })
    await app.inject({ method: 'PATCH', url: `${base}/memory/settings`, payload: { memoryEnabled: true, chatSearchEnabled: true } })

    // Clearing removes every tier, including conversation digests.
    await upsertUserMemory(database, { userId, key: 'lab', category: 'identity', content: '在研究所工作', source: 'auto', sourceChatId: null })
    await upsertUserMemory(database, { userId, key: 'episode_x', category: 'episode', content: '讨论了样本', source: 'auto', sourceChatId: null })
    assert.equal((await app.inject({ method: 'DELETE', url: `${base}/memory` })).statusCode, 204)
    const left = await database.select({ key: userMemories.key }).from(userMemories).where(eq(userMemories.userId, userId))
    assert.deepEqual(left, [])

    // The per-entry endpoints are gone: users do not browse memories.
    assert.equal((await app.inject({ method: 'GET', url: `${base}/memory` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: `${base}/memory`, payload: { content: 'x' } })).statusCode, 404)
  } finally {
    if (userId) {
      await database.delete(userMemories).where(eq(userMemories.userId, userId))
      if (chatId) await database.delete(chats).where(eq(chats.id, chatId))
    }
    await app.close()
    await closeDatabase(database)
  }
})

test('memory tiers: digests, touch, promotion and aging', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  const userIds: string[] = []
  try {
    await migrateDatabase(database)
    const [owner] = await database
      .insert(users)
      .values({ externalUserId: `memory-tiers-${crypto.randomUUID()}` })
      .returning({ id: users.id })
    userIds.push(owner!.id)
    const userId = owner!.id
    const newChat = async (title: string) => {
      const [chat] = await database.insert(chats).values({ userId, title }).returning({ id: chats.id })
      return chat!.id
    }
    const addTurn = async (chatId: string, user: string, assistant: string) => {
      const [chat] = await database.select({ next: chats.nextMessageSeq }).from(chats).where(eq(chats.id, chatId))
      const seq = chat!.next
      await database.insert(messages).values([
        { userId, chatId, seq, role: 'user', content: user },
        { userId, chatId, seq: seq + 1n, role: 'assistant', status: 'completed', content: assistant },
      ])
      await database.update(chats).set({ nextMessageSeq: seq + 2n }).where(eq(chats.id, chatId))
      return Number(seq + 1n)
    }
    const row = async (key: string) => {
      const [found] = await database.select().from(userMemories).where(and(eq(userMemories.userId, userId), eq(userMemories.key, key)))
      return found
    }
    const days = (date: Date | null | undefined) => date ? Math.round((date.getTime() - Date.now()) / 86_400_000) : null
    const age = (key: string, input: { seenDaysAgo?: number; createdDaysAgo?: number; reinforced?: number; expiresInDays?: number }) =>
      database.update(userMemories).set({
        ...(input.seenDaysAgo !== undefined ? { lastSeenAt: sql`now() - make_interval(days => ${input.seenDaysAgo})` } : {}),
        ...(input.createdDaysAgo !== undefined ? { createdAt: sql`now() - make_interval(days => ${input.createdDaysAgo})` } : {}),
        ...(input.reinforced !== undefined ? { reinforcedCount: input.reinforced } : {}),
        ...(input.expiresInDays !== undefined ? { expiresAt: sql`now() + make_interval(secs => ${input.expiresInDays * 86_400})` } : {}),
      }).where(and(eq(userMemories.userId, userId), eq(userMemories.key, key)))

    const first = await newChat('耐药基因分析')
    const second = await newChat('论文准备')
    const model = fakeModel((request) => {
      if (request.input.includes('tetM')) {
        return {
          operations: [
            { action: 'upsert', key: 'lab', category: 'identity', content: '用户在微生物所做宏基因组' },
            { action: 'upsert', key: 'paper', category: 'current', content: '用户在准备一篇耐药基因的论文' },
          ],
          episode: '解读了土壤样本中 tetM 和 sul1 的丰度，结论是需要 qPCR 验证。',
        }
      }
      return { operations: [{ action: 'touch', key: 'paper' }], episode: '继续讨论论文的图表安排。' }
    })
    const processor = new MemoryProcessor(config, database, new CharacterTokenCounter(), undefined, model.client)

    // Profile and recent memories, plus the chat's digest.
    await processor.process(memoryJob(userId, first, await addTurn(first, '我在微生物所，这批样本检出 tetM 了，我在写论文', '好的')))
    const lab = await row('lab')
    const paper = await row('paper')
    const digest = await row(episodeKey(first))
    assert.equal(lab?.expiresAt, null, 'profile memories never expire')
    assert.equal(days(paper?.expiresAt), MEMORY_POLICY.recentTtlDays)
    assert.equal(digest?.category, 'episode')
    assert.equal(days(digest?.expiresAt), MEMORY_POLICY.episodeTtlDays)

    // Another chat sees the digest as recent history; the chat itself does not.
    const counter = new CharacterTokenCounter()
    const forSecond = await buildUserMemoryInstructions(database, userId, { tokenBudget: 4_000, maxItems: 40, tokenCounter: counter, chatId: second })
    assert.match(forSecond, /### 近期对话\n- \d{4}-\d{2}-\d{2}：解读了土壤样本中 tetM/)
    const forFirst = await buildUserMemoryInstructions(database, userId, { tokenBudget: 4_000, maxItems: 40, tokenCounter: counter, chatId: first })
    assert.doesNotMatch(forFirst, /### 近期对话/)

    // Mentioning recent focus again in another chat keeps it alive and counts.
    await age('paper', { seenDaysAgo: 20, expiresInDays: 10 })
    await processor.process(memoryJob(userId, second, await addTurn(second, '论文的图怎么排？', '建议……')))
    const touched = await row('paper')
    assert.equal(days(touched?.expiresAt), MEMORY_POLICY.recentTtlDays)
    assert.equal(touched?.reinforcedCount, 2)
    assert.equal(touched?.category, 'current')
    assert.ok((await row(episodeKey(second)))?.content.includes('图表'))

    // Recent focus that keeps coming back for weeks becomes long-term work.
    await age('paper', { createdDaysAgo: MEMORY_POLICY.promoteMinAgeDays + 1, reinforced: MEMORY_POLICY.promoteMinReinforcements })
    await processor.process(memoryJob(userId, second, await addTurn(second, '论文图再调一下', '好的')))
    const promoted = await row('paper')
    assert.equal(promoted?.category, 'work')
    assert.equal(promoted?.expiresAt, null)

    // Aged-out memories disappear from reads at once and from storage on purge.
    await upsertUserMemory(database, { userId, key: 'old_focus', category: 'current', content: '用户上个月在调 PCR 引物', source: 'auto', sourceChatId: first })
    await age('old_focus', { expiresInDays: -0.001 })
    await age(episodeKey(first), { seenDaysAgo: MEMORY_POLICY.episodeInjectDays + 1 })
    assert.ok(!(await listUserMemories(database, userId)).some((memory) => memory.key === 'old_focus'))
    const later = await buildUserMemoryInstructions(database, userId, { tokenBudget: 4_000, maxItems: 40, tokenCounter: counter })
    assert.doesNotMatch(later, /PCR 引物/)
    assert.doesNotMatch(later, /tetM/, 'digests older than the injection window are not injected')
    assert.ok(await purgeExpiredMemories(database) >= 1)
    assert.equal(await row('old_focus'), undefined)
    assert.ok(await row(episodeKey(first)), 'a digest past the injection window is kept until it expires')
  } finally {
    if (userIds.length > 0) {
      await database.delete(userMemories).where(inArray(userMemories.userId, userIds))
      await database.delete(users).where(inArray(users.id, userIds))
    }
    await closeDatabase(database)
  }
})

test('aborting a background job cancels its model call and leaves the cursor', { skip: !databaseUrl }, async () => {
  const database = createDatabase(databaseUrl as string)
  const userIds: string[] = []
  try {
    await migrateDatabase(database)
    const [owner] = await database
      .insert(users)
      .values({ externalUserId: `memory-abort-${crypto.randomUUID()}` })
      .returning({ id: users.id })
    userIds.push(owner!.id)
    const [chat] = await database.insert(chats).values({ userId: owner!.id, title: 'abort', nextMessageSeq: 3n }).returning({ id: chats.id })
    await database.insert(messages).values([
      { userId: owner!.id, chatId: chat!.id, seq: 1n, role: 'user', content: '我在做真菌组学' },
      { userId: owner!.id, chatId: chat!.id, seq: 2n, role: 'assistant', status: 'completed', content: '好的' },
    ])
    let sawSignal = false
    const client = {
      responses: {
        create: (_body: unknown, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          sawSignal = Boolean(options?.signal)
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        }),
      },
    } as unknown as BackgroundModelClient
    const processor = new MemoryProcessor(config, database, new CharacterTokenCounter(), undefined, client)
    const controller = new AbortController()
    const running = processor.process(memoryJob(owner!.id, chat!.id, 2), controller.signal)
    setTimeout(() => controller.abort(new Error('deadline')), 50)
    await assert.rejects(running, /deadline/)
    assert.equal(sawSignal, true)
    const [cursor] = await database.select({ seq: chats.memoryExtractedSeq }).from(chats).where(eq(chats.id, chat!.id))
    assert.equal(cursor!.seq, 0n, 'nothing was recorded; the retry reads the same turns')
  } finally {
    if (userIds.length > 0) {
      await database.delete(userMemories).where(inArray(userMemories.userId, userIds))
      await database.delete(users).where(inArray(users.id, userIds))
    }
    await closeDatabase(database)
  }
})
