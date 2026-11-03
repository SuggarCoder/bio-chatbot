// Fault-injection acceptance test for the worker: runs the real worker
// process against a private Redis and a scratch PostgreSQL database with a
// fake streaming model, then breaks its dependencies and checks that it
// survives and keeps completing work.
//
//   FAULT_DATABASE_URL=postgres://user@host:5432/postgres \
//   QWEN_TOKENIZER_PATH=/path/to/qwen-tokenizer \
//   npm run test:faults
//
// Needs `redis-server` on PATH. Creates and drops its own database.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import pg from 'pg'

import { mockUserInfoResponse } from '../src/server/auth.ts'
import { closeDatabase, createChat, createDatabase, createGenerationStart, migrateDatabase, syncUser } from '../src/server/db.ts'
import { generations } from '../src/server/db/schema.ts'

const adminUrl = process.env.FAULT_DATABASE_URL
const tokenizerPath = process.env.QWEN_TOKENIZER_PATH
if (!adminUrl || !tokenizerPath) {
  console.log('SKIP: set FAULT_DATABASE_URL and QWEN_TOKENIZER_PATH to run the fault-injection test')
  process.exit(0)
}

const results: Array<{ step: string; ok: boolean; detail: string }> = []
const record = (step: string, ok: boolean, detail = '') => {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${step}${detail ? ` (${detail})` : ''}`)
}

// --- scratch database -------------------------------------------------------
const databaseName = `fault_${Date.now()}`
const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query(`create database ${databaseName}`)
const databaseUrl = Object.assign(new URL(adminUrl), { pathname: `/${databaseName}` }).toString()
const database = createDatabase(databaseUrl, 4)
await migrateDatabase(database)

// --- private Redis ---------------------------------------------------------
const redisPort = 20_000 + Math.floor(Math.random() * 5_000)
let redis: ChildProcess
const startRedis = async () => {
  redis = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  await delay(500)
}
await startRedis()

// --- fake model: streams 40 deltas; "SLOW" in the prompt makes it take ~6 s -
const model = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', async () => {
    const slow = body.includes('SLOW')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event: Record<string, unknown>) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'response.created', response: { id: 'resp', output: [] } })
    for (let index = 0; index < 40; index += 1) {
      send({ type: 'response.output_text.delta', delta: `片段${index} ` })
      await delay(slow ? 150 : 5)
    }
    send({ type: 'response.completed', response: { id: 'resp', output: [], usage: { input_tokens: 10, output_tokens: 40 } } })
    response.end()
  })
})
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
const modelPort = (model.address() as { port: number }).port

// --- worker process --------------------------------------------------------
const metricsPort = 25_000 + Math.floor(Math.random() * 5_000)
const workerEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  REDIS_KEY_PREFIX: 'fault:',
  QWEN_API_KEY: 'test',
  QWEN_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  QWEN_TOKENIZER_PATH: tokenizerPath,
  REQUEST_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  GPAS2_AUTH_MODE: 'mock',
  METRICS_PORT: String(metricsPort),
  USER_MEMORY_ENABLED: 'false',
  CHAT_SEARCH_ENABLED: 'false',
  PGAPPNAME: 'fault-worker',
}
let workerExited: number | null = null
const worker = spawn(process.execPath, ['--import', 'tsx', 'src/server/worker.ts'], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const workerLog: string[] = []
worker.stdout!.on('data', (chunk) => workerLog.push(String(chunk)))
worker.stderr!.on('data', (chunk) => workerLog.push(String(chunk)))
worker.on('exit', (code) => { workerExited = code ?? -1 })

async function healthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${metricsPort}/healthz`)
      if (response.ok) return true
    } catch { /* not up yet */ }
    await delay(250)
  }
  return false
}

// --- helpers ---------------------------------------------------------------
const user = await syncUser(database, { ...mockUserInfoResponse.data, userId: crypto.randomUUID() })
async function submit(content: string): Promise<string> {
  const chat = await createChat(database, user.id, content)
  const generationId = crypto.randomUUID()
  await createGenerationStart(database, {
    userId: user.id,
    chatId: chat.id,
    clientMessageId: crypto.randomUUID(),
    content,
    generationId,
    streamId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    provider: 'qwen',
    model: 'test',
  })
  return generationId
}
async function finalStatus(generationId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await database.select({ status: generations.status }).from(generations).where(eq(generations.id, generationId))
    if (row && ['completed', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(row.status)) return row.status
    if (Date.now() > deadline) return row?.status ?? 'missing'
    await delay(250)
  }
}

try {
  record('worker starts and reports healthy', await healthy(60_000))
  record('a generation completes', await finalStatus(await submit('hello'), 30_000) === 'completed')

  // Redis frozen for 5 s (longer than the 2 s command deadline).
  redis!.kill('SIGSTOP')
  await delay(5_000)
  redis!.kill('SIGCONT')
  record('worker survives a 5 s Redis freeze', workerExited === null && await healthy(30_000))
  record('a generation completes after the freeze', await finalStatus(await submit('after freeze'), 45_000) === 'completed')

  // Redis restarted, losing all data.
  redis!.kill('SIGTERM')
  await delay(3_000)
  record('worker survives Redis being down for 3 s', workerExited === null)
  await startRedis()
  record('worker recovers after Redis restarts empty', workerExited === null && await healthy(45_000))
  record('a generation completes after the Redis restart', await finalStatus(await submit('after restart'), 60_000) === 'completed')

  // PostgreSQL closes the worker's connections (restart/failover).
  const killed = await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'fault-worker'`)
  await delay(2_000)
  record('worker survives PostgreSQL closing its connections', workerExited === null && await healthy(30_000), `${killed.rowCount} connections closed`)
  record('a generation completes after the connections were closed', await finalStatus(await submit('after pg'), 45_000) === 'completed')

  // A Redis blip in the middle of a running generation must not interrupt it.
  const slow = await submit('SLOW answer')
  await delay(2_000)
  redis!.kill('SIGSTOP')
  await delay(4_000)
  redis!.kill('SIGCONT')
  const slowStatus = await finalStatus(slow, 60_000)
  record('a running generation survives a 4 s Redis freeze', slowStatus === 'completed', slowStatus)

  worker.kill('SIGTERM')
  const deadline = Date.now() + 40_000
  while (workerExited === null && Date.now() < deadline) await delay(200)
  record('worker exits cleanly on SIGTERM', workerExited === 0, `exit ${workerExited}`)
} finally {
  if (workerExited === null) worker.kill('SIGKILL')
  redis!.kill('SIGKILL')
  model.close()
  await closeDatabase(database)
  await admin.query(`drop database if exists ${databaseName} with (force)`)
  await admin.end()
}

const failed = results.filter((result) => !result.ok)
if (failed.length > 0) {
  console.log('\n--- worker log (tail) ---\n' + workerLog.join('').split('\n').slice(-60).join('\n'))
}
console.log(`\n${results.length - failed.length}/${results.length} fault-injection checks passed`)
assert.equal(failed.length, 0)
