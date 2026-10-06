import assert from 'node:assert/strict'
import test from 'node:test'
import { openCredential, sealCredential } from './ingress.js'

test('durable credentials are authenticated, randomized and bound to user/request', () => {
  const key = Buffer.alloc(32, 5).toString('base64')
  const first = sealCredential('cookie=secret', key, 'user:request')
  const second = sealCredential('cookie=secret', key, 'user:request')
  assert.notEqual(first, second)
  assert.equal(openCredential(first, key, 'user:request'), 'cookie=secret')
  assert.throws(() => openCredential(first, key, 'another:request'))
  assert.throws(() => openCredential(first, Buffer.alloc(32, 6).toString('base64'), 'user:request'))
  const changed = Buffer.from(first, 'base64'); changed[28] ^= 1
  assert.throws(() => openCredential(changed.toString('base64'), key, 'user:request'))
})
