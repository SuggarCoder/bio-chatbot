import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyIngressFailure, openCredential, sealCredential } from './ingress.js'
import { TokenQuotaError } from './tokenQuota.js'

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

test('an exhausted token quota fails the request with its own code instead of retrying', () => {
  const quota = classifyIngressFailure(new TokenQuotaError('本周 Token 额度已用完，可使用 Reset 卷重置。', 429, 'weekly_quota_exceeded'), 0)
  assert.equal(quota.transient, false)
  assert.deepEqual(quota.detail, { code: 'weekly_quota_exceeded', message: '本周 Token 额度已用完，可使用 Reset 卷重置。' })

  const busy = classifyIngressFailure(Object.assign(new Error('Too many'), { statusCode: 429 }), 0)
  assert.equal(busy.transient, true, 'other 429s are still retried')
  assert.equal(busy.detail.code, 'request_failed')
  assert.equal(classifyIngressFailure(new Error('boom'), 8).transient, false, 'attempts are bounded')
})
