import assert from 'node:assert/strict'
import test from 'node:test'

import { hashString, LruCache, selectEvictions, touchRecent } from './lru'

test('LRU cache evicts the least recently used entry', () => {
  const cache = new LruCache<string, number>(2)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.size, 2)
})

test('string hashes are stable and spread', () => {
  assert.equal(hashString('graph TD\nA-->B'), hashString('graph TD\nA-->B'))
  assert.notEqual(hashString('graph TD\nA-->B'), hashString('graph TD\nA-->C'))
})

test('conversation eviction keeps the open and recent ones and skips pinned ones', () => {
  let order: string[] = []
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) order = touchRecent(order, id)
  order = touchRecent(order, 'c2')
  assert.deepEqual(order, ['c2', 'c5', 'c4', 'c3', 'c1'])
  // Keep the open conversation plus two recent ones; c3 has a reply running.
  assert.deepEqual(selectEvictions(order, 3, (id) => id !== 'c3'), ['c1'])
  assert.deepEqual(selectEvictions(order, 10, () => true), [])
})

test('reloading a conversation detail keeps unchanged message objects', async () => {
  // The browser build: in Node, 'solid-js/store' resolves to Solid's server
  // build, which has no keyed reconcile.
  const browserStore = 'solid-js/store/dist/store.js'
  const { createStore, reconcile, unwrap } =
    await import(browserStore) as typeof import('solid-js/store')
  type Message = { id: string; content: string; parts: Array<{ type: string; text: string }>; vote: string | null }
  const message = (id: string, content: string, vote: string | null = null): Message => ({
    id, content, parts: [{ type: 'text', text: content }], vote,
  })
  const [state, setState] = createStore<{ messages: Message[] }>({
    messages: [message('m1', 'first'), message('m2', 'second'), message('local', 'streaming')],
  })
  const before = unwrap(state).messages.slice()

  // The server's copy: same first message, a vote on the second, the
  // streamed reply now persisted under its own id.
  setState('messages', reconcile(
    [message('m1', 'first'), message('m2', 'second', 'up'), message('m3', 'final')],
    { key: 'id', merge: false },
  ))
  const after = unwrap(state).messages

  assert.equal(after[0], before[0], 'unchanged message keeps its object')
  assert.equal(after[0].parts, before[0].parts)
  assert.equal(after[1], before[1], 'changed message is updated in place')
  assert.equal(after[1].vote, 'up')
  assert.notEqual(after[2], before[2])
  assert.equal(after[2].id, 'm3')
})
