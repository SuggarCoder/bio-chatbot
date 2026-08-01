# Generation Cancellation Architecture

`Generation` is the only Chat/Agent run entity. Its UUID is the runtime and
stream-event isolation boundary; no separate Run, epoch, or version exists.

## Durable model

- `Message` is immutable conversation history. Streaming never inserts or
  updates an assistant message.
- `Generation` is the durable execution lifecycle. PostgreSQL status is
  `pending`, `streaming`, `completed`, `failed`, or `cancelled`.
- A non-terminal Generation with `cancelRequestedAt` is effectively
  `cancelling`. PostgreSQL does not store a `cancelling` enum value.
- `Stream` belongs one-to-one to `Generation`. PostgreSQL stores identity and
  expiry metadata; resumable-stream owns temporary Redis chunks.
- `Generation.assistantMessageId` is assigned only by terminal finalization,
  and points to the single immutable assistant message produced by that
  Generation.
- `UsageEvent` is written for completed, cancelled, and failed Generations.

Cancelled or failed output is inserted once at terminalization only when it has
UI-visible content. It remains visible after reload but is excluded from normal
LLM context and shared-chat views.

## Runtime and cancellation path

Each Fastify instance owns a `runnerId` and a process-local
`GenerationRuntimeRegistry`. Every running Generation has its own
`AbortController`, partial-output accumulator, provider request ID, and usage
accumulator.

```text
Stop click
  -> abort browser reader immediately
  -> invalidate activeGenerationId and retain partial UI content
  -> POST /api/generations/:generationId/cancel
  -> authenticate via GPAS2 cookie and verify Generation.userId
  -> PostgreSQL sets cancelRequestedAt/cancelSource idempotently
  -> release logical concurrency lease
  -> abort local runtime or publish control:runner:{runnerId}
  -> provider/agent checkpoint observes AbortSignal or PostgreSQL intent
  -> GenerationFinalizer locks row and commits one terminal result
```

Redis is a low-latency projection and control plane only. If Pub/Sub is lost or
Redis is flushed, checkpoints query PostgreSQL before LLM calls, after LLM
calls, before/after tools, before another Agent iteration, and before
finalization.

Network/SSE disconnect is intentionally absent from this path. The background
producer continues and the browser may resume its Generation stream.

## Finalization and races

All outcomes use `GenerationFinalizer`. The database transaction selects the
Generation `FOR UPDATE`:

1. A terminal row is an idempotent no-op.
2. A row with `cancelRequestedAt` finalizes as `cancelled`.
3. Otherwise the requested completed/failed outcome wins.
4. Partial content is inserted as one immutable assistant message.
5. Generation tokens, timings, terminal status, assistantMessageId, and
   `UsageEvent` commit atomically.

If Cancel commits first, Finalizer sees cancellation intent and chooses
cancelled. If Complete commits first, Cancel sees an existing terminal status
and returns it without overwriting it.

## Frontend isolation

The chat store owns an `ActiveGeneration` object, not an `isGenerating`
boolean. Every stream event includes `generationId` and `streamId`; an event is
discarded unless its `generationId` equals the chat's current active
Generation. Stop clears that identity synchronously, so delayed G1 events
cannot alter G2.

## Tools and detached jobs

Tool executors must receive the Generation signal and call the authoritative
checkpoint before and after execution. Cancellable tools pass the signal to
their HTTP/MCP/provider call. A side-effecting tool creates `ToolRun` before
execution and records what actually happened; abort never implies rollback.

`AnalysisJob` has its own cancellation lifecycle. Generation cancellation does
not cancel a detached job by default. `AnalysisJob.originToolRunId` records
lineage without coupling lifecycles.
