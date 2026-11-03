import assert from 'node:assert/strict'
import test from 'node:test'

import { LoadShedder } from './loadShed.js'

test('load shedding reacts to sustained saturation only', () => {
  const pool = { waitingCount: 0 }
  const shedder = new LoadShedder(pool, { maxEventLoopDelayMs: 500, maxPoolWaiting: 10 })
  try {
    const start = 1_000_000
    pool.waitingCount = 50
    shedder.samplePoolForTest(start)
    assert.equal(shedder.check(start + 500), null, 'a queue under a second old is absorbed')
    assert.equal(shedder.check(start + 1_000), 'db_pool')
    pool.waitingCount = 3
    assert.equal(shedder.check(start + 1_100), null, 'recovers as soon as the queue drains')

    shedder.setRecentDelayForTest(900, 1)
    assert.equal(shedder.check(), null, 'one slow event-loop window is absorbed')
    shedder.setRecentDelayForTest(900, 2)
    assert.equal(shedder.check(), 'event_loop')
    shedder.setRecentDelayForTest(10)
    assert.equal(shedder.check(), null)
  } finally {
    shedder.stop()
  }
})
