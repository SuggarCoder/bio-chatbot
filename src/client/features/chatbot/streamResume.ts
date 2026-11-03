/**
 * Resume state for a generation's SSE stream, kept in sessionStorage so a
 * reload continues where it left off instead of replaying the whole answer.
 *
 * Two keys per generation:
 * - `…:stream`  the partial text with the event id it is complete up to.
 *   It is the expensive one (it grows with the answer), so it is written at
 *   most once per `intervalMs`, plus on demand (page hide).
 * - `…:cursor`  the latest event id and the text length at that event: a few
 *   dozen bytes, written on every event. It is used on resume only when no
 *   text arrived after the snapshot (tool calls, progress, artifacts), so the
 *   restored text and cursor always agree. Replaying a little text is safe:
 *   deltas carry their start index and overlap is dropped.
 */

export type StorageLike = {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type StreamResumeMeta = {
  userId: string
  conversationId: string
  generationId: string
  streamId: string
}

type Snapshot = StreamResumeMeta & {
  lastEventId: string
  partialText: string
  updatedAt: number
}

type Cursor = {
  streamId: string
  lastEventId: string
  textLength: number
  updatedAt: number
}

const STREAM_ID_PATTERN = /^\d+-\d+$/
const MAX_RESTORED_TEXT = 1_000_000
export const STREAM_RESUME_MAX_AGE_MS = 60 * 60_000

export function streamResumeKey(userId: string, generationId: string) {
  return `chat:${userId}:generation:${generationId}:stream`
}

export function streamCursorKey(userId: string, generationId: string) {
  return `chat:${userId}:generation:${generationId}:cursor`
}

export function isStreamEventId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID_PATTERN.test(value)
}

/** Orders Redis stream ids (`ms-seq`). */
export function compareStreamEventIds(left: string, right: string) {
  const [leftMs, leftSeq] = left.split('-').map(Number)
  const [rightMs, rightSeq] = right.split('-').map(Number)
  return leftMs - rightMs || leftSeq - rightSeq
}

let storageWarningShown = false

/** For tests: lets the next storage failure warn again. */
export function resetStorageWarning() {
  storageWarningShown = false
}

function safeSet(storage: StorageLike, key: string, value: string) {
  try {
    storage.setItem(key, value)
    return true
  } catch (error) {
    if (!storageWarningShown) {
      storageWarningShown = true
      console.warn(
        '[chat] Stream resume state could not be saved; a reload will replay the answer from the start.',
        error,
      )
    }
    return false
  }
}

function safeRemove(storage: StorageLike, key: string) {
  try {
    storage.removeItem(key)
  } catch {
    // Unavailable storage holds nothing to remove.
  }
}

function safeParse<T>(storage: StorageLike, key: string): T | null | undefined {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function browserSessionStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** Reads the resume point for this stream, or undefined to start from the beginning. */
export function readStreamResume(
  storage: StorageLike | undefined,
  meta: Pick<StreamResumeMeta, 'userId' | 'generationId' | 'streamId'>,
): { cursor: string; text: string } | undefined {
  if (!storage) return undefined
  const snapshotKey = streamResumeKey(meta.userId, meta.generationId)
  const cursorKey = streamCursorKey(meta.userId, meta.generationId)
  const snapshot = safeParse<Partial<Snapshot>>(storage, snapshotKey)
  const cursor = safeParse<Partial<Cursor>>(storage, cursorKey)

  if (snapshot === undefined || cursor === undefined) {
    safeRemove(storage, snapshotKey)
    safeRemove(storage, cursorKey)
    return undefined
  }

  if (
    !snapshot ||
    snapshot.streamId !== meta.streamId ||
    !isStreamEventId(snapshot.lastEventId)
  ) {
    return undefined
  }

  const text = typeof snapshot.partialText === 'string'
    ? snapshot.partialText.slice(0, MAX_RESTORED_TEXT)
    : ''
  let resumeFrom = snapshot.lastEventId

  if (
    cursor &&
    cursor.streamId === meta.streamId &&
    isStreamEventId(cursor.lastEventId) &&
    cursor.textLength === text.length &&
    compareStreamEventIds(cursor.lastEventId, resumeFrom) > 0
  ) {
    resumeFrom = cursor.lastEventId
  }

  return { cursor: resumeFrom, text }
}

export class StreamResumeWriter {
  private lastEventId = '0-0'
  private partialText = ''
  private lastSnapshotAt = Number.NEGATIVE_INFINITY
  private dirty = false
  private trailingTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly snapshotKey: string
  private readonly cursorKey: string
  private readonly intervalMs: number
  private readonly now: () => number

  constructor(
    private readonly storage: StorageLike | undefined,
    private readonly meta: StreamResumeMeta,
    options: { intervalMs?: number; now?: () => number } = {},
  ) {
    this.snapshotKey = streamResumeKey(meta.userId, meta.generationId)
    this.cursorKey = streamCursorKey(meta.userId, meta.generationId)
    this.intervalMs = options.intervalMs ?? 1_000
    this.now = options.now ?? Date.now
  }

  /** Writes the starting point at once. */
  begin(lastEventId: string, partialText: string) {
    this.lastEventId = lastEventId
    this.partialText = partialText
    this.dirty = true
    this.flush()
  }

  /** Called for every event that carries a stream id. */
  record(lastEventId: string, partialText: string) {
    if (this.closed || !this.storage) return
    this.lastEventId = lastEventId
    this.partialText = partialText
    safeSet(this.storage, this.cursorKey, JSON.stringify({
      streamId: this.meta.streamId,
      lastEventId,
      textLength: partialText.length,
      updatedAt: this.now(),
    } satisfies Cursor))
    this.dirty = true

    if (this.now() - this.lastSnapshotAt >= this.intervalMs) {
      this.flush()
    } else {
      this.trailingTimer ??= setTimeout(() => {
        this.trailingTimer = undefined
        this.flush()
      }, this.intervalMs)
    }
  }

  /** Writes the partial text now if it changed since the last write. */
  flush() {
    if (this.closed || !this.storage || !this.dirty) return
    this.dirty = false
    this.lastSnapshotAt = this.now()
    if (this.trailingTimer !== undefined) {
      clearTimeout(this.trailingTimer)
      this.trailingTimer = undefined
    }
    safeSet(this.storage, this.snapshotKey, JSON.stringify({
      ...this.meta,
      lastEventId: this.lastEventId,
      partialText: this.partialText,
      updatedAt: this.lastSnapshotAt,
    } satisfies Snapshot))
  }

  /** Stops writing; with `remove`, deletes both keys (the stream ended or was abandoned). */
  close(remove: boolean) {
    if (remove) {
      this.closed = true
    } else {
      this.flush()
      this.closed = true
    }
    if (this.trailingTimer !== undefined) {
      clearTimeout(this.trailingTimer)
      this.trailingTimer = undefined
    }
    if (remove && this.storage) {
      safeRemove(this.storage, this.snapshotKey)
      safeRemove(this.storage, this.cursorKey)
    }
  }
}

/**
 * Removes this user's resume keys that can no longer be used: older than
 * `maxAgeMs`, unreadable, or (with `conversationId`) belonging to that
 * conversation but not to one of `keepGenerationIds`.
 */
export function sweepStreamResume(
  storage: StorageLike | undefined,
  userId: string,
  options: {
    now?: number
    maxAgeMs?: number
    conversationId?: string
    keepGenerationIds?: ReadonlySet<string>
  } = {},
): string[] {
  if (!storage) return []
  const prefix = `chat:${userId}:generation:`
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? STREAM_RESUME_MAX_AGE_MS
  const generations = new Map<string, { keys: string[]; updatedAt: number; conversationId?: string; broken: boolean }>()
  let keys: string[]
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(prefix)))
  } catch {
    return []
  }

  for (const key of keys) {
    const match = /^(.*):(stream|cursor)$/.exec(key.slice(prefix.length))
    if (!match) continue
    const [, generationId, kind] = match
    const entry = generations.get(generationId) ??
      { keys: [], updatedAt: Number.NEGATIVE_INFINITY, broken: false }
    generations.set(generationId, entry)
    entry.keys.push(key)
    const value = safeParse<{ updatedAt?: unknown; conversationId?: unknown }>(storage, key)
    if (!value || typeof value !== 'object') {
      entry.broken = true
      continue
    }
    if (typeof value.updatedAt === 'number') {
      entry.updatedAt = Math.max(entry.updatedAt, value.updatedAt)
    }
    if (kind === 'stream' && typeof value.conversationId === 'string') {
      entry.conversationId = value.conversationId
    }
  }

  const removed: string[] = []
  for (const [generationId, entry] of generations) {
    const stale = entry.broken || now - entry.updatedAt > maxAgeMs
    const inactive = options.conversationId !== undefined &&
      entry.conversationId === options.conversationId &&
      !options.keepGenerationIds?.has(generationId)
    if (!stale && !inactive) continue
    for (const key of entry.keys) {
      safeRemove(storage, key)
      removed.push(key)
    }
  }
  return removed
}
