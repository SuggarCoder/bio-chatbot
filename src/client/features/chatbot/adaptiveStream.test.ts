import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AdaptiveStreamSession,
  getAdaptiveRate,
  splitGraphemes,
} from './adaptiveStream'

class FakeFrames {
  nowValue = 0
  nextId = 1
  callbacks = new Map<number, FrameRequestCallback>()

  scheduler = {
    request: (callback: FrameRequestCallback) => {
      const id = this.nextId
      this.nextId += 1
      this.callbacks.set(id, callback)
      return id
    },
    cancel: (id: number) => this.callbacks.delete(id),
    now: () => this.nowValue,
  }

  step(now: number) {
    this.nowValue = now
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    callbacks.forEach((callback) => callback(now))
  }
}

test('adaptive rate increases with backlog and remains capped', () => {
  assert.ok(getAdaptiveRate(5) < getAdaptiveRate(40))
  assert.ok(getAdaptiveRate(40) < getAdaptiveRate(160))
  assert.equal(getAdaptiveRate(1_000), 1_200)
})

test('grapheme splitting keeps emoji and combining sequences intact', () => {
  assert.deepEqual(splitGraphemes('A👩🏽‍🔬e\u0301中'), [
    'A',
    '👩🏽‍🔬',
    'e\u0301',
    '中',
  ])
})

test('bursty ingestion is paced and reconciles to canonical final text', () => {
  const frames = new FakeFrames()
  let visible = ''
  let terminalText = ''
  const session = new AdaptiveStreamSession('generation-1', {
    scheduler: frames.scheduler,
    reducedMotion: false,
    onTerminal: (_terminal, text) => {
      terminalText = text
    },
  })
  session.subscribe({
    append: (text) => {
      visible += text
    },
    replace: (text) => {
      visible = text
    },
  })

  session.push(0, '根据你的')
  frames.step(0)
  frames.step(16)
  frames.step(32)
  assert.equal(visible, '')
  frames.step(48)
  assert.notEqual(visible, '根据你的')

  session.push(4, '的描述，这个问题主要来自网络抖动。')
  session.finish('根据你的描述，这个问题主要来自网络抖动。', {
    kind: 'completed',
  })

  for (let now = 64; frames.callbacks.size > 0 && now < 5_000; now += 16) {
    frames.step(now)
  }

  assert.equal(visible, '根据你的描述，这个问题主要来自网络抖动。')
  assert.equal(terminalText, visible)
  assert.equal(frames.callbacks.size, 0)
})

test('a huge background dt catches the visible stream up immediately', () => {
  const frames = new FakeFrames()
  let visible = ''
  const session = new AdaptiveStreamSession('generation-2', {
    scheduler: frames.scheduler,
    reducedMotion: false,
    onTerminal: () => undefined,
  })
  session.subscribe({
    append: (text) => {
      visible += text
    },
    replace: (text) => {
      visible = text
    },
  })
  session.push(0, '字'.repeat(1_000))
  frames.step(0)
  frames.step(5_000)

  assert.equal(visible.length, 1_000)
  assert.equal(session.backlog, 0)
})

test('terminal output reconciles by the 750ms deadline', () => {
  const frames = new FakeFrames()
  let visible = ''
  const finalText = 'x'.repeat(5_000)
  const session = new AdaptiveStreamSession('generation-terminal-deadline', {
    scheduler: frames.scheduler,
    reducedMotion: false,
    onTerminal: () => undefined,
  })
  session.subscribe({
    append: (text) => {
      visible += text
    },
    replace: (text) => {
      visible = text
    },
  })
  session.push(0, finalText)
  frames.step(0)
  session.finish(finalText, { kind: 'completed' })

  for (let now = 16; now <= 752; now += 16) {
    frames.step(now)
  }

  assert.equal(visible, finalText)
  assert.equal(frames.callbacks.size, 0)
})

test('finish rejects late deltas and replaces a corrected visible prefix once', () => {
  const frames = new FakeFrames()
  let visible = ''
  const session = new AdaptiveStreamSession('generation-3', {
    scheduler: frames.scheduler,
    reducedMotion: true,
    onTerminal: () => undefined,
  })
  session.subscribe({
    append: (text) => {
      visible += text
    },
    replace: (text) => {
      visible = text
    },
  })

  session.push(0, '旧答案')
  session.finish('新答案', { kind: 'cancelled' })
  session.push(3, '不应出现')

  assert.equal(visible, '新答案')
  assert.equal(session.canonicalText, '新答案')
  assert.equal(frames.callbacks.size, 0)
})

test('overlapping reconnect deltas do not duplicate canonical text', () => {
  const frames = new FakeFrames()
  const session = new AdaptiveStreamSession('generation-4', {
    scheduler: frames.scheduler,
    reducedMotion: true,
    onTerminal: () => undefined,
  })
  session.subscribe({ append: () => undefined, replace: () => undefined })

  session.push(0, 'ABCDE')
  session.push(3, 'DEFG')

  assert.equal(session.canonicalText, 'ABCDEFG')
})

test('a surrogate pair split across deltas is never emitted as two graphemes', () => {
  const frames = new FakeFrames()
  let visible = ''
  const session = new AdaptiveStreamSession('generation-5', {
    scheduler: frames.scheduler,
    reducedMotion: false,
    onTerminal: () => undefined,
  })
  session.subscribe({
    append: (text) => {
      visible += text
    },
    replace: (text) => {
      visible = text
    },
  })

  session.push(0, '\ud83e')
  session.push(1, '\uddec')
  session.finish('🧬', { kind: 'completed' })

  for (let now = 0; frames.callbacks.size > 0 && now < 1_000; now += 16) {
    frames.step(now)
  }

  assert.equal(visible, '🧬')
})
