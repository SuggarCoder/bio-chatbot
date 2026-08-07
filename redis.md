# Redis design for bio-chatbot v3

PostgreSQL is the source of truth. Redis is a disposable coordination and realtime layer; flushing Redis may interrupt active work but must not remove durable conversations, messages, final Generation state, usage, sharing permissions, or audit records.

`User.id` is also the tenant identifier. Every tenant-scoped key therefore contains `userId`.

## Connection budget

The initial deployment uses one API process and one Worker process:

| Process | Connection | Purpose |
|---|---:|---|
| API | 1 | ordinary commands and Redis Stream replay |
| API | 1 | process-level stream notification Subscriber |
| Worker | 1 | queue, leases, snapshots, publishing |
| Worker | 1 | process-level cancel Subscriber |

No SSE request creates a Redis Client. The remaining connections stay available for operations and future services.

## Namespace and keys

Use an environment/version prefix such as `gpas2cb:prod:v3:`. The examples below omit it.

```text
queue:ready-users                              ZSET
queue:user-weights                             HASH
queue:tenant:{userId}                          STREAM
queue:dedupe:{userId}:{generationId}:{attempt} STRING, 24h

running:global                                 ZSET lease slots
running:provider:{provider}                    ZSET lease slots
running:model:{provider}:{model}               ZSET lease slots
tenant:{userId}:running                        ZSET lease slots
conversation:{userId}:{conversationId}:lock    STRING lease token, 30s

generation:{userId}:{generationId}:lease       STRING lease token, 30s
generation:{userId}:{generationId}:cancel      STRING, 1h
generation:{userId}:{generationId}:snapshot    STRING JSON, 1h

worker:{workerId}:heartbeat                    STRING, 30s
worker:heartbeat                               STRING, 30s
worker:cancel                                  Pub/Sub

stream:{userId}:{generationId}                 STREAM
stream:events                                  Pub/Sub

chat:ctx:{conversationId}                      STRING JSON, 2h
rl:user:{userId}:generation:{window}           counter
rl:ip:{ip}:generation:{window}                 counter
quota:user:{userId}:{yyyyMM}                   counter
quota:applied:{generationId}                   idempotency marker
notify:user:{userId}                           Pub/Sub
```

## Queue and fairness

Each User/tenant owns a Redis Stream queue. `queue:ready-users` stores a weighted virtual finish score. The scheduler pops the lowest score and advances it by `1 / schedulingWeight`, which provides weighted fairness without starving lower-weight users.

Before scheduling, one Lua operation removes expired slots and checks global, provider, model, and user limits, then acquires those slots plus the conversation lock and Generation lease. Failed lock acquisition defers the user score so a blocked conversation cannot spin or starve other users.

The PostgreSQL Outbox is the reliable enqueue source. A queued PostgreSQL Generation missing from Redis is periodically re-enqueued idempotently.

## Streaming

The project uses native Redis Streams, not the `resumable-stream` package. Events are appended with approximate `MAXLEN 10000`; the Redis Stream ID is the SSE `id` and the browser sends it back in `Last-Event-ID`.

Retention is sliding:

- running: 3600 seconds
- completed/cancelled: 900 seconds
- failed/interrupted/timed out: 1800 seconds

`stream:events` is only a low-latency wakeup. Readers use `XRANGE` from their last cursor, so Pub/Sub loss or reconnect cannot reorder authoritative stream entries.

## Cancellation and recovery

Cancel uses both `worker:cancel` Pub/Sub and the one-hour cancel key. The Worker checks the key every configured polling interval, not on every token.

Conversation locks and Generation leases use compare-and-renew/compare-and-delete Lua logic. A stale Worker cannot release a newer Worker's lock. Worker heartbeats support health checks; lease expiry drives stale Generation recovery.

Provider-started work is never automatically retried. Its durable Generation becomes `interrupted` and retains the latest partial snapshot.

## Failure semantics

Redis unavailable is fail-closed for creating expensive Generations, but existing PostgreSQL conversations and terminal messages remain readable. Redis Stream expiry falls back to the PostgreSQL Generation and assistant message. Quota counters can be rebuilt from `UsageEvent`; Pub/Sub is never treated as durable state.
