// Explicit, isolated integration load test. Never calls a real model.
// node --import tsx tests/chat-load.mjs --run
// Uses DATABASE_URL/REDIS_URL only for local infrastructure; creates and drops
// its own random database and deletes only its own random Redis namespace.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { sql } from 'drizzle-orm';
import { readConfig } from '../src/server/config.ts';
import { createDatabase, closeDatabase, migrateDatabase, syncUser, createChat } from '../src/server/db.ts';
import { createRedisClient } from '../src/server/cache.ts';
import { buildApp } from '../src/server/app.ts';
import { GenerationService } from '../src/server/generation.ts';
import { GenerationRuntimeRegistry } from '../src/server/generationRuntimeRegistry.ts';
import { GenerationFinalizer } from '../src/server/generationFinalizer.ts';
import { GenerationStreamHub } from '../src/server/streamStore.ts';
import { readTerminalEvent } from '../src/server/terminalEvent.ts';
import { createCapabilityRuntime } from '../src/server/capabilities/runtime.ts';
import { mockUserInfoResponse } from '../src/server/auth.ts';
import { LocalEmbeddingService } from '../src/server/embedding.ts';

if (!process.argv.includes('--run')) throw new Error('Pass --run to create isolated load-test resources');
const users = Number(process.env.LOAD_USERS ?? 100);
const generationMs = Number(process.env.LOAD_GENERATION_MS ?? 4000);
// Simultaneous conversations per user; the default per-user limit is 3.
const chatsPerUser = Number(process.env.LOAD_CHATS_PER_USER ?? 1);
const pollMs = Number(process.env.LOAD_POLL_MS ?? 500);
const apiPool = Number(process.env.LOAD_API_PG_POOL ?? 4);
const workerPool = Number(process.env.LOAD_WORKER_PG_POOL ?? 4);
const totalChats = users * chatsPerUser;
// Spread submissions over this window; 300 same-instant connects overflow the Windows loopback backlog.
const rampMs = Number(process.env.LOAD_RAMP_MS ?? 0);
const plannerMs = 100;
const chunks = 20;
const realEmbedding = process.env.LOAD_REAL_EMBEDDING === 'true';
const saturationBarrier = process.env.LOAD_SATURATION_BARRIER === 'true';
assert.ok(Number.isInteger(users) && users > 0 && users <= 100);
assert.ok(generationMs >= 100);
assert.ok(Number.isInteger(chatsPerUser) && chatsPerUser >= 1 && chatsPerUser <= 5);
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRedisUrl = process.env.REDIS_URL;
assert.ok(originalDatabaseUrl && originalRedisUrl, 'DATABASE_URL and REDIS_URL required');
const runId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
const dbName = `chat_load_${runId}`;
assert.match(dbName, /^chat_load_[0-9]+_[a-f0-9]{8}$/);
const testUrl = new URL(originalDatabaseUrl); testUrl.pathname = `/${dbName}`;
const rootPrefix = `chat-load:${runId}:`;
const outputDir = `test-results/chat-load-${runId}`;
await mkdir(outputDir, { recursive: true });
const admin = new pg.Client({ connectionString: originalDatabaseUrl, connectionTimeoutMillis: 5000 });
const cleanupRedis = createClient({ url: originalRedisUrl, socket: { reconnectStrategy: false } });
cleanupRedis.on('error', () => {});
const results = [];
let created = false, db, mock, phase;
const percentile = (values, p) => values.length ? Math.round([...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1]) : null;
const stats = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), max: percentile(values, 1) });
function profile(name) { return { ...mockUserInfoResponse.data, userId: name, ownteamId: `team-${name}` }; }
function response(id, text, status = 'completed') {
  return { id, object: 'response', created_at: Math.floor(Date.now()/1000), status, model: 'load-mock',
    output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 30, output_tokens: chunks, total_tokens: 30 + chunks } };
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`); created = true;
  await cleanupRedis.connect();
  Object.assign(process.env, {
    DATABASE_URL: testUrl.href, REDIS_URL: originalRedisUrl,
    NODE_ENV: 'test', SERVE_CLIENT: 'false', REQUEST_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GPAS2_AUTH_MODE: 'upstream', QWEN_API_KEY: 'load-test-not-a-real-key', QWEN_MODEL: 'load-mock',
    OBJECT_STORAGE_ENABLED: 'false', ARTIFACT_PROTOCOL_ENABLED: 'false', ARTIFACT_CONTEXT_V2_ENABLED: 'false', ARTIFACT_PATCH_ENABLED: 'false',
    CONTEXT_MEMORY_ENABLED: 'false', USER_MEMORY_ENABLED: 'false', PG_POOL_MAX: String(workerPool),
    UPSTREAM_REQUESTS_PER_MINUTE: '0', UPSTREAM_TOKENS_PER_MINUTE: '0', MONTHLY_TOKEN_LIMIT: '0',
    GENERATION_TIMEOUT_MS: '180000', GENERATION_LOCK_LEASE_MS: '30000', GENERATION_LOCK_RENEW_INTERVAL_MS: '10000',
  });
  db = createDatabase(testUrl.href, apiPool);
  await db.execute(sql`create extension if not exists vector`);
  await migrateDatabase(db);
  mock = createServer(async (req, res) => {
    try {
      if (req.url === '/user/info') {
        const name = /u=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 200, data: profile(name) })); return;
      }
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw), state = phase;
      state.active++; state.peakCombined = Math.max(state.peakCombined, state.active);
      const kind = body.stream ? 'generation' : 'planner';
      state[kind]++; state[`peak_${kind}`] = Math.max(state[`peak_${kind}`], state[kind]);
      state[`${kind}Calls`]++;
      let done = false;
      const release = () => { if (!done) { done = true; state.active--; state[kind]--; } };
      res.on('close', release);
      if (state.active > 100) { state.provider429++; res.writeHead(429); res.end('{}'); return; }
      if (!body.stream) {
        await delay(plannerMs);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response(crypto.randomUUID(), JSON.stringify({ intent: 'general', scope: 'unspecified', capabilityId: null, confidence: 1 }))));
        release(); return;
      }
      const marker = /load:[a-z0-9_-]+/.exec(JSON.stringify(body.input))?.[0];
      assert.ok(marker, 'User isolation marker must survive context construction');
      const owner = marker.replace(/_c[0-9]+$/, '');
      state.perUser[owner] = (state.perUser[owner] ?? 0) + 1;
      state.peakPerUser = Math.max(state.peakPerUser, state.perUser[owner]);
      res.on('close', () => { state.perUser[owner]--; });
      const id = crypto.randomUUID(), delta = `Reply:${marker};`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: response(id, '', 'in_progress') });
      // Capacity-only mode: hold initial streams open until all users have a
      // live provider stream. Its latency is artificial, not a performance SLA.
      if (saturationBarrier) {
        if (state.generation === users) state.saturated = true;
        const deadline = Date.now()+90000;
        while (!state.saturated && !res.destroyed) {
          assert.ok(Date.now()<deadline, 'Could not reach requested concurrent streams');
          await delay(20);
        }
      }
      for (let i = 0; i < chunks && !res.destroyed; i++) {
        await delay(generationMs/chunks);
        send({ type: 'response.output_text.delta', delta, item_id: `msg_${id}`, output_index: 0, content_index: 0 });
      }
      if (!res.destroyed) {
        send({ type: 'response.completed', response: response(id, delta.repeat(chunks)) });
        res.end();
      }
      release();
    } catch (error) { console.error('MOCK_ERROR', error.message); res.destroy(); }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { QWEN_BASE_URL: `${mockUrl}/v1`, GPAS2_USER_INFO_URL: `${mockUrl}/user/info` });
  const scenarios = [
    { name: 'defaults', generation: 4, upstream: 8, ingress: 8, planner: 4 },
    { name: 'generation100_upstream8', generation: 100, upstream: 8, ingress: 100, planner: 100 },
    { name: 'all100', generation: 100, upstream: 100, ingress: 100, planner: 100 },
    // Production defaults for 100 users x 3 chats on a 100-concurrency provider.
    { name: 'target', generation: 80, upstream: 100, ingress: 24, planner: 16 },
  ].filter(s => !process.env.LOAD_SCENARIOS || process.env.LOAD_SCENARIOS.split(',').includes(s.name));
  for (const scenario of scenarios) {
    assert.ok(!saturationBarrier || (scenario.generation>=users && scenario.upstream>=users), 'Barrier requires sufficient concurrency limits');
    console.log('SCENARIO_START', scenario.name);
    phase = { perUser: {}, peakPerUser: 0, active: 0, peakCombined: 0, generation: 0, planner: 0, peak_generation: 0, peak_planner: 0, generationCalls: 0, plannerCalls: 0, provider429: 0 };
    Object.assign(process.env, { REDIS_KEY_PREFIX: `${rootPrefix}${scenario.name}:`,
      GLOBAL_GENERATION_CONCURRENCY: String(scenario.generation), PROVIDER_GENERATION_CONCURRENCY: String(scenario.generation), MODEL_GENERATION_CONCURRENCY: String(scenario.generation),
      UPSTREAM_CONCURRENCY: String(scenario.upstream), INGRESS_CONCURRENCY: String(scenario.ingress), PLANNER_CONCURRENCY: String(scenario.planner) });
    const config = readConfig();
    const redis = createRedisClient(config); await redis.connect();
    const runtimes = new GenerationRuntimeRegistry(config, redis);
    const finalizer = new GenerationFinalizer(config, db, redis, runtimes);
    const generations = new GenerationService(config, db, redis, runtimes, finalizer);
    const hub = new GenerationStreamHub(config, redis, (u,g) => readTerminalEvent(db,u,g)); await hub.start();
    // Optional real local embedding. All other internal stages use production code.
    const embedding = realEmbedding ? new LocalEmbeddingService(config)
      : { embed: async () => Array.from({length:512}, (_,i) => i === 0 ? 1 : 0) };
    const capabilityRuntime = createCapabilityRuntime(config, embedding, redis);
    await capabilityRuntime.router.initialize();
    const app = await buildApp({ config, database: db, redis, generations, streamHub: hub, objectStore: null, artifactService: null, capabilityRuntime });
    app.log.level = 'silent';
    await app.listen({ host: '127.0.0.1', port: 0 });
    const api = `http://127.0.0.1:${app.server.address().port}/ai-chatbot/api`;
    const workerLog = createWriteStream(`${outputDir}/${scenario.name}-worker.log`);
    const worker = spawn(process.execPath, ['--import', 'tsx', 'src/server/worker.ts'], { env: {...process.env}, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    worker.stdout.pipe(workerLog); worker.stderr.pipe(workerLog);
    const workerExit = once(worker, 'exit');
    try {
      const readyDeadline = Date.now()+60000;
      for (;;) {
        let ready = false;
        for await (const keys of cleanupRedis.scanIterator({ MATCH: `${config.redisPrefix}worker:*:heartbeat` })) if (keys.length) ready = true;
        if (ready) break;
        assert.equal(worker.exitCode, null, 'Worker exited; inspect worker log');
        assert.ok(Date.now()<readyDeadline, 'Worker readiness deadline');
        await delay(200);
      }
      const identities = [];
      for (let i=0; i<users; i++) {
        const name = `${scenario.name}_${i}`;
        const u = await syncUser(db, profile(name));
        for (let c=0; c<chatsPerUser; c++) {
          identities.push({name: chatsPerUser > 1 ? `${name}_c${c}` : name, cookieName: name, userId:u.id, chat:await createChat(db,u.id,'load test')});
        }
      }
      let sseActive = 0, peakSse = 0, peakPoolWaiting = 0;
      const poolMonitor = setInterval(() => { peakPoolWaiting = Math.max(peakPoolWaiting, db.$client.waitingCount); }, 10);
      const started = performance.now();
      const outcomes = await Promise.all(identities.map(async identity => {
        if (rampMs) await delay(Math.random() * rampMs);
        const t0 = performance.now(), signal = AbortSignal.timeout(210000);
        const headers = { cookie: `u=${identity.cookieName}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() };
        let acceptedMs, plannedMs, firstTokenMs;
        try {
          const accepted = await fetch(`${api}/conversations/${identity.chat.id}/messages`, { method:'POST', headers, body:JSON.stringify({content:`load:${identity.name}`}), signal });
          const ticket = await accepted.json(); acceptedMs = performance.now()-t0;
          assert.equal(accepted.status, 202, JSON.stringify(ticket));
          let current = ticket;
          while (['queued','running'].includes(current.status)) {
            await delay(pollMs);
            const poll = await fetch(`${api}/requests/${ticket.id}`, {headers, signal});
            assert.equal(poll.status, 200); current = await poll.json();
          }
          assert.equal(current.status,'succeeded',JSON.stringify(current.error));
          plannedMs = performance.now()-t0;
          const generationId = current.result.generation.id;
          const stream = await fetch(`${api}/generations/${generationId}/stream`, {headers,signal});
          assert.equal(stream.status,200);
          sseActive++; peakSse = Math.max(peakSse,sseActive);
          let text='', buffer='', terminal;
          try {
            const decoder = new TextDecoder();
            for await (const bytes of stream.body) {
              buffer += decoder.decode(bytes,{stream:true});
              let boundary;
              while ((boundary=buffer.indexOf('\n\n'))>=0) {
                const frame=buffer.slice(0,boundary); buffer=buffer.slice(boundary+2);
                const data=frame.split('\n').find(line=>line.startsWith('data: '));
                if(!data) continue;
                const event=JSON.parse(data.slice(6));
                if(event.type==='message.delta') { firstTokenMs ??= performance.now()-t0; text+=event.delta; }
                if(event.type==='message.finish') terminal=event;
              }
            }
          } finally { sseActive--; }
          assert.equal(terminal?.finishReason,'stop',JSON.stringify(terminal?.error));
          const expected=`Reply:load:${identity.name};`.repeat(chunks);
          // The application intentionally allows a durable terminal event to
          // repair missing tail deltas. Record that separately, not as lost data.
          assert.ok(expected.startsWith(text),'Stream must contain only this user\'s ordered response');
          assert.equal(terminal.assistantMessage.content,expected,'Durable final answer must be complete and user-isolated');
          return {ok:true,acceptedMs,plannedMs,firstTokenMs,completedMs:performance.now()-t0,generationId,terminalRepairedDelta:text!==expected};
        } catch(error) { return {ok:false,acceptedMs,plannedMs,firstTokenMs,error:error.message,cause:error.cause?.code ?? error.cause?.message}; }
      }));
      clearInterval(poolMonitor);
      const generationRows = await db.execute(sql`select status, count(*)::int as n from "Generation" where model='load-mock' group by status`);
      const result = { scenario, users, chatsPerUser, rampMs, pollMs, apiPool, workerPool, generationMs, plannerMs, chunks, realEmbedding, saturationBarrier, success:outcomes.filter(o=>o.ok).length,
        failures:outcomes.filter(o=>!o.ok), elapsedMs:Math.round(performance.now()-started),
        terminalRepairedDelta:outcomes.filter(o=>o.ok && o.terminalRepairedDelta).length,
        acceptMs:stats(outcomes.flatMap(o=>o.acceptedMs===undefined?[]:[o.acceptedMs])),
        ingressDoneMs:stats(outcomes.flatMap(o=>o.plannedMs===undefined?[]:[o.plannedMs])),
        firstTokenMs:stats(outcomes.flatMap(o=>o.firstTokenMs===undefined?[]:[o.firstTokenMs])),
        completedMs:stats(outcomes.flatMap(o=>o.completedMs===undefined?[]:[o.completedMs])),
        peakSse, peakApiPoolWaiting:peakPoolWaiting, mock:{...phase}, cumulativeDatabaseGenerationStates:generationRows.rows };
      results.push(result);
      await writeFile(`${outputDir}/results.json`, JSON.stringify({runId, scope:`Real PG/Redis/API/worker/HTTP/SSE; mock LLM/auth; ${realEmbedding ? 'real' : 'mock'} embedding; memory/artifacts disabled`,results},null,2));
      console.log('SCENARIO_RESULT',JSON.stringify(result));
      assert.equal(result.success,totalChats,'Every user must get a correct, durable, isolated streamed response');
      assert.equal(phase.generationCalls,totalChats,'No lost or duplicated model generations');
      assert.equal(phase.provider429,0);
      assert.ok(phase.peakCombined<=scenario.upstream);
      assert.ok(phase.peak_generation<=Math.min(scenario.generation,scenario.upstream));
      assert.ok(phase.peakPerUser<=3,'Per-user generation concurrency must not exceed 3');
      if(saturationBarrier) assert.equal(phase.peak_generation,users,'Must hold all provider streams concurrently');
    } finally {
      worker.kill(); await workerExit; workerLog.end();
      await generations.shutdown(); await hub.close(); await app.close(); await runtimes.close();
      if(redis.isOpen) await redis.close();
    }
  }
  console.log('LOAD_TEST_PASS',outputDir);
} finally {
  if(mock) { mock.closeAllConnections(); await new Promise(resolve=>mock.close(resolve)); }
  if(db) await closeDatabase(db);
  if(cleanupRedis.isOpen) {
    for await (const keys of cleanupRedis.scanIterator({ MATCH:`${rootPrefix}*`, COUNT:500 })) if(keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.close();
  }
  if(created) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await admin.end();
}
