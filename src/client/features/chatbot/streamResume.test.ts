import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareStreamEventIds,
  readStreamResume,
  resetStorageWarning,
  StreamResumeWriter,
  streamCursorKey,
  streamResumeKey,
  sweepStreamResume,
  type StorageLike,
} from './streamResume'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()
  writes = 0
  bytesWritten = 0
  quota = Number.POSITIVE_INFINITY

  get length() {
    return this.values.size
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    if (value.length > this.quota) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    this.writes += 1
    this.bytesWritten += key.length + value.length
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

const meta = {
  userId: 'u1',
  conversationId: 'c1',
  generationId: 'g1',
  streamId: 's1',
}

test('a 20k-character answer writes kilobytes, not tens of megabytes', () => {
  const storage = new MemoryStorage()
  let now = 0
  const writer = new StreamResumeWriter(storage, meta, { now: () => now })
  writer.begin('0-0', '')
  let text = ''
  // 5,000 four-character deltas, one every 5 ms (25 s), as in the review's measurement.
  for (let index = 0; index < 5_000; index += 1) {
    text += 'abcd'
    now += 5
    writer.record(`1-${index + 1}`, text)
  }
  writer.close(false)

  // One snapshot per second at most, plus the start and the final flush.
  const snapshotWrites = storage.writes - 5_000
  assert.ok(snapshotWrites <= 27, `snapshot writes: ${snapshotWrites}`)
  // The old code wrote the whole text on every event: about 51 MB here.
  assert.ok(storage.bytesWritten < 1_000_000, `bytes written: ${storage.bytesWritten}`)
  assert.deepEqual(readStreamResume(storage, meta), { cursor: '1-5000', text })
})

test('resume uses the newer per-event cursor only when no text arrived after the snapshot', () => {
  const storage = new MemoryStorage()
  let now = 0
  const writer = new StreamResumeWriter(storage, meta, { now: () => now })
  writer.begin('0-0', '')
  now = 2_000
  writer.record('1-10', 'hello')
  // Within the interval: only the cursor key is written.
  now = 2_100
  writer.record('1-11', 'hello')
  writer.record('1-12', 'hello')
  assert.deepEqual(readStreamResume(storage, meta), { cursor: '1-12', text: 'hello' })

  writer.record('1-13', 'hello world')
  // The snapshot still holds 'hello' at 1-12: resuming there replays ' world'.
  assert.deepEqual(readStreamResume(storage, meta), { cursor: '1-10', text: 'hello' })

  writer.flush()
  assert.deepEqual(readStreamResume(storage, meta), { cursor: '1-13', text: 'hello world' })
  writer.close(true)
})

test('resume ignores another stream and drops unreadable state', () => {
  const storage = new MemoryStorage()
  const writer = new StreamResumeWriter(storage, meta)
  writer.begin('1-3', 'abc')
  assert.equal(readStreamResume(storage, { ...meta, streamId: 'other' }), undefined)
  storage.values.set(streamResumeKey('u1', 'g1'), '{broken')
  assert.equal(readStreamResume(storage, meta), undefined)
  assert.equal(storage.values.size, 0)
  writer.close(true)
})

test('closing removes both keys; closing while the page hides keeps them', () => {
  const storage = new MemoryStorage()
  const finished = new StreamResumeWriter(storage, meta)
  finished.begin('0-0', '')
  finished.record('1-1', 'a')
  finished.close(true)
  assert.equal(storage.values.size, 0)
  finished.record('1-2', 'ab')
  assert.equal(storage.values.size, 0, 'a closed writer writes nothing')

  let now = 0
  const leaving = new StreamResumeWriter(storage, meta, { now: () => now })
  leaving.begin('0-0', '')
  now = 10
  leaving.record('1-1', 'a')
  leaving.record('1-2', 'ab')
  leaving.close(false)
  assert.deepEqual(readStreamResume(storage, meta), { cursor: '1-2', text: 'ab' })
})

test('a storage quota failure warns once and the stream continues', (context) => {
  resetStorageWarning()
  const warn = context.mock.method(console, 'warn', () => {})
  const storage = new MemoryStorage()
  storage.quota = 100
  let now = 0
  const writer = new StreamResumeWriter(storage, meta, { now: () => now, intervalMs: 0 })
  writer.begin('0-0', '')
  for (let index = 1; index <= 10; index += 1) {
    now += 1
    writer.record(`1-${index}`, 'x'.repeat(index * 50))
  }
  writer.close(true)
  assert.equal(warn.mock.callCount(), 1)
})

test('sweep removes stale and finished generations of this user only', () => {
  const storage = new MemoryStorage()
  const now = 10 * 60 * 60_000
  const write = (userId: string, generationId: string, conversationId: string, updatedAt: number) => {
    storage.values.set(streamResumeKey(userId, generationId), JSON.stringify({
      userId, conversationId, generationId, streamId: 's', lastEventId: '1-1', partialText: 'x', updatedAt,
    }))
    storage.values.set(streamCursorKey(userId, generationId), JSON.stringify({
      streamId: 's', lastEventId: '1-2', textLength: 1, updatedAt,
    }))
  }
  write('u1', 'old', 'c1', now - 2 * 60 * 60_000)
  write('u1', 'active', 'c1', now - 1_000)
  write('u1', 'finished', 'c1', now - 1_000)
  write('u1', 'elsewhere', 'c2', now - 1_000)
  write('u2', 'other-user', 'c1', 0)
  storage.values.set('chat:u1:generation:broken:stream', 'not json')
  storage.values.set('unrelated', 'keep')

  sweepStreamResume(storage, 'u1', { now })
  assert.deepEqual([...storage.values.keys()].filter((key) => key.startsWith('chat:u1:')).sort(), [
    streamCursorKey('u1', 'active'),
    streamCursorKey('u1', 'elsewhere'),
    streamCursorKey('u1', 'finished'),
    streamResumeKey('u1', 'active'),
    streamResumeKey('u1', 'elsewhere'),
    streamResumeKey('u1', 'finished'),
  ].sort())

  sweepStreamResume(storage, 'u1', {
    now,
    conversationId: 'c1',
    keepGenerationIds: new Set(['active']),
  })
  assert.deepEqual([...storage.values.keys()].filter((key) => key.startsWith('chat:u1:')).sort(), [
    streamCursorKey('u1', 'active'),
    streamCursorKey('u1', 'elsewhere'),
    streamResumeKey('u1', 'active'),
    streamResumeKey('u1', 'elsewhere'),
  ].sort())
  assert.ok(storage.values.has(streamResumeKey('u2', 'other-user')))
  assert.ok(storage.values.has('unrelated'))
})

test('stream event ids order by time, then sequence', () => {
  assert.ok(compareStreamEventIds('2-0', '1-9') > 0)
  assert.ok(compareStreamEventIds('1-10', '1-9') > 0)
  assert.equal(compareStreamEventIds('1-1', '1-1'), 0)
})
