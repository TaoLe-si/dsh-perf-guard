import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const {
  statusOf,
  backoffMs,
  normalizePrefs,
  withRetryAndLogging,
  isTransportFailure,
  shouldRetry,
  retryAfterFromMessage,
} = __internals

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
  assert.equal(prefs.maxRetries, 50)
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
test('normalizePrefs：-1 表示不设上限', () => {
  assert.equal(normalizePrefs({ maxRetries: -1 }).maxRetries, -1)
})
test('isTransportFailure：识别传输/截断，排除用户取消', () => {
  assert.equal(isTransportFailure({ code: 'TRANSPORT', message: 'Connection error.' }), true)
  assert.equal(isTransportFailure(undefined, new Error('terminated')), true)
  assert.equal(isTransportFailure({ code: 'ABORTED', message: 'aborted' }), false)
  assert.equal(isTransportFailure({ code: 'AUTH', message: '401 unauthorized' }), false)
  assert.equal(isTransportFailure({ code: 'TIMEOUT', message: 'Request timed out.' }), true)
  assert.equal(isTransportFailure(undefined, new Error('Request timed out.')), true)
  assert.equal(isTransportFailure(undefined, new Error('connect ETIMEDOUT 1.2.3.4:443')), true)
  assert.equal(isTransportFailure({ code: 'LLM_ERROR', message: '本轮运行失败上游输出中断，请重试' }), true)
  assert.equal(isTransportFailure(undefined, new Error('上游输出中断，请重试')), true)
  assert.equal(isTransportFailure({ code: 'INVALID_CONFIG', message: 'missing stateDir' }), false)
  assert.equal(isTransportFailure(undefined, new Error('账号池繁忙，请稍后重试')), true)
  assert.equal(isTransportFailure({ code: 'LLM_ERROR', message: '账号池繁忙，请稍后重试' }), true)
  assert.equal(isTransportFailure(undefined, new Error('余额不足，请稍后重试')), false)
})

test('isTransportFailure：上游「没有产出，请稍后重试」也归入可重试', () => {
  // 中转让上游空转 95 秒后自己掐断时回的就是这条；它没有状态码也不含 TRANSPORT 关键词。
  assert.equal(isTransportFailure({ code: 'PI_AI_ERROR', message: '上游 95 秒内没有产出，请稍后重试' }), true)
  assert.equal(isTransportFailure(undefined, new Error('上游 95 秒内没有产出，请稍后重试')), true)
  assert.equal(isTransportFailure({ code: 'PI_AI_ERROR', message: 'no output produced upstream' }), true)
  assert.equal(isTransportFailure(undefined, new Error('empty completion')), true)
  // 单独的 "please retry later" 是弱信号，没有上游/超时语境时不算空转（见下方收窄用例）。
  // 用户取消优先于任何文案。
  assert.equal(isTransportFailure({ code: 'ABORTED', message: '上游 95 秒内没有产出，请稍后重试' }), false)
  // 普通鉴权/参数类错误不能被误判成空转。
  assert.equal(isTransportFailure({ code: 'AUTH', message: '401 unauthorized' }), false)
  assert.equal(isTransportFailure(undefined, new Error('invalid_parameter_error: developer role unsupported')), false)
  // 弱信号「稍后重试」必须带上游/超时语境：欠费不该无限重试。
  assert.equal(isTransportFailure(undefined, new Error('余额不足，请稍后重试')), false)
  assert.equal(isTransportFailure(undefined, new Error('上游繁忙，请稍后重试')), true)
  assert.equal(isTransportFailure(undefined, new Error('gateway timeout, please retry later')), true)
})

test('shouldRetry：网关 5xx 在已输出内容后，整段重试开关开着就重试', () => {
  const base = normalizePrefs({})
  // 默认只监听 429/502/503；500/504 需要显式打开才谈得上重试。
  const prefs = { ...base, statuses: { ...base.statuses, '500': true, '504': true } }
  for (const status of [500, 502, 503, 504]) {
    const info = { status, kind: 'http' }
    assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 1, aborted: false }), true, String(status))
    // 关掉「截断 / 传输中断重试」就不再丢弃已输出内容。
    const noDiscard = { ...prefs, retryTransport: false }
    assert.equal(
      shouldRetry({ prefs: noDiscard, info, emitted: true, attemptNumber: 1, aborted: false }),
      false,
      String(status),
    )
    // 尚未输出时不受该开关限制。
    assert.equal(shouldRetry({ prefs: noDiscard, info, emitted: false, attemptNumber: 1, aborted: false }), true)
  }
  // 用户取消优先。
  assert.equal(
    shouldRetry({ prefs, info: { status: 502, kind: 'http' }, emitted: true, attemptNumber: 1, aborted: true }),
    false,
  )
})

test('shouldRetry：429 / 4xx 已输出后仍不重试（不改变既有语义）', () => {
  const base = normalizePrefs({})
  for (const status of [429, 400, 401, 403]) {
    const prefs = { ...base, statuses: { ...base.statuses, [String(status)]: true } }
    const info = { status, kind: 'http' }
    assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 1, aborted: false }), false, String(status))
    assert.equal(shouldRetry({ prefs, info, emitted: false, attemptNumber: 1, aborted: false }), true, String(status))
  }
})

test('shouldRetry：maxRetries 上限与「不限」', () => {
  const prefs = { ...normalizePrefs({}), maxRetries: 2 }
  const info = { status: 502, kind: 'http' }
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 2, aborted: false }), true)
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 3, aborted: false }), false)
  const unlimited = { ...prefs, maxRetries: -1 }
  assert.equal(shouldRetry({ prefs: unlimited, info, emitted: true, attemptNumber: 99, aborted: false }), true)
})

test('shouldRetry：传输类不受是否已输出限制', () => {
  const prefs = normalizePrefs({})
  const info = { status: null, kind: 'transport' }
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 1, aborted: false }), true)
  assert.equal(
    shouldRetry({ prefs: { ...prefs, retryTransport: false }, info, emitted: true, attemptNumber: 1, aborted: false }),
    false,
  )
})

test('retryAfterFromMessage：读 Cloudflare 正文里的 retry_after', () => {
  const body = '502 {"error_name":"origin_bad_gateway","retryable":true,"retry_after":60}'
  assert.equal(retryAfterFromMessage(body), 60)
  assert.equal(retryAfterFromMessage('Retry-After: 5'), 5)
  assert.equal(retryAfterFromMessage('boom'), null)
  assert.equal(retryAfterFromMessage(''), null)
  assert.equal(retryAfterFromMessage(undefined), null)
})

test('backoffMs：服务端给的 60s 被现有封顶压到 30s', () => {
  assert.equal(backoffMs({ status: 502, retryAfterMs: 60000 }, 0), 30000)
})

test('502 在流到一半时返回：重试并交付完整流', async () => {
  const chunks = []
  const warnings = []
  const fakeCtx = { logger: { warn: (...args) => warnings.push(args) } }
  const text = { type: 'text-delta', delta: 'good' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  // 真实形态：Cloudflare 502 正文，带 retry_after。用 0 让用例跑得快。
  const failure = {
    status: 502,
    code: 'SERVER',
    message: '502 {"error_name":"origin_bad_gateway","retry_after":0}',
  }
  let call = 0
  const next = async () => {
    call += 1
    return (async function* () {
      if (call === 1) {
        yield { type: 'text-delta', delta: 'partial' }
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      yield text
      yield stop
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm' }, next)) chunks.push(chunk)
  assert.equal(call, 2)
  // 中间件是边收边转发的，已经交给调用方的 'partial' 收不回来；
  // 第二次尝试从干净状态重新产出。这与既有"传输中断整段重试"的行为一致。
  assert.deepEqual(chunks, [{ type: 'text-delta', delta: 'partial' }, text, stop])
  assert.ok(warnings.some((args) => String(args[0]).includes('perf-guard: retry') && args[1] === 1))
})

test('传输中断：即使已输出内容也整段重试', async () => {
  const chunks = []
  const fakeCtx = { logger: { warn() {} } }
  const text = { type: 'text-delta', delta: 'hi' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  let call = 0
  const next = async () => {
    call += 1
    if (call === 1) {
      return (async function* () {
        yield { type: 'text-delta', delta: 'partial' }
        throw Object.assign(new Error('Connection error.'), { code: 'TRANSPORT' })
      })()
    }
    return (async function* () {
      yield text
      yield stop
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm' }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 2)
  assert.deepEqual(chunks.filter((c) => c.type === 'finish'), [stop])
})

test('上游「没有产出，请稍后重试」：零内容落地，整段重试', async () => {
  const chunks = []
  const warnings = []
  const fakeCtx = { logger: { warn: (...args) => warnings.push(args) } }
  const text = { type: 'text-delta', delta: 'recovered' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  let call = 0
  const next = async () => {
    call += 1
    if (call === 1) {
      // 这一轮一个 chunk 都没吐出来就被中转掐断。
      return (async function* () {
        throw Object.assign(new Error('上游 95 秒内没有产出，请稍后重试'), { code: 'PI_AI_ERROR' })
      })()
    }
    return (async function* () {
      yield text
      yield stop
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm' }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 2)
  assert.deepEqual(chunks, [text, stop])
  // logger 用 %s 占位符：格式串在 args[0]，次数在 args[1]。
  assert.ok(warnings.some((args) => String(args[0]).includes('perf-guard: retry') && args[1] === 1))
})

test('静默截断（没有 finish chunk）也会重试', async () => {
  const chunks = []
  const fakeCtx = { logger: { warn() {} } }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  let call = 0
  const next = async () => {
    call += 1
    return (async function* () {
      yield { type: 'text-delta', delta: 'truncated' }
      if (call === 2) yield stop
    })()
  }
  for await (const chunk of withRetryAndLogging(fakeCtx, { provider: 'p', model: 'm' }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 2)
  assert.ok(chunks.some((c) => c.type === 'finish'))
})
