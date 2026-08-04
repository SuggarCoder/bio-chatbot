# Redis Design for GPAS2 Chatbot v2

> Purpose: Agent-readable Redis architecture specification for the GPAS2 Chatbot.
>
> Core rule: **PostgreSQL is the source of truth. Redis is only a disposable acceleration and realtime layer.**
>
> Redis may be flushed without losing authoritative Chat, Message, Generation, ToolRun, AnalysisJob, Artifact, UsageEvent, or AuditLog data.

---

## 1. Scope

Redis is used only for:

1. Optional GPAS2 identity resolution cache (`Cookie -> userID`)
2. User profile cache
3. LLM context cache
4. Generation realtime state
5. Resumable streaming
6. Analysis job realtime progress
7. Realtime user notifications
8. Request rate limiting
9. Token quota fast checks
10. Generation concurrency control
11. Optional internal API response cache
12. Optional idempotency acceleration
13. Optional worker lock

Redis must **not** become the authoritative store for:

- User
- Chat
- Message
- Chat sharing permissions
- Attachment permissions
- ToolRun
- Artifact
- AnalysisJob history
- JobEvent history
- Generation final state
- UsageEvent
- AuditLog

Those remain in PostgreSQL.

---

## 2. Namespace Convention

Use an explicit environment and schema version prefix.

Production:

```text
gpas2cb:prod:v2:
```

Development:

```text
gpas2cb:dev:v2:
```

Examples:

```text
gpas2cb:prod:v2:identity:resolve:{cookieHash}
gpas2cb:prod:v2:chat:ctx:{chatId}
gpas2cb:prod:v2:quota:user:{userId}:{yyyyMM}
```

All key examples below omit this prefix for readability.

---

## 3. Key Summary

| Key | Redis Type | TTL | Purpose |
|---|---|---:|---|
| `identity:resolve:{cookieHash}` | Hash | 30–120 s (optional) | Cache GPAS2 `/info` identity resolution result |
| `chat:ctx:{chatId}` | String JSON | 2 h | Latest revisioned LLM context snapshot |
| `generation:{generationId}` | Hash | running: sliding / terminal: 1 h | Realtime Generation projection and runner location |
| `stream:{streamId}:*` | library-managed | 24 h | Resumable streaming data for one Generation |
| `control:runner:{runnerId}` | Pub/Sub | none | Best-effort low-latency Generation cancellation command |
| `job:progress:{jobId}` | Hash | running: 24 h / completed: 6 h | Realtime analysis progress |
| `notify:user:{userId}` | Pub/Sub | none | Realtime “state changed” notifications |
| `rl:user:{userId}:req:{window}` | Counter | ~120 s | User request rate limit |
| `rl:ip:{ip}:req:{window}` | Counter | ~120 s | IP abuse/burst rate limit |
| `quota:user:{userId}:{yyyyMM}` | String or Hash | month end + 7 d | Monthly token usage fast check |
| `quota:applied:{generationId}` | String | month end + 7 d | Prevent Redis quota double-application |
| `concurrency:user:{userId}:generation` | ZSet | lease based | Active generation concurrency |
| `api:{userId}:{toolName}:{argsHash}` | String JSON | 5 s–30 min | Optional GPAS2 internal API cache |
| `idem:{userId}:{idempotencyKey}` | String JSON | 24 h | Optional idempotency acceleration |
| `lock:job:{jobId}` | String | ~30 s | Optional worker lock |

---

# 4. GPAS2 Identity Resolution

The Chatbot application does **not** authenticate users itself.

The authoritative identity flow is:

```text
Browser
  │
  │ GPAS2 Cookie
  ▼
Fastify Chatbot
  │
  │ forward current request Cookie
  ▼
GPAS2 /info API
  │
  │ returns registered platform userID
  ▼
Chatbot
  │
  ├─ map externalUserId -> PostgreSQL User.id
  │
  ▼
currentUser
```

GPAS2 `/info` is the identity source of truth.

The Chatbot must not maintain its own:

```text
password
login session
refresh token
authentication token
```

## 4.1 Recommended v2 Behavior

For the initial implementation, prefer:

```text
NO Redis identity cache
```

and call GPAS2 `/info` for each authenticated Chatbot request.

This gives the cleanest semantics:

```text
GPAS2 session valid
    → Chatbot request may continue

GPAS2 session revoked / logged out
    → next Chatbot request fails immediately
```

Only add Redis identity caching if `/info` latency or request volume becomes a demonstrated bottleneck.

## 4.2 Optional Identity Resolution Cache

If needed, use:

```text
identity:resolve:{cookieHash}
```

Do **not** use:

```text
identity:resolve:{...}
```

because Redis does not own or validate the authentication session.

### Type

```text
HASH
```

### cookieHash

Never use the raw Cookie as a Redis key.

Derive:

```text
cookieHash = SHA-256(relevant GPAS2 session cookie value)
```

The hash is only a cache key for the `/info` resolution result.

### Example Fields

```text
externalUserId
internalUserId
externalTeamId
gpas2Role
resolvedAt
```

Example:

```text
HSET identity:resolve:9b3a...
  externalUserId "U001928"
  internalUserId "3d2c..."
  externalTeamId "TEAM001"
  gpas2Role "2"
  resolvedAt "1785400000"
```

### TTL

Recommended:

```text
30–120 seconds
```

A short TTL is required because caching `/info` delays visibility of:

```text
logout
session revocation
account disablement
identity changes
```

Do not use a long TTL such as 15–30 minutes for identity resolution.

### Read Flow with Optional Cache

```text
Browser request
    ↓
Fastify receives GPAS2 Cookie
    ↓
SHA-256 relevant session cookie → cookieHash
    ↓
identity:resolve:{cookieHash}
    ├─ hit
    │    ↓
    │  obtain externalUserId/internalUserId
    │
    └─ miss
         ↓
       forward Cookie to GPAS2 /info
         ↓
       401/403 → reject request
         ↓
       200 → obtain userID
         ↓
       map/sync User in PostgreSQL
         ↓
       write short-lived Redis identity cache
```

## 4.3 Security Rules

### Redis Is Not the Authentication Authority

A Redis hit means only:

```text
this Cookie recently resolved to this userID
```

It does not mean Redis owns the session.

### Never Trust Client-Supplied userID

Do not establish identity from:

```text
X-User-ID
?userId=
request body userId
LLM tool argument userId
```

The authoritative `externalUserId` must originate from:

```text
request Cookie
    ↓
GPAS2 /info
```

or from a short-lived Redis cache derived from that Cookie.

### Never Store the Raw GPAS2 Cookie in Redis

Do not create:

```text
identity:{userId} = rawCookie
gpas2:token:{userId} = bearerToken
```

The current request Cookie remains request-scoped.

### Tool Calls Use the Current Request Identity

For synchronous GPAS2 API tools:

```text
User request
    ↓
resolve currentUser from GPAS2 Cookie
    ↓
LLM chooses Tool
    ↓
Fastify Tool implementation
    ↓
forward current request Cookie to GPAS2 API
    ↓
GPAS2 performs resource authorization
```

The Chatbot determines:

```text
who is making the request
```

GPAS2 determines:

```text
what that user is allowed to access
```

Redis must never bypass this authorization path.


# 5. Authentication Profile Handling

GPAS2 profiles are validated on every protected request and synchronized to
PostgreSQL. The application does not maintain a Redis user-profile projection.

---

# 6. LLM Context Cache

## Key

```text
chat:ctx:{chatId}
```

Example:

```text
chat:ctx:8b1d...
```

## Type

```text
STRING containing JSON
```

## Purpose

Stores pre-built LLM context so each generation does not need to reconstruct all recent conversation state from PostgreSQL.

The version number comes from:

```text
Chat.contextRevision
```

in PostgreSQL.

## Example value

```json
{
  "chatId": "8b1d...",
  "revision": 37,
  "lastSeq": 84,
  "summaryThroughSeq": 60,
  "summary": "User is analyzing project P001 and comparing pathogen findings.",
  "messages": [
    {
      "role": "user",
      "content": "Generate a pathogen summary for project P001."
    },
    {
      "role": "assistant",
      "content": "..."
    }
  ]
}
```

## TTL

```text
2 hours
```

## Invalidation strategy

The key stores only the latest snapshot. Normal user and completed assistant
messages advance it with a compare-and-set on `revision` and retain the latest
80 context messages. A revision mismatch, regeneration, missing key, or invalid
JSON falls back to rebuilding context from PostgreSQL before replacing the
snapshot. The TTL is refreshed after every successful update.

## Required transaction behavior

When inserting a new Message, Fastify/Drizzle should atomically:

```text
1. verify Chat ownership
2. increment Chat.nextMessageSeq
3. increment Chat.contextRevision
4. insert Message using allocated seq
```

Then the next LLM context uses the new revision.

---

# 7. Shared Chat Must Never Use LLM Context Cache

`chat:ctx:*` contains internal model context and may include:

- system instructions
- internal tool context
- sensitive project context
- model-only data
- hidden implementation details

Therefore:

```text
chat:ctx:* MUST NEVER be returned to Shared Chat viewers
```

Shared Chat pages must use the PostgreSQL safe sharing layer:

```text
SharedChat
SharedChatMessage
SharedArtifact
```

or equivalent service queries based on those safe views.

The Shared Chat API must never expose raw:

```text
Message.parts
```

---

# 8. Generation Realtime State

## Key

```text
generation:{generationId}
```

## Type

```text
HASH
```

## Purpose

Provides fast realtime state while the model is running.

PostgreSQL `Generation` remains the final source of truth.

`status=cancelling` is only a realtime projection. PostgreSQL represents the
same condition as a non-terminal status plus non-null `cancelRequestedAt`.
Redis must never be the only record that cancellation was requested.

## Example fields

```text
status
chatId
userId
streamId
provider
model
runnerId
cancelRequestedAt
inputTokens
outputTokens
startedAt
updatedAt
```

Example:

```text
HSET generation:G001
  status "streaming"
  chatId "C001"
  userId "U001"
  streamId "S001"
  provider "openai"
  model "..."
  runnerId "fastify-9af217..."
  inputTokens "1450"
  outputTokens "382"
  startedAt "1785400000"
  updatedAt "1785400023"
```

## TTL

While running:

```text
sliding TTL, e.g. 1 hour
```

After completion/failure/cancellation:

```text
1 hour
```

## Recovery rule

If Redis state is missing:

```text
GET /generation/:id
    ↓
PostgreSQL Generation
```

must still work.

## Runner cancellation control

Each Fastify instance owns a random `runnerId` and subscribes to:

```text
control:runner:{runnerId}
```

Cancel payload:

```json
{
  "type": "generation.cancel",
  "generationId": "G001"
}
```

The runner aborts the matching process-local Generation runtime. Pub/Sub is
best-effort only; cancellation checkpoints always fall back to PostgreSQL
`Generation.cancelRequestedAt`.

---

# 9. Resumable Streaming

## Key

Managed by the streaming library.

Conceptually:

```text
stream:{streamId}:*
```

## Purpose

Stores temporary stream chunks/state required to reconnect to an interrupted assistant response.

## TTL

Recommended:

```text
1–24 hours
```

Use a 24-hour retention window. Do not keep stream chunks as long-term
history.

PostgreSQL `Stream` stores the durable stream identity/relationship and retention metadata.
`Stream.generationId` is required and unique. Browser/network disconnect only
detaches a reader; it does not cancel the Generation.

## Rule

Do not create a second custom stream persistence implementation if the selected resumable-stream library already manages Redis keys and locks.

---

# 10. Analysis Job Progress Cache

## Key

```text
job:progress:{jobId}
```

## Type

```text
HASH
```

## Purpose

Fast realtime projection of the current `AnalysisJob` state.

The durable truth remains:

```text
AnalysisJob
JobEvent
```

in PostgreSQL.

## Example fields

```text
status
progress
stage
message
externalJobId
attempt
workerId
updatedAt
```

Example:

```text
HSET job:progress:J001
  status "running"
  progress "37"
  stage "alignment"
  message "Aligning reads"
  externalJobId "PIPELINE-92384"
  attempt "1"
  workerId "worker-03"
  updatedAt "1785400021"
```

## TTL

While running:

```text
24 hours
```

After final state:

```text
6 hours
```

Final states:

```text
completed
failed
cancelled
```

## Recovery

Redis miss:

```text
AnalysisJob
+
latest JobEvent
```

can rebuild the current view.

---

# 11. Job Event History

Do not create a permanent Redis history such as:

```text
job:events:{jobId}
```

for:

```text
queued
progress
retry
completed
...
```

PostgreSQL `JobEvent` already owns durable task history.

Redis should only contain the latest realtime projection:

```text
job:progress:{jobId}
```

---

# 12. Realtime User Notifications

## Channel

```text
notify:user:{userId}
```

## Type

```text
Redis Pub/Sub
```

## Purpose

Notifies an online Fastify/WebSocket connection that authoritative state changed.

Examples:

```json
{
  "type": "analysis.completed",
  "jobId": "J001"
}
```

```json
{
  "type": "artifact.ready",
  "artifactId": "A001"
}
```

```json
{
  "type": "generation.failed",
  "generationId": "G001"
}
```

## Critical rule

Pub/Sub is best-effort.

Never treat a Pub/Sub notification as the only record of completion.

The client receiving:

```text
analysis.completed
```

should refetch state from PostgreSQL-backed APIs.

---

# 13. User Request Rate Limit

## Key

```text
rl:user:{userId}:req:{window}
```

Example:

```text
rl:user:3d2c...:req:202607301230
```

## Type

```text
STRING counter
```

## Purpose

Limits short-term request bursts.

## TTL

For one-minute windows:

```text
~120 seconds
```

Example algorithm:

```text
INCR key
EXPIRE key 120
```

or use a Lua script to make first-increment + expiry atomic.

## Difference from quota

Rate limit:

```text
How many requests can the user make right now?
```

Token quota:

```text
How many tokens may the user consume in the quota period?
```

They solve different problems.

---

# 14. IP Rate Limit

## Key

```text
rl:ip:{ip}:req:{window}
```

## Type

```text
STRING counter
```

## TTL

```text
~120 seconds
```

## Purpose

Protects:

- login/session endpoints
- public-facing Chatbot routes
- unexpected client loops
- abuse/bot traffic

Do not rely on IP rate limits alone because multiple legitimate users may share one NAT IP.

---

# 15. Monthly Token Quota

PostgreSQL `UsageEvent` is the durable token usage ledger.

Redis is only used to avoid running:

```sql
SUM(totalTokens)
```

before every request.

## Key

```text
quota:user:{userId}:{yyyyMM}
```

Example:

```text
quota:user:3d2c...:202607
```

## Type

Preferred minimal implementation:

```text
STRING integer
```

Value:

```text
2348511
```

means:

```text
2,348,511 tokens used this month
```

A Hash is also acceptable if more metadata is needed:

```text
usedTokens
updatedAt
rebuiltAt
```

## TTL

```text
quota period end + 7 days
```

For monthly quota:

```text
expire roughly 7 days after month end
```

## Request flow

Before generation:

```text
GET quota:user:{userId}:{yyyyMM}
```

If missing:

```text
rebuild from PostgreSQL UsageEvent
```

If:

```text
usedTokens >= configuredLimit
```

reject before starting another generation.

---

# 16. Token Usage Commit Flow

Correct order:

```text
LLM finishes
    ↓
PostgreSQL transaction
    ├─ update Generation final status/tokens
    └─ insert UsageEvent
    ↓
COMMIT
    ↓
apply token count to Redis quota cache
```

Never make Redis the first or only usage write.

PostgreSQL is authoritative.

---

# 17. Prevent Redis Quota Double Application

## Key

```text
quota:applied:{generationId}
```

## Type

```text
STRING
```

Example:

```text
quota:applied:G001 = 1
```

## TTL

```text
quota period end + 7 days
```

## Purpose

The application may retry Redis quota application after PostgreSQL has already committed.

Use a Lua script so:

```text
if quota:applied:{generationId} does not exist:
    SET quota:applied:{generationId} 1
    INCRBY quota:user:{userId}:{yyyyMM} totalTokens
else:
    do nothing
```

must happen atomically.

PostgreSQL `UsageEvent` uniqueness is still the authoritative idempotency guarantee.

---

# 18. Rebuilding Token Quota

If Redis is flushed:

```text
quota:user:{userId}:{yyyyMM}
```

can be reconstructed.

Pseudo query:

```sql
SELECT COALESCE(SUM("totalTokens"), 0)
FROM "UsageEvent"
WHERE "userId" = :userId
  AND "createdAt" >= :periodStart
  AND "createdAt" < :periodEnd;
```

Then:

```text
SET quota:user:{userId}:{yyyyMM} <sum>
```

This is why PostgreSQL, not Redis, owns the token usage truth.

---

# 19. Generation Concurrency Limit

## Key

```text
concurrency:user:{userId}:generation
```

## Type

```text
ZSET
```

## Member

```text
generationId
```

## Score

```text
lease expiration Unix timestamp
```

Example:

```text
ZADD concurrency:user:U001:generation 1785400060 G001
ZADD concurrency:user:U001:generation 1785400075 G002
```

## Purpose

Limits concurrent active LLM generations per user.

Example policy:

```text
maxConcurrentGenerations = 3
```

## Acquire flow

Atomically:

```text
1. ZREMRANGEBYSCORE key -inf now
2. ZCARD key
3. if count >= limit → reject
4. ZADD key leaseExpiry generationId
```

Use Lua for atomicity.

After PostgreSQL accepts a Generation cancellation request, remove that
Generation from this logical concurrency set immediately. Its runner may still
be aborting or cleaning up, but the user can start the next Generation without
waiting for teardown.

## Why ZSet instead of Counter

A worker/server may crash before decrementing a counter.

A lease-based ZSet naturally expires stale generation slots.

---

# 20. Optional GPAS2 Internal API Cache

Use only after API authorization has succeeded.

## Key

```text
api:{userId}:{toolName}:{argsHash}
```

Example:

```text
api:U001:getQcResult:a947fb32
```

## Type

```text
STRING JSON
```

## argsHash

Hash a canonical serialization of the effective Tool arguments.

Do not construct hashes from unstable JSON field order.

## Suggested TTL by data type

Fast-changing job/project status:

```text
5–15 seconds
```

Project profile/basic metadata:

```text
5–15 minutes
```

Completed QC/result summaries:

```text
10–30 minutes
```

## Security rules

Wrong:

```text
api:getQcResult:P001
```

Correct:

```text
api:{userId}:getQcResult:{argsHash}
```

because two users may have different permissions.

Most important:

```text
authorization check
    ↓
API cache lookup
```

not:

```text
API cache hit
    ↓
skip authorization
```

A cache hit must never bypass GPAS2 ACL.

---

# 21. ToolRun Does Not Need a Redis Mirror

Do not create:

```text
toolrun:{toolRunId}
```

by default.

`ToolRun` already has durable PostgreSQL state and idempotency.

Typical synchronous Tool flow:

```text
Generation
    ↓
INSERT ToolRun
    ↓
internal GPAS2 API
    ↓
UPDATE ToolRun
    ↓
return result to model
```

For side-effecting tools, persist `ToolRun` before calling the internal API.

If a Tool launches a long-running computation, use:

```text
AnalysisJob
+
job:progress:{jobId}
```

instead of treating ToolRun itself as the long-running state machine.

---

# 22. Optional HTTP/API Idempotency Cache

## Key

```text
idem:{userId}:{idempotencyKey}
```

## Type

```text
STRING JSON
```

## TTL

```text
24 hours
```

Example:

```json
{
  "type": "analysisJob",
  "id": "J001",
  "status": "running"
}
```

## Purpose

Fast-path repeated client requests.

Redis is not the authoritative idempotency mechanism.

A Redis miss must fall back to PostgreSQL unique constraints.

---

# 23. Optional Worker Lock

Only use this if the job framework does not already manage distributed locks.

## Key

```text
lock:job:{jobId}
```

## Type

```text
STRING
```

Example acquire:

```text
SET lock:job:J001 worker-03 NX PX 30000
```

## TTL

```text
~30 seconds
```

Renew:

```text
every ~10 seconds
```

## Important

`AnalysisJob.workerId`, `leaseUntil`, and `heartbeatAt` in PostgreSQL remain the authoritative worker ownership metadata.

If BullMQ or another queue already implements Redis locks/leases:

```text
do not implement an additional custom lock protocol
```

---

# 24. Shared Chat ACL Must Stay in PostgreSQL

Do not cache long-lived shared-access flags such as:

```text
shared:chat:{chatId}=true
```

because revocation must take effect immediately.

Authoritative sharing state remains:

```text
Chat.shareScope
Chat.shareMode
Chat.sharedThroughSeq
Chat.shareSlug
```

Shared-content queries should use the safe PostgreSQL sharing views/service layer.

If sharing traffic becomes extremely high in the future, a very short cache (for example 5–15 seconds) may be considered, but it must have explicit invalidation on share/revoke.

Do not implement that in v2 unless needed.

---

# 25. Attachment Cache Policy

Attachments are owner-only and never inherit Chat sharing.

Do not cache authorization decisions such as:

```text
attachment:{id}:allowed:{userId}=true
```

for long periods.

Attachment metadata may be cached later if needed, but every read/download request must still enforce owner authorization.

---

# 26. Artifact Cache Policy

Artifact truth belongs to PostgreSQL plus object storage.

Do not store the canonical Artifact object in Redis.

Possible future optimization:

```text
artifact:render:{artifactId}:{version}
```

for expensive rendered HTML/report views.

Suggested TTL:

```text
30 minutes–2 hours
```

Always authorize the requesting user before returning a cached render.

Sharing rules:

```text
report/table/chart
    may inherit authenticated Chat sharing

file/dataset
    owner-only
```

---

# 27. Recommended Realtime Flow: Normal Chat Generation

```text
User request
    ↓
validate session
    ↓
optional identity:resolve cache
    ↓
rate limit
    ├─ rl:user
    └─ rl:ip
    ↓
token quota check
    ↓
generation concurrency acquire
    ↓
PostgreSQL:
create Generation
    ↓
generation:{generationId}
    ↓
load chat context
    ├─ chat:ctx hit
    └─ miss → rebuild from PostgreSQL
    ↓
LLM
    ↓
optional ToolRun → GPAS2 API
    ↓
stream output
    ↓
stream:{streamId}:*
    ↓
PostgreSQL transaction:
final Message
Generation final state
UsageEvent
    ↓
Redis:
quota apply
generation status update
release concurrency lease
    ↓
notify:user:{userId}
```

---

# 28. Recommended Realtime Flow: Analysis Job

```text
LLM Tool call
    ↓
persist ToolRun
    ↓
create AnalysisJob in PostgreSQL
    ↓
enqueue worker task
    ↓
job:progress:{jobId}
    ↓
Worker updates:
PostgreSQL AnalysisJob / JobEvent
+
Redis job:progress
    ↓
final state
    ↓
Artifact created
    ↓
publish:
notify:user:{userId}
    ↓
frontend refetches authoritative API state
```

---

# 29. Redis Failure Semantics

The system must remain correct if Redis is unavailable.

## Redis unavailable consequences

Acceptable:

- slower session/profile lookup
- slower context reconstruction
- no resumable stream recovery
- no realtime job progress
- no Pub/Sub notification
- quota cache rebuild required
- concurrency/rate limiting may need fail-safe handling

Not acceptable:

- lost Chat
- lost Message
- lost AnalysisJob
- lost Artifact
- lost final Generation state
- lost token usage
- lost audit history
- permission escalation

## Recommended fail behavior

Authentication/session verification:

```text
fallback to GPAS2
```

Chat context:

```text
fallback to PostgreSQL reconstruction
```

Job progress:

```text
fallback to AnalysisJob / JobEvent
```

Quota:

```text
fallback to UsageEvent aggregation
```

Rate limiting/concurrency:

Choose explicitly between:

```text
fail-open
```

or:

```text
fail-closed
```

depending on the endpoint.

For expensive model generation, prefer conservative behavior if Redis quota/concurrency state cannot be reconstructed reliably.

---

# 30. Keys to Implement First

Minimum v2 Redis implementation:

```text
identity:resolve:{cookieHash}   # optional; omit initially if /info is fast enough

chat:ctx:{chatId}

generation:{generationId}
stream:{streamId}:*
control:runner:{runnerId}

job:progress:{jobId}
notify:user:{userId}

quota:user:{userId}:{yyyyMM}
quota:applied:{generationId}

rl:user:{userId}:req:{window}
rl:ip:{ip}:req:{window}

concurrency:user:{userId}:generation
```

Optional later:

```text
api:{userId}:{toolName}:{argsHash}
idem:{userId}:{idempotencyKey}
lock:job:{jobId}
artifact:render:{artifactId}:{version}
```

---

# 31. Agent Invariants

Any implementation agent modifying Redis-related code must preserve these invariants.

## Invariant 1 — PostgreSQL is authoritative

Never design a workflow where Redis is the only record of:

```text
message
generation completion
job completion
artifact
usage
permission
audit
```

## Invariant 2 — Redis must be disposable

The application must be able to recover correctness after:

```text
FLUSHALL
```

using PostgreSQL + GPAS2.

## Invariant 3 — Sharing is never derived from LLM context cache

Never serve:

```text
chat:ctx:*
```

to shared-chat readers.

## Invariant 4 — Attachment is owner-only

Chat sharing never changes Attachment ACL.

## Invariant 5 — file/dataset Artifact is owner-only

Only display-type Artifacts:

```text
report
table
chart
```

may inherit Chat sharing.

## Invariant 6 — Resource ACL is checked before API cache

Never allow:

```text
Redis API cache hit
```

to bypass GPAS2 project/sample/report authorization.

## Invariant 7 — UsageEvent is token quota truth

Redis quota counters are only fast projections of PostgreSQL `UsageEvent`.

## Invariant 8 — Pub/Sub is not durable

A notification only means:

```text
state changed — refetch
```

## Invariant 9 — ToolRun remains PostgreSQL-backed

Do not introduce a Redis ToolRun state machine unless a concrete realtime requirement appears.

## Invariant 10 — Long-running compute uses AnalysisJob

A synchronous data-fetch Tool uses:

```text
Generation → ToolRun → GPAS2 API
```

A long-running compute task uses:

```text
Generation → ToolRun → AnalysisJob → Worker → Artifact
```

---


## Invariant 11 — GPAS2 Owns Authentication

The Chatbot must not implement an independent authentication/session system.

Identity must come from:

```text
GPAS2 Cookie -> GPAS2 /info -> externalUserId
```

A short-lived:

```text
identity:resolve:{cookieHash}
```

cache is optional.

Never store the raw GPAS2 Cookie in Redis.

For Tool calls, resource authorization remains enforced by GPAS2 using the current authenticated request context.

---

# 32. Final Architecture

```text
                         PostgreSQL
                      source of truth
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
       ▼                     ▼                     ▼
 Chat / Message       Generation / ToolRun   AnalysisJob / Artifact
       │                     │                     │
       │                     │                     │
       └──────────────┬──────┴──────────────┬──────┘
                      │                     │
                      ▼                     ▼
                    Redis              Object Storage
                 temporary layer        large files
                      │
       ┌──────────────┼────────────────────────────┐
       │              │             │              │
       ▼              ▼             ▼              ▼
 Auth/Profile     LLM Context   Realtime State   Usage Control
 Cache            Cache         / Streaming      / Limits
```

Redis exists to make the system faster and realtime.

It must not redefine business truth, ownership, sharing, billing/quota history, or durable job state.
