import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/*
 * 每个测试文件用独立的 DSH_HOME，避免读到开发者本机真实的 ~/.dsh/perf-guard.retry.json。
 * 默认给「关掉思维链处理 + 不限重试」，让重试相关用例保持 1.2.x 时的口径；
 * 思维链用例各自 setPrefs 切换模式。
 */
const PREFS_DIR = await mkdtemp(join(tmpdir(), 'dsh-pg-test-'))
process.env.DSH_HOME = PREFS_DIR

async function setPrefs(patch) {
  await writeFile(join(PREFS_DIR, 'perf-guard.retry.json'), JSON.stringify(patch), 'utf8')
  __internals.resetPrefsCache()
}

await setPrefs({ thinkingMode: 'off', maxRetries: -1, retryTransport: true })

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

test('shouldRetry：429 已输出后不重试；未输出时仍可重试', () => {
  const base = normalizePrefs({})
  const prefs = { ...base, statuses: { ...base.statuses, '429': true } }
  const info = { status: 429, kind: 'http' }
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 1, aborted: false }), false)
  assert.equal(shouldRetry({ prefs, info, emitted: false, attemptNumber: 1, aborted: false }), true)
})

/*
 * 永久性错误（400/401/402/403/404/405/422）**无论配置怎么写都不重试**。
 *
 * 这是内存溢出崩溃的直接成因：用户把 400/401/403 打开并配上「不限次数」后，
 * 一个必然失败的错误会无限重试，而每次重试都要重建完整请求与流，
 * 宿主侧会话状态只增不减，堆内存单调上涨直到崩溃。
 */
test('shouldRetry：永久性错误即使配置打开也不重试', () => {
  const base = normalizePrefs({})
  for (const status of [400, 401, 402, 403, 404, 405, 422]) {
    // 直接构造「用户把开关打开」的偏好，绕过 normalizePrefs 的强制关闭
    const prefs = { ...base, statuses: { ...base.statuses, [String(status)]: true }, maxRetries: -1 }
    const info = { status, kind: 'http' }
    assert.equal(shouldRetry({ prefs, info, emitted: false, attemptNumber: 1, aborted: false }), false, String(status))
    assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 1, aborted: false }), false, String(status))
  }
})

test('normalizePrefs：永久性错误的状态开关被强制关闭（旧配置自动纠正）', () => {
  const prefs = normalizePrefs({ statuses: { '400': true, '401': true, '402': true, '403': true, '429': true } })
  for (const status of ['400', '401', '402', '403']) {
    assert.equal(prefs.statuses[status], false, status)
  }
  assert.equal(prefs.statuses['429'], true)
})

test('shouldRetry：maxRetries 上限与「不限」', () => {
  const prefs = { ...normalizePrefs({}), maxRetries: 2 }
  const info = { status: 502, kind: 'http' }
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 2, aborted: false }), true)
  assert.equal(shouldRetry({ prefs, info, emitted: true, attemptNumber: 3, aborted: false }), false)
  // 「不限次数」（maxRetries = -1）不再是真的无限：仍受安全上限封顶，
  // 否则持续故障会一路重试到堆内存耗尽。
  const unlimited = { ...prefs, maxRetries: -1 }
  assert.equal(shouldRetry({ prefs: unlimited, info, emitted: true, attemptNumber: 1, aborted: false }), true)
  assert.equal(
    shouldRetry({ prefs: unlimited, info, emitted: true, attemptNumber: __internals.SAFETY_MAX_ATTEMPTS, aborted: false }),
    true,
  )
  assert.equal(
    shouldRetry({ prefs: unlimited, info, emitted: true, attemptNumber: __internals.SAFETY_MAX_ATTEMPTS + 1, aborted: false }),
    false,
  )
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

/* ------------------------------------------------------------------ */
/*  单次 next 契约（DSH 0.2.2-rc.1 / cordis waterfall）                  */
/* ------------------------------------------------------------------ */

/**
 * 按 cordis `events.waterfall` 的真实语义搭链：每次调用都从最外层重跑，
 * `next` 一次性（二次调用抛 next() called multiple times），
 * 且只把**最外层 listener** 的返回值交给调用方。
 */
function waterfallChain(listeners, inner) {
  const stats = { next: 0, runs: 0 }
  function start(...args) {
    stats.runs += 1
    const queue = [...listeners]
    const dispatch = () => {
      const callback = queue.shift()
      if (callback === undefined) return inner()
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        stats.next += 1
        return dispatch()
      }
      return callback(...args, next)
    }
    return dispatch()
  }
  return { run: (...args) => start(...args), stats }
}

test('流级重试：waterfall 的 next 只能调用一次，重试改走 llm.stream 再入', async () => {
  const { withRetryAndLogging } = __internals
  const text = { type: 'text-delta', text: 'hi' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  let adapterCalls = 0
  const adapter = () => (async function* () {
    adapterCalls += 1
    // 前两次是传输层失败（真实日志里的 "Connection error."），第三次成功。
    if (adapterCalls <= 2) throw new Error('Connection error.')
    yield text
    yield stop
  })()

  let chain
  const fakeCtx = {
    logger: { warn() {} },
    // 与真实 llm 服务一致：再入时也从最外层把 waterfall 重跑一遍。
    llm: { stream: (options) => chain.run(options) },
  }
  chain = waterfallChain([(options, next) => withRetryAndLogging(fakeCtx, options, next)], adapter)

  const chunks = []
  for await (const chunk of chain.run({ provider: 'p', model: 'm' })) chunks.push(chunk)

  assert.equal(adapterCalls, 3, '应当重试两次后成功')
  assert.deepEqual(chunks, [text, stop])
  // 关键不变量：每次 waterfall 调用里 next 恰好被调用一次（二次调用会抛错）。
  assert.equal(chain.stats.runs, 3, '三次 waterfall（首调 + 两次再入）')
  assert.equal(chain.stats.next, 3, '每次 waterfall 只调用一次 next')
})

test('流级重试：拿不到 llm 服务时，暴露的是原始失败而不是 next() called multiple times', async () => {
  const { withRetryAndLogging } = __internals
  const fakeCtx = { logger: { warn() {} } } // 故意不给 llm 服务
  let adapterCalls = 0
  const adapter = () => (async function* () {
    adapterCalls += 1
    throw new Error('Connection error.')
  })()
  const chain = waterfallChain([(options, next) => withRetryAndLogging(fakeCtx, options, next)], adapter)

  await assert.rejects(
    async () => { for await (const _chunk of chain.run({ provider: 'p', model: 'm' })) { /* 不应产出 */ } },
    (error) => {
      assert.equal(error.message, 'Connection error.', '必须是原始传输失败')
      assert.doesNotMatch(error.message, /next\(\) called multiple times/, '不能把内核内部错误泄给上层')
      return true
    },
  )
  assert.equal(adapterCalls, 1, '这条路径下本层无法重试，只跑一次')
})

test('流级重试：自己再入的那一层只透传，不再包装/重试', async () => {
  const { withRetryAndLogging } = __internals
  const LAYERED_RETRY = Symbol.for('dsh-perf-guard.layered-retry')
  const failure = { type: 'finish', reason: { kind: 'error', failure: { status: 502, message: '502 bad gateway' } } }
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return (async function* () { yield failure })()
  }
  const chunks = []
  for await (const chunk of withRetryAndLogging({ logger: { warn() {} } }, { provider: 'p', model: 'm', [LAYERED_RETRY]: true }, next)) {
    chunks.push(chunk)
  }
  assert.equal(nextCalls, 1, '内层只调用一次 next')
  assert.deepEqual(chunks, [failure], '错误 chunk 原样透传，不在内层重试')
})
test('归一化码：pi-ai 的 STREAM_CLOSED 归入传输类（原生默认不重试，靠本插件补）', () => {
  const { isTransportFailure, statusOf } = __internals
  assert.equal(isTransportFailure({ code: 'STREAM_CLOSED', message: 'stream closed before finish' }), true)
  assert.equal(isTransportFailure({ code: 'EMPTY_RESPONSE', message: 'empty response' }), true)
  assert.equal(statusOf({ code: 'RATE_LIMIT' }), 429)
  assert.equal(statusOf({ code: 'SERVER' }), 502)
})
test('并发上限：实测形态（PI_AI_ERROR + 无状态码 + Concurrency limit）判为可重试', () => {
  const { isTransportFailure } = __internals
  // 宿主日志实测：code=PI_AI_ERROR、无 status、kind=unknown。
  assert.equal(
    isTransportFailure({ code: 'PI_AI_ERROR', message: 'Concurrency limit exceeded for user, please retry later' }),
    true,
  )
  assert.equal(isTransportFailure(undefined, new Error('Concurrency limit exceeded for user, please retry later')), true)
  // 中英文变体
  assert.equal(isTransportFailure(undefined, new Error('并发上限已达到，请稍后重试')), true)
  assert.equal(isTransportFailure(undefined, new Error('max concurrent requests exceeded')), true)
  // 反例：欠费 / 参数错误 / 用户取消仍不重试
  assert.equal(isTransportFailure(undefined, new Error('余额不足，请稍后重试')), false)
  assert.equal(isTransportFailure(undefined, new Error('invalid_parameter_error: bad role')), false)
  assert.equal(isTransportFailure({ code: 'ABORTED', message: 'Concurrency limit exceeded' }), false)
})

test('并发上限：agent 层决策——原生不认 PI_AI_ERROR，由本插件兜底重试（且用策略退避）', async () => {
  const { decideRequestError, normalizePrefs } = __internals
  const failure = { code: 'PI_AI_ERROR', message: 'Concurrency limit exceeded for user, please retry later' }
  const policy = {
    mode: 'normal',
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    backoff: { initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 },
  }
  // 新契约：PI_AI_ERROR 不在原生 retryableCodes 里 ⇒ 不该让位，要自己重试
  const delays = []
  const attempts = new Map()
  const decision = await decideRequestError(
    { logger: { warn() {} } },
    { provider: 'anliang', turn: 1, step: 2, failure, retryPolicy: policy },
    async () => undefined,
    { prefs: normalizePrefs({ maxRetries: 2 }), attempts, sleep: async (ms) => { delays.push(ms) } },
  )
  assert.deepEqual(decision, { kind: 'retry' })
  assert.deepEqual(delays, [500], '退避取 provider 策略的 initialDelayMs')
  assert.equal(attempts.get('anliang:1:2'), 1)

  // 老契约（载荷无 retryPolicy 键）：走插件默认退避——并发上限属拥塞类，2s 起步
  const oldDelays = []
  const oldDecision = await decideRequestError(
    { logger: { warn() {} } },
    { provider: 'anliang', turn: 1, step: 2, failure },
    async () => undefined,
    { prefs: normalizePrefs({ maxRetries: 2 }), attempts: new Map(), sleep: async (ms) => { oldDelays.push(ms) } },
  )
  assert.deepEqual(oldDecision, { kind: 'retry' })
  assert.deepEqual(oldDelays, [2000], '拥塞类起步 2s，给占用并发额度的请求让路')
})

test('并发上限：流级重试真的会重新发起一次调用并交付完整流', async () => {
  const { withRetryAndLogging } = __internals
  const text = { type: 'text-delta', text: 'ok' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const failure = { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Concurrency limit exceeded for user, please retry later' } } }
  let call = 0
  const next = async () => {
    call += 1
    return (async function* () {
      if (call === 1) { yield failure; return }
      yield text
      yield stop
    })()
  }
  const chunks = []
  for await (const chunk of withRetryAndLogging({ logger: { warn() {} } }, { provider: 'p', model: 'm' }, next)) {
    chunks.push(chunk)
  }
  assert.equal(call, 2, '应当重试一次')
  assert.deepEqual(chunks, [text, stop], '只交付成功流，错误 chunk 被吞掉')
})
test('backoffMs：拥塞类（并发上限/账号池繁忙）起步 2s，与 429 同档', () => {
  const { backoffMs } = __internals
  assert.equal(backoffMs({ status: null, retryAfterMs: null, busy: true }, 0), 2000)
  assert.equal(backoffMs({ status: null, retryAfterMs: null, busy: true }, 1), 4000)
  assert.equal(backoffMs({ status: null, retryAfterMs: null, busy: true }, 20), 15000, '仍受 15s 封顶')
  assert.equal(backoffMs({ status: null, retryAfterMs: null, busy: false }, 0), 800, '普通传输类保持 0.8s')
  assert.equal(backoffMs({ status: 429, retryAfterMs: null, busy: false }, 0), 2000, '429 不变')
})
/* ------------------------------------------------------------------ */
/*  正文思维链：keep / strip / off 三态                                  */
/* ------------------------------------------------------------------ */

/**
 * 迷你 assembler：复刻 BlockAssembler 的关键语义，用来断言**最终消息**的块序列。
 * - 块顺序 = index 首次出现顺序；
 * - block-end 会整块覆盖已累积的 deltas（`if (partial.block) return partial.block`）。
 */
function assembleBlocks(chunks) {
  const parts = new Map()
  const order = []
  const ensure = (index, blockType) => {
    if (!parts.has(index)) {
      order.push(index)
      parts.set(index, { blockType, text: '', block: null })
    }
    return parts.get(index)
  }
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') ensure(chunk.index, chunk.blockType)
    else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const part = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
      if (part.block === null) part.text += chunk.text
    } else if (chunk.type === 'block-end') {
      const part = ensure(chunk.index, chunk.block.type)
      if (part.block === null) part.block = chunk.block
    }
  }
  return order.map((index) => {
    const part = parts.get(index)
    return part.block ?? { type: part.blockType, text: part.text }
  })
}

const RAW_WITH_THINKING = '<thinking>思考一下</thinking>最终答复'

/** 一次完整的模型调用：block-start → deltas → block-end → finish。 */
function streamOf(deltas, blockText) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map((text) => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: blockText } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function runStream(chunks) {
  const { withRetryAndLogging } = __internals
  const next = async () => (async function* () { for (const chunk of chunks) yield chunk })()
  const out = []
  for await (const chunk of withRetryAndLogging({ logger: { warn() {} } }, { provider: 'p', model: 'm' }, next)) out.push(chunk)
  return out
}

test('思维链 keep：改写成 reasoning 块，内容保留且顺序正确', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const out = await runStream(streamOf(['<thinking>思考', '一下</thinking>最终答复'], RAW_WITH_THINKING))
  assert.deepEqual(assembleBlocks(out), [
    { type: 'reasoning', text: '思考一下' },
    { type: 'text', text: '最终答复' },
  ])
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').length > 0, true, '思维链走 reasoning 通道')
})

test('思维链 keep：正文在前的场景，块顺序仍然是 正文 → 思考', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const raw = '先说话<thinking>再想</thinking>'
  const out = await runStream(streamOf(['先说话<thinking>再想', '</thinking>'], raw))
  assert.deepEqual(assembleBlocks(out), [
    { type: 'text', text: '先说话' },
    { type: 'reasoning', text: '再想' },
  ])
})

test('思维链 keep：没有标签时字节级透传（块结构与 replayState 不受影响）', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const chunks = streamOf(['普通正文'], '普通正文')
  const out = await runStream(chunks)
  assert.deepEqual(out, chunks, '未命中标签必须一个 chunk 都不改')
})

test('思维链 keep：跨 chunk 被切断的标签也能识别', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const raw = '<thinking>藏起来</thinking>可见'
  const out = await runStream(streamOf(['<thi', 'nking>藏起', '来</think', 'ing>可见'], raw))
  assert.deepEqual(assembleBlocks(out), [
    { type: 'reasoning', text: '藏起来' },
    { type: 'text', text: '可见' },
  ])
})

test('思维链 keep：未闭合的 <thinking> 也按 reasoning 保留，不打印成正文', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const raw = '答案<thinking>没闭合的推理'
  const out = await runStream(streamOf(['答案<thinking>没闭合的推理'], raw))
  const blocks = assembleBlocks(out)
  assert.deepEqual(blocks, [
    { type: 'text', text: '答案' },
    { type: 'reasoning', text: '没闭合的推理' },
  ])
  assert.equal(blocks.some((b) => b.type === 'text' && b.text.includes('没闭合')), false, '推理不能混进正文块')
})

test('思维链 strip：整段摘除，正文块里不留痕迹', async () => {
  await setPrefs({ thinkingMode: 'strip' })
  const out = await runStream(streamOf(['<thinking>思考', '一下</thinking>最终答复'], RAW_WITH_THINKING))
  const blocks = assembleBlocks(out)
  assert.deepEqual(blocks, [{ type: 'text', text: '最终答复' }])
  assert.equal(out.some((c) => c.type === 'reasoning-delta'), false)
})

test('思维链 off：原样打印，不做任何改写', async () => {
  await setPrefs({ thinkingMode: 'off' })
  const chunks = streamOf(['<thinking>思考一下</thinking>最终答复'], RAW_WITH_THINKING)
  const out = await runStream(chunks)
  assert.deepEqual(out, chunks)
  assert.deepEqual(assembleBlocks(out), [{ type: 'text', text: RAW_WITH_THINKING }])
})

test('思维链：strip 的纯函数仍可用于整段清洗', () => {
  const { stripThinkingText } = __internals
  assert.equal(stripThinkingText('<thinking>abc</thinking>answer'), 'answer')
  assert.equal(stripThinkingText('前<THOUGHT>x</THOUGHT>后'), '前后')
  // 不误伤正文里的尖括号
  for (const text of ['a < b and c > d', 'if (a < b) { c }', 'no tag at all', 'x < y > z']) {
    assert.equal(stripThinkingText(text), text, text)
  }
})

test('思维链：拆分器按到达顺序产出 text / reasoning 片段', () => {
  const { createThinkingSplitter } = __internals
  const splitter = createThinkingSplitter()
  assert.deepEqual(splitter.push('<thinking>想'), [{ type: 'reasoning', text: '想' }])
  // 闭标签之后的正文不含可能的半个标签，立即放行
  assert.deepEqual(splitter.push('完了</thinking>正文'), [
    { type: 'reasoning', text: '完了' },
    { type: 'text', text: '正文' },
  ])
  assert.deepEqual(splitter.flush(), [])
  // 末尾一个孤立的 '<' 会被扣住，等下一个 chunk 或 flush 再判
  const tail = createThinkingSplitter()
  assert.deepEqual(tail.push('正文 <'), [{ type: 'text', text: '正文 ' }])
  assert.deepEqual(tail.flush(), [{ type: 'text', text: '<' }])
})
test('思维链 keep：真实流形态（reasoning 块 + text 块 + tool-call）无标签时零改动', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  // 贴近 pi-ai 的真实形态：先 reasoning 块，再 text 块，再 tool-call 块
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '内部推理' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '内部推理' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '正文内容' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '正文内容' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await runStream(chunks)
  assert.deepEqual(out, chunks, '无标签必须一个 chunk 都不改（否则 replayState 会被降级）')
})

test('思维链 keep：空的 text 块也不会丢 block-start', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await runStream(chunks)
  assert.deepEqual(out, chunks, '空块也必须原样透传')
})
test('思维链 keep：改写过块结构后必须摘掉 replayState（否则 pi-ai 判 replay 对不上）', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>纯思维链</thinking>' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>纯思维链</thinking>' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai' }, blocks: [{ type: 'text' }] } },
  ]
  const out = await runStream(chunks)
  const finish = out.find((c) => c.type === 'finish')
  assert.ok(finish, 'finish 必须存在')
  assert.equal(finish.replayState, undefined, '改写后 replayState 必须摘掉')
  assert.deepEqual(assembleBlocks(out), [{ type: 'reasoning', text: '纯思维链' }], '内容保留为 reasoning 块')
})

test('思维链 keep：没有改写时 replayState 原样保留（不能误伤）', async () => {
  await setPrefs({ thinkingMode: 'keep' })
  const replayState = { response: { kind: 'pi-ai' }, blocks: [{ type: 'text' }] }
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '普通正文' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '普通正文' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState },
  ]
  const out = await runStream(chunks)
  assert.deepEqual(out.find((c) => c.type === 'finish').replayState, replayState, '未改写时 replayState 不受影响')
  assert.deepEqual(out, chunks, '整条流都不应改动')
})
test('下发 chunk 必须无损 JSON：任何模式下都不能引入 undefined 值或 symbol 键', async () => {
  // 宿主在 AssistantStreamAccumulator 里对每个 chunk 做 snapshotJsonValue，
  // 只要往返不一致就抛 "Assistant stream chunk must be losslessly JSON-serializable"。
  const lossless = (value) => JSON.stringify(value) === JSON.stringify(JSON.parse(JSON.stringify(value)))
  const streams = [
    ['keep + 有 replayState + 纯思维链', 'keep', [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>想想</thinking>' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>想想</thinking>' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai' }, blocks: [{ type: 'text' }] } },
    ]],
    ['keep + 带标签的分段', 'keep', [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>想</thinking>答' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>想</thinking>答' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]],
    ['strip + 带标签', 'strip', [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>想</thinking>答' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>想</thinking>答' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]],
  ]
  for (const [label, mode, chunks] of streams) {
    await setPrefs({ thinkingMode: mode })
    const out = await runStream(chunks)
    for (const chunk of out) {
      assert.equal(lossless(chunk), true, `${label}：chunk 不是无损 JSON -> ${JSON.stringify(chunk)}`)
      assert.equal(JSON.stringify(chunk).includes('undefined'), false, `${label}：出现了 undefined`)
      // symbol 键在 JSON 里会消失，直接检查自有键数量是否与序列化后一致
      assert.equal(Object.keys(chunk).length, Object.keys(JSON.parse(JSON.stringify(chunk))).length,
        `${label}：存在序列化后会消失的键 -> ${JSON.stringify(chunk)}`)
    }
  }
})
