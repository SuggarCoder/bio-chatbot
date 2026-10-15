# Generation lifecycle, cancellation, and resume

`Generation` is the durable lifecycle for one assistant response. PostgreSQL is authoritative; Redis provides only scheduling, leases, cancellation acceleration, snapshots, and temporary stream events.

## State machine

```text
created -> queued -> scheduled -> running -> completed
                                  |        -> failed
                                  |        -> interrupted
                                  |        -> timed_out
                                  -> cancelling -> cancelled
```

The API creates the user message, assistant placeholder, Generation, sequence allocation, and Outbox event in one short transaction. The assistant placeholder begins as `pending`; the Worker changes it to `streaming` and updates the same row once at terminal finalization.

No PostgreSQL transaction or connection remains checked out while the provider is streaming. Deltas go to a native Redis Stream and are aggregated in Worker memory. A one-second Redis snapshot supports crash diagnostics and partial-output recovery.

## Disconnect is not cancellation

The SSE request owns only its stream subscription. Closing or refreshing the page cancels that reader but does not touch the Worker `AbortController`.

The only user cancellation path is:

```text
POST /api/generations/:generationId/cancel
  -> authenticate and enforce Generation.userId
  -> persist cancelling/cancelled in PostgreSQL
  -> SET generation:{userId}:{generationId}:cancel with TTL
  -> PUBLISH worker:cancel
  -> Worker aborts the Generation-scoped AbortController
  -> finalizer stores partial output and cancelled state
  -> Redis Stream receives message.finish
```

Pub/Sub is best effort. The Worker also checks the cancel key and PostgreSQL at throttled checkpoints, so a lost notification cannot lose durable cancellation intent.

## Resume

Each Generation has one logical `streamId`, while the SSE cursor is the Redis Stream entry ID. The client stores `{ userId, conversationId, generationId, streamId, lastEventId }` in `sessionStorage` and reconnects with:

```http
Last-Event-ID: 1785930000000-0
```

The process-level stream hub uses one Redis Subscriber and fans out events to all local SSE readers. Pub/Sub only wakes readers; replay always comes from ordered `XRANGE` reads. Heartbeat comments keep idle SSE connections alive.

If Redis data has expired, terminal Generation state and the assistant message are returned from PostgreSQL. A running Generation stream is retained for one hour with sliding expiry; completed/cancelled streams retain 15 minutes and failed streams 30 minutes.

## Worker recovery

The Worker renews the Generation lease and conversation lock every 10 seconds against a 30-second TTL. Recovery behavior is deliberately conservative:

- No provider request marker: requeue through a new Outbox event.
- Provider request marker exists: finalize as `interrupted`; never call the provider again automatically.
- Cancellation intent exists: finalize as `cancelled` using the latest Redis snapshot.

This avoids duplicate provider charges and duplicate assistant answers.

## Race guarantees

Finalization locks the Generation row. Terminal rows are idempotent. If cancellation commits first, finalization chooses `cancelled`; if a terminal result commits first, a later cancel is a no-op. A partial unique index plus the Redis conversation lock ensure only one scheduled/running/cancelling Generation exists per conversation.
