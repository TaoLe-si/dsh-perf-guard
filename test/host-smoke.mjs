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
