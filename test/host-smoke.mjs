import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { statusOf, backoffMs, normalizePrefs } = __internals

test('statusOf：优先读 failure.status', () => {
  assert.equal(statusOf({ status: 429, message: 'x' }, undefined), 429)
})

test('statusOf：从 "400: {...}" 前缀解析', () => {
  assert.equal(statusOf(undefined, new Error('400: {"code":"invalid_parameter_error"}')), 400)
})

test('statusOf：从 JSON 字段解析', () => {
  assert.equal(statusOf(undefined, new Error('upstream said {"statusCode": 503}')), 503)
})

test('statusOf：无法识别时返回 null', () => {
  assert.equal(statusOf(undefined, new Error('socket hang up')), null)
})

test('backoffMs：429 起步 2s、封顶 15s', () => {
  assert.equal(backoffMs({ status: 429, retryAfterMs: null }, 0), 2000)
  assert.equal(backoffMs({ status: 429, retryAfterMs: null }, 10), 15000)
})

test('backoffMs：优先使用 Retry-After', () => {
  assert.equal(backoffMs({ status: 429, retryAfterMs: 7000 }, 3), 7000)
})

test('normalizePrefs：缺省值与上限', () => {
  const prefs = normalizePrefs({ maxRetries: 99, statuses: { '503': false } })
  assert.equal(prefs.maxRetries, 10)
  assert.equal(prefs.statuses['503'], false)
  assert.equal(prefs.statuses['429'], true)
  assert.equal(prefs.logErrors, true)
})

test('重试：首个 chunk 就是 429 错误时，重试并只交付成功流', async () => {
  const { withRetryAndLogging } = __internals
  const chunks = []
  const fakeCtx = { logger: { warn() {} } }
  const text = { type: 'text-delta', delta: 'hi' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const failure = { status: 429, code: 'RATE_LIMIT', message: '429: rate limited', providerRetryAfterMs: 1 }
  let call = 0
  const next = async () => {
    call += 1
    return (async function* () {
      if (call === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      yield text
      yield stop
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm', signal: undefined }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 2)
  assert.deepEqual(chunks, [text, stop])
})

test('重试：已经输出过内容就不再重试，错误 chunk 原样透传', async () => {
  const { withRetryAndLogging } = __internals
  const chunks = []
  const fakeCtx = { logger: { warn() {} } }
  const failure = { status: 429, code: 'RATE_LIMIT', message: '429: rate limited', providerRetryAfterMs: 1 }
  let call = 0
  const next = async () => {
    call += 1
    return (async function* () {
      yield { type: 'text-delta', delta: 'partial' }
      yield { type: 'finish', reason: { kind: 'error', failure } }
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm' }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 1)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[1].reason.kind, 'error')
})
