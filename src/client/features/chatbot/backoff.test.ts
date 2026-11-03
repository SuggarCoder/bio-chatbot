import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anySignal,
  fullJitterDelay,
  isTransientStatus,
  jitter,
  parseRetryAfter,
  pollDelay,
  sleep,
} from './backoff'

test('full jitter stays below the doubling ceiling and the cap', () => {
  const options = { baseMs: 500, capMs: 8_000 }
  assert.equal(fullJitterDelay(0, { ...options, random: () => 0 }), 0)
  assert.equal(fullJitterDelay(0, { ...options, random: () => 0.999 }), 500)
  assert.equal(fullJitterDelay(3, { ...options, random: () => 0.5 }), 2_000)
  assert.equal(fullJitterDelay(20, { ...options, random: () => 0.999 }), 7_992)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const delay = fullJitterDelay(attempt, options)
    assert.ok(delay >= 0 && delay < Math.min(8_000, 500 * 2 ** attempt) + 1)
  }
})

test('jitter spreads a delay over half to one and a half times', () => {
  assert.equal(jitter(1_000, () => 0), 500)
  assert.equal(jitter(1_000, () => 0.5), 1_000)
  assert.equal(jitter(1_000, () => 0.999), 1_499)
})

test('poll delay grows from the base to the cap with bounded jitter', () => {
  const options = { baseMs: 2_000, capMs: 30_000, random: () => 0.5 }
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map((attempt) => pollDelay(attempt, options)),
    [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  )
  assert.equal(pollDelay(0, { ...options, random: () => 0 }), 1_600)
  assert.equal(pollDelay(9, { ...options, random: () => 1 }), 36_000)
})

test('Retry-After accepts seconds and HTTP dates, and is capped', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  assert.equal(parseRetryAfter('3', now), 3_000)
  assert.equal(parseRetryAfter(' 1.5 ', now), 1_500)
  assert.equal(parseRetryAfter('Tue, 03 Nov 2026 00:00:10 GMT', now), 10_000)
  assert.equal(parseRetryAfter('Mon, 02 Nov 2026 00:00:00 GMT', now), 0)
  assert.equal(parseRetryAfter('86400', now), 120_000)
  assert.equal(parseRetryAfter('soon', now), undefined)
  assert.equal(parseRetryAfter(null, now), undefined)
})

test('only gateway and availability errors are transient', () => {
  assert.deepEqual(
    [400, 401, 404, 410, 429, 500, 502, 503, 504].filter(isTransientStatus),
    [502, 503, 504],
  )
})

test('sleep rejects with an AbortError when its signal aborts', async () => {
  const controller = new AbortController()
  const pending = sleep(60_000, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('anySignal aborts when either input aborts', () => {
  const first = new AbortController()
  const second = new AbortController()
  const combined = anySignal([first.signal, undefined, second.signal])
  assert.equal(combined.aborted, false)
  second.abort()
  assert.equal(combined.aborted, true)
  assert.equal(anySignal([first.signal]), first.signal)
})
