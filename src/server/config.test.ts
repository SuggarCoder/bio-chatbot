import assert from 'node:assert/strict'
import test from 'node:test'

import { readTrustedProxyCidrs } from './config.js'

test('trusted proxies are optional outside production', () => {
  assert.equal(readTrustedProxyCidrs({}, 'development'), false)
})

test('production requires an explicit trusted proxy range', () => {
  assert.throws(
    () => readTrustedProxyCidrs({}, 'production'),
    /TRUSTED_PROXY_CIDRS is required in production/,
  )
})

test('trusted proxy ranges are trimmed and preserved', () => {
  assert.equal(
    readTrustedProxyCidrs({
      TRUSTED_PROXY_CIDRS: ' 172.20.0.10,172.20.0.0/28 ',
    }, 'production'),
    '172.20.0.10,172.20.0.0/28',
  )
})

test('trusted proxy ranges must not trust every address family', () => {
  for (const value of [
    '0.0.0.0/0',
    '192.0.2.10/0',
    '::/0',
    '127.0.0.1, 0:0:0:0:0:0:0:0/0',
  ]) {
    assert.throws(
      () => readTrustedProxyCidrs({ TRUSTED_PROXY_CIDRS: value }, 'production'),
      /must not trust every address/,
    )
  }
})
