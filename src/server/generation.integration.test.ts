import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { eq } from 'drizzle-orm'

import { mockUserInfoResponse } from './auth.js'
import { createRedisClient } from './cache.js'
import { readConfig } from './config.js'
import {
  closeDatabase,
  createChat,
  createDatabase,
  createGenerationStart,
  migrateDatabase,
  syncUser,
} from './db.js'
import { generations, messages, users } from './db/schema.js'
import { GenerationService } from './generation.js'
import { GenerationFinalizer } from './generationFinalizer.js'
import { claimGeneration, loadGenerationWorkItem } from './generationQueue.js'
import { GenerationRuntimeRegistry } from './generationRuntimeRegistry.js'
import { CharacterTokenCounter } from './tokenBudget.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL

/** An OpenAI-compatible Responses endpoint that streams the given deltas. */
async function fakeModel(deltas: string[]): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: Record<string, unknown>) =>
        response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'response.created', response: { id: 'resp_test', output: [] } })
      for (const delta of deltas) send({ type: 'response.output_text.delta', delta })
      send({
        type: 'response.completed',
        response: { id: 'resp_test', output: [], usage: { input_tokens: 10, output_tokens: deltas.length } },
      })
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, server }
}

async function runGeneration(deltas: string[], env: Record<string, string> = {}) {
  const model = await fakeModel(deltas)
  const saved = { ...process.env }
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: `test:generation:${crypto.randomUUID()}:`,
    QWEN_API_KEY: 'test',
    QWEN_BASE_URL: model.url,
    REQUEST_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GPAS2_AUTH_MODE: 'mock',
    ...env,
  })
  const config = readConfig()
  process.env = saved
  const database = createDatabase(databaseUrl as string)
  const redis = createRedisClient(config)
  await redis.connect()
  let userId: string | undefined
  try {
    await migrateDatabase(database)
    const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
    userId = user.id
    const chat = await createChat(database, user.id, 'byte budget')
    const generationId = crypto.randomUUID()
    await createGenerationStart(database, {
      userId: user.id,
      chatId: chat.id,
      clientMessageId: crypto.randomUUID(),
      content: '请介绍一下宏基因组分析',
      generationId,
      streamId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      provider: 'qwen',
      model: 'test-model',
      contextMemoryEnabled: config.contextMemoryEnabled,
    })
    await database.update(generations).set({ status: 'queued' }).where(eq(generations.id, generationId))
    const item = await loadGenerationWorkItem(database, { userId: user.id, generationId, attempt: 0 })
    assert.ok(item)
    assert.equal(await claimGeneration(database, item, 'test-worker'), true)

    const runtimes = new GenerationRuntimeRegistry(config, redis)
    const finalizer = new GenerationFinalizer(config, database, redis, runtimes)
    const service = new GenerationService(
      config, database, redis, runtimes, finalizer, null, new CharacterTokenCounter(), null,
    )
    await service.execute(item)
    await service.shutdown()

    const [generation] = await database
      .select({ status: generations.status, errorCode: generations.errorCode, metadata: generations.metadata })
      .from(generations)
      .where(eq(generations.id, generationId))
    const [assistant] = await database
      .select({ content: messages.content, parts: messages.parts })
      .from(messages)
      .where(eq(messages.generationId, generationId))
    return { generation: generation!, assistant: assistant!, capBytes: config.generationMaxBytes }
  } finally {
    if (userId) await database.delete(users).where(eq(users.id, userId))
    await redis.close()
    await closeDatabase(database)
    model.server.close()
  }
}

test('a generation stores its streamed text as parts and records its byte use', { skip: !databaseUrl || !redisUrl }, async () => {
  const deltas = Array.from({ length: 300 }, (_, index) => index % 7 === 0 ? `段落 ${index}\n` : `宏基因组 token${index} `)
  const { generation, assistant } = await runGeneration(deltas)
  const text = deltas.join('')
  assert.equal(generation.status, 'completed')
  assert.equal(assistant.content, text)
  const textParts = (assistant.parts as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text')
  assert.deepEqual(textParts.map((part) => part.text), [text])
  const memory = (generation.metadata as { memory?: Record<string, unknown> }).memory
  assert.equal(memory?.outputBytes, Buffer.byteLength(text, 'utf8'))
  assert.ok((memory?.inputBytes as number) > 0)
  assert.equal(memory?.limited, false)
})

test('a generation over GENERATION_MAX_BYTES stops like a length limit and keeps its text', { skip: !databaseUrl || !redisUrl }, async () => {
  const chunk = '超长输出 overflow '.repeat(400)
  const deltas = Array.from({ length: 800 }, () => chunk)
  const { generation, assistant, capBytes } = await runGeneration(deltas, { GENERATION_MAX_BYTES: String(2 * 1024 * 1024) })
  assert.equal(generation.errorCode, 'generation_byte_limit')
  const memory = (generation.metadata as { memory?: { limited: boolean; totalBytes: number; capBytes: number } }).memory
  assert.equal(memory?.limited, true)
  assert.equal(memory?.capBytes, capBytes)
  // The streamed part is saved, and it stopped near the cap, not at the end.
  const saved = Buffer.byteLength(assistant.content ?? '', 'utf8')
  assert.ok(saved > 0 && saved <= capBytes, `${saved} bytes saved`)
  assert.ok(saved < Buffer.byteLength(deltas.join(''), 'utf8'))
})
