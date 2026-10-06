# 100-user chat integration load test (2026-10-06)

## Conclusion

The queue architecture can accept 100 distinct users and, after raising limits,
hold 100 concurrent model streams and 100 SSE readers with correct durable
answers. The default deployment is **not** configured for 100 simultaneous
generations: global/provider/model limits are 4; the shared model budget is 8.
Queue acceptance and acceptable response latency are different requirements.

These are local synthetic integration results, not a production capacity SLA.
No production code or deployment configuration was modified.

## Environment and scope

- Existing WSL Docker PostgreSQL (`pgvector/pgvector:pg17`) and Redis (`redis:7-alpine`).
- A newly created random PostgreSQL database and random Redis key prefixes.
  The test removes only its own database and keys in `finally`.
- One Windows Node API process and one actual `src/server/worker.ts` process.
- Actual migrations, durable ingress, Outbox, queue Lua, shared model permits,
  tokenizer, generation execution, finalization, HTTP requests and SSE delivery.
- API and worker PostgreSQL pools each have 4 connections.
- 100 separate users, each sends one short plain-chat message in a simultaneous burst.
- Mock upstream hard-caps total model requests at 100. Planner response takes
  100 ms; generation emits 20 chunks over 4 seconds. Auth is also mocked.
- Initial comparison uses mock embedding; saturation test uses the real local
  BGE embedding model with its existing concurrency limit of 2.
- Request-ticket polling is every 500 ms, deliberately heavier than the actual
  frontend's 2-second polling. Do not interpret these timings as browser-user SLAs.
- Memory and artifact features are disabled. No reverse proxy, browser rendering,
  real LLM computation, long-context load, sustained soak, or failure injection.

## Results

| Case | Generation / shared upstream / ingress / planner limits | Peak model generations | Peak SSE readers | Acceptance P95 | First-token P95 | Completion P95 | Whole burst |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Defaults | 4 / 8 / 8 / 4 | 4 | 52 | 3.72 s | 108.95 s | 112.85 s | 117.22 s |
| All limits raised | 100 / 100 / 100 / 100 | 27 | 28 | 3.41 s | 53.65 s | 57.58 s | 57.95 s |
| Saturation barrier, real embedding | 100 / 100 / 100 / 100 | **100** | **100** | 2.52 s | Not a latency benchmark | Not a latency benchmark | 52.22 s |

All three cases above completed **100/100** answers, with the exact expected
per-user final content, no mixed-user text, no duplicated model generations, and
no provider 429 responses. The first two cases are natural 4-second mock streams.
The saturation case deliberately holds streams until all 100 are open, then
emits the 4-second response. It proves concurrent capacity, not natural ramp-up
speed or latency. In that case the ingress P95 was 45.76 s.

An intermediate exploratory case raised generation/ingress/planner to 100 but
left `UPSTREAM_CONCURRENCY=8`. Actual model-generation concurrency stayed at 8;
all 100 generations reached PostgreSQL `completed`. An initial strict assertion
requiring every delta to arrive failed for 1/100 streams (19 of 20 deltas, followed
by a successful terminal event). This is **not counted as a fully verified pass**
of that initial test. `GenerationStreamHub.checkTerminal` intentionally permits
durable terminal content to repair tail deltas, and the frontend uses that content.
The harness now asserts complete terminal content and records delta repair
separately. The later all-limits-raised and saturation runs passed with zero repairs.

## Bottlenecks and interpretation

1. Global/provider/model limits must all be raised; raising one is insufficient.
   `UPSTREAM_CONCURRENCY` is a separate Redis-backed limit shared by planner,
   generation and background work, across processes. Keep their combined demand
   within the assumed upstream capacity of 100, not 100 for each category.
2. Raising limits does not immediately create 100 natural concurrent generations.
   The normal tuned burst only reached 27, because requests ramped through ingress
   and storage over time; short generations finished before the last ones started.
3. The measured API database-pool waiting count peaked at 104–105. Ticket polling
   re-authenticates and calls `syncUser` (an UPSERT); ingress claims rows sequentially
   and performs multiple database operations per request. These are investigation
   targets, not a proven single root cause. Profile SQL, connection waits and the
   ingress stage before assuming LLM capacity is the bottleneck.
4. Default settings accept the burst reliably but deliver poor tail latency even
   with a 4-second mock model. Longer outputs will further increase queued waiting.
5. Validate realistic 2-second polling, longer prompts, expected output lengths,
   real upstream latency, deployment hardware, proxy limits, and sustained traffic
   before committing to a 100-user latency target.

## Reproduction

`DATABASE_URL` and `REDIS_URL` come from the local environment / `.env`.
The PostgreSQL account must be allowed to create a disposable database.
No real model credentials are used. Run from the repository root:

```powershell
node --import tsx tests/chat-load.mjs --run
```

For the capacity-only scenario with real local embedding:

```powershell
$env:LOAD_SCENARIOS='all100'
$env:LOAD_REAL_EMBEDDING='true'
$env:LOAD_SATURATION_BARRIER='true'
node --import tsx tests/chat-load.mjs --run
```

The barrier is only valid when generation and upstream limits are at least the
number of users. Additional knobs: `LOAD_USERS` (1–100), `LOAD_GENERATION_MS`.
Each run writes JSON results and worker logs under `test-results/chat-load-*`.

Evidence from this investigation:

- `test-results/chat-load-1791289205743_1ed0f1a2/results.json` — default and exploratory intermediate case.
- `test-results/chat-load-1791289472900_8c07f3a0/results.json` — natural tuned burst.
- `test-results/chat-load-1791289547646_618f09b9/results.json` — real-embedding, 100-stream saturation.
- Queue Lua and shared model-budget regression suite with real Redis: **17 passed, 0 failed, 0 skipped**.
- Existing PGlite HTTP test: 100 chat submissions and 100 business submissions
  completed ingress successfully. That test alone does not cover actual generation.
