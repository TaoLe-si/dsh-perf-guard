import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, __internals } from '../index.js'

const {
  statusOf,
  normalizePrefs,
  isTransportFailure,
  hasNativeRetryContract,
  isNativeOwned,
  backoffMsFromPolicy,
  decideRequestError,
} = __internals

/* ------------------------------------------------------------------ */
/*  夹具（全部纯函数 / 可注入，不做任何真实等待）                        */
/* ------------------------------------------------------------------ */

/** 每次调用都给一份独立的 logger，避免用例之间共享状态。 */
function makeCtx(warnings = []) {
  return { logger: { warn: (...args) => warnings.push(args) } }
}

/**
 * decideRequestError 的注入点。
 * sleep 永远是假的：只把退避时长记进 delays，绝不真的等。
 */
function makeHooks(prefs, overrides = {}) {
  const delays = []
  const hooks = {
    prefs,
    attempts: new Map(),
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
    ...overrides,
  }
  return hooks
}

/** 老契约载荷：没有 retryPolicy 键。provider/turn/step 决定计数键 p:3:4。 */
function legacyPayload(failure, extra = {}) {
  return { provider: 'p', turn: 3, step: 4, failure, ...extra }
}

/** 新契约的 provider 策略：normal + 只接管 TRANSPORT，退避参数取固定值。 */
function nativePolicy(overrides = {}) {
  return {
    mode: 'normal',
    retryableCodes: ['TRANSPORT'],
    backoff: { initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 },
    ...overrides,
  }
}

/** fallback 打标记，便于断言「确实退回插件默认算法」。 */
const markFallback = () => (attempt) => 9000 + attempt

/* ------------------------------------------------------------------ */
/*  A. hasNativeRetryContract：按「键存在」探测新契约                    */
/* ------------------------------------------------------------------ */

test('hasNativeRetryContract：空对象 / undefined / null 都判为老契约', () => {
  assert.equal(hasNativeRetryContract({}), false, '空对象里没有 retryPolicy 键，应判为老契约')
  assert.equal(hasNativeRetryContract(undefined), false, 'undefined 载荷应判为老契约，不能抛错')
  assert.equal(hasNativeRetryContract(null), false, 'null 载荷应判为老契约，不能抛错')
})

test('hasNativeRetryContract：retryPolicy 键存在即新契约（哪怕值是 undefined）', () => {
  assert.equal(
    hasNativeRetryContract({ retryPolicy: undefined }),
    true,
    '新版默认策略的值可能就是 undefined，只要键存在就必须认成新契约',
  )
  assert.equal(hasNativeRetryContract({ retryPolicy: { mode: 'normal' } }), true, '显式 normal 策略应判为新契约')
  assert.equal(
    hasNativeRetryContract(Object.create({ retryPolicy: { mode: 'normal' } })),
    false,
    '只有自有属性才算载荷字段，原型链上的 retryPolicy 不应算数',
  )
})

/* ------------------------------------------------------------------ */
/*  B. isNativeOwned：原生重试是否接管该 code                           */
/* ------------------------------------------------------------------ */

test('isNativeOwned：mode=always 时任意 code 都交给原生', () => {
  for (const code of ['TRANSPORT', 'WEIRD_CODE', 'RATE_LIMIT', '']) {
    assert.equal(isNativeOwned({ mode: 'always' }, code), true, `mode=always 应全接管（code=${JSON.stringify(code)}）`)
  }
})

test('isNativeOwned：mode=normal 只接管 retryableCodes 里列出的 code', () => {
  const policy = nativePolicy()
  assert.equal(isNativeOwned(policy, 'TRANSPORT'), true, 'TRANSPORT 在 retryableCodes 里，应交给原生')
  assert.equal(isNativeOwned(policy, 'WEIRD_CODE'), false, 'WEIRD_CODE 不在 retryableCodes 里，本插件不能让它接管')
  assert.equal(isNativeOwned(policy, ''), false, '空 code 不匹配任何策略')
  assert.equal(isNativeOwned({ mode: 'normal' }, 'TRANSPORT'), false, 'normal 但没有 retryableCodes 时不接管任何 code')
})

test('isNativeOwned：策略缺失或非法时一律不接管', () => {
  assert.equal(isNativeOwned(undefined, 'TRANSPORT'), false, '老契约没有 policy，不能让位给不存在的原生')
  assert.equal(isNativeOwned(null, 'TRANSPORT'), false, 'policy 为 null 时不接管')
  assert.equal(isNativeOwned({ mode: 'weird' }, 'TRANSPORT'), false, '未知 mode 时不接管')
  assert.equal(isNativeOwned('normal', 'TRANSPORT'), false, 'policy 不是对象时不接管')
})

/* ------------------------------------------------------------------ */
/*  C. backoffMsFromPolicy：按 provider 策略算退避                      */
/*                                                                     */
/*  注：矩阵里写「jitterRatio:1 → [0.5*exp, 1.5*exp]」，与实现不符。      */
/*  实现是 factor = 1 - jitter + 2*jitter*rand（满幅抖动）：             */
/*    jitterRatio=0   → [1*exp,   1*exp]  （期望值本身）                 */
/*    jitterRatio=0.5 → [0.5*exp, 1.5*exp]（矩阵想表达的正是这一档）       */
/*    jitterRatio=1   → [0,       2*exp]                                */
/*  按真实行为断言，并另加一条 0.5 档覆盖矩阵原意；index.js 未改动。        */
/* ------------------------------------------------------------------ */

test('backoffMsFromPolicy：用策略退避，指数增长并被 maxDelayMs 封顶', () => {
  const policy = { backoff: { initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 } }
  const fallback = markFallback()
  assert.equal(backoffMsFromPolicy(policy, 0, fallback), 500, 'attempt 0 应等于 initialDelayMs')
  assert.equal(backoffMsFromPolicy(policy, 1, fallback), 1000, 'attempt 1 是指数增长后的值')
  assert.equal(backoffMsFromPolicy(policy, 10, fallback), 1000, 'attempt 10 必须被 maxDelayMs 封顶到 1000')
})

test('backoffMsFromPolicy：策略非法时退回插件默认算法', () => {
  const fallback = markFallback()
  assert.equal(backoffMsFromPolicy(undefined, 3, fallback), 9003, '没有策略时应调用 fallback(attempt)')
  assert.equal(backoffMsFromPolicy({}, 3, fallback), 9003, '策略里没有 backoff 时应调用 fallback(attempt)')
  assert.equal(
    backoffMsFromPolicy({ backoff: { maxDelayMs: 1000 } }, 3, fallback),
    9003,
    '缺 initialDelayMs 属于非法策略，应走 fallback',
  )
  assert.equal(
    backoffMsFromPolicy({ backoff: { initialDelayMs: 2000, maxDelayMs: 1000 } }, 3, fallback),
    9003,
    'initialDelayMs > maxDelayMs 属于非法策略，应走 fallback',
  )
  assert.equal(
    backoffMsFromPolicy({ backoff: { initialDelayMs: 0, maxDelayMs: 1000 } }, 3, fallback),
    9003,
    'initialDelayMs <= 0 属于非法策略，应走 fallback',
  )
  assert.equal(
    backoffMsFromPolicy({ backoff: { initialDelayMs: 'soon', maxDelayMs: 1000 } }, 3, fallback),
    9003,
    'initialDelayMs 不是数字属于非法策略，应走 fallback',
  )
})

test('backoffMsFromPolicy：带抖动时结果非负且不超过 maxDelayMs', () => {
  const policy = { backoff: { initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 1 } }
  const fallback = markFallback()
  let lowest = Infinity
  let highest = -Infinity
  for (let i = 0; i < 2000; i += 1) {
    const ms = backoffMsFromPolicy(policy, 0, fallback)
    assert.ok(Number.isFinite(ms), `退避时长必须是有限数，实测 ${ms}`)
    assert.ok(ms >= 0, `退避时长不能为负，实测 ${ms}`)
    assert.ok(ms <= 1000, `抖动后仍必须被 maxDelayMs 封顶（<=1000），实测 ${ms}`)
    lowest = Math.min(lowest, ms)
    highest = Math.max(highest, ms)
  }
  // jitterRatio=1 是满幅抖动：exp=500 时样本必然击穿 [0.5*exp, 1.5*exp] 这条带子。
  assert.ok(lowest < 250, `jitterRatio=1 的下界应低于 0.5*exp(=250)，实测最低 ${lowest}`)
  assert.ok(highest > 750, `jitterRatio=1 的上界应高于 1.5*exp(=750)，实测最高 ${highest}`)
})

test('backoffMsFromPolicy：jitterRatio=0.5 时落在 [0.5*exp, 1.5*exp]', () => {
  const policy = { backoff: { initialDelayMs: 600, maxDelayMs: 10000, jitterRatio: 0.5 } }
  const fallback = markFallback()
  for (let i = 0; i < 2000; i += 1) {
    const ms = backoffMsFromPolicy(policy, 0, fallback)
    assert.ok(ms >= 300 && ms <= 900, `jitterRatio=0.5 的抖动区间是 ±50%（[300,900]ms），实测 ${ms}`)
  }
})

/* ------------------------------------------------------------------ */
/*  D. statusOf / isTransportFailure：归一化 code                       */
/* ------------------------------------------------------------------ */

test('statusOf：归一化 code 映射到等价 HTTP 状态码', () => {
  assert.equal(statusOf({ code: 'RATE_LIMIT' }), 429, 'RATE_LIMIT 应复用用户已有的 429 开关')
  assert.equal(statusOf({ code: 'SERVER' }), 502, 'SERVER 应复用用户已有的 502 开关')
  assert.equal(statusOf({ code: 'TRANSPORT' }), null, 'TRANSPORT 没有等价状态码，应返回 null')
})

test('isTransportFailure：归一化 code 的传输 / 空响应判定', () => {
  for (const code of ['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.equal(isTransportFailure({ code }), true, `${code} 是归一化传输类 code，应视为可重试`)
  }
  assert.equal(isTransportFailure({ code: 'RATE_LIMIT' }), false, 'RATE_LIMIT 走状态码开关，不算传输失败')
  assert.equal(isTransportFailure({ code: 'ABORTED' }), false, '用户取消折叠成 ABORTED，永远不算传输失败')
  assert.equal(isTransportFailure({ code: 'ABORTED', message: '上游输出中断' }), false, '用户取消优先于文案')
})

/* ------------------------------------------------------------------ */
/*  E. decideRequestError：新旧契约的恢复决策（最关键的一组）             */
/* ------------------------------------------------------------------ */

test('decideRequestError：下游返回 retry 时必须原样透传（即使本插件开关全关）', async () => {
  const ctx = makeCtx()
  // 本插件这一侧的开关全关：老逻辑会直接返回 undefined，正好检验「不吞下游决定」。
  const hooks = makeHooks(normalizePrefs({ retryTransport: false, maxRetries: 0 }))
  let calls = 0
  const downstream = { kind: 'retry' }
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => {
      calls += 1
      return downstream
    },
    hooks,
  )
  assert.equal(calls, 1, '必须先把决定权交给下游：next() 应被调用且只调用一次')
  assert.deepEqual(decision, { kind: 'retry' }, '宿主只看最外层返回值，否决下游的 retry 就等于让原生重试失效')
  assert.equal(hooks.attempts.size, 0, '透传下游结论时不应消耗本插件的重试额度')
})

test('decideRequestError：老契约（载荷无 retryPolicy）+ 传输中断 → 本插件重试并记账', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => undefined,
    hooks,
  )
  assert.deepEqual(decision, { kind: 'retry' }, '旧版宿主没有下游，传输中断只能由本插件重试')
  assert.equal(hooks.attempts.size, 1, '一次重试决策应落一条计数')
  assert.equal(hooks.attempts.get('p:3:4'), 1, '计数键是 provider:turn:step，值为已重试次数')
  assert.equal(hooks.delays.length, 1, '应等待一次退避后才要求重试')
  assert.ok(hooks.delays[0] > 0, `默认退避应为正数，实测 ${hooks.delays[0]}`)
})

test('decideRequestError：老契约 + 401 鉴权失败 → 不重试', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  let calls = 0
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'AUTH', message: '401 unauthorized' }),
    async () => {
      calls += 1
      return undefined
    },
    hooks,
  )
  assert.notDeepEqual(decision, { kind: 'retry' }, '401 不该被当成传输中断重试')
  assert.equal(decision, undefined, '鉴权失败应返回 undefined，把失败原样抛给宿主')
  assert.ok(calls >= 1, 'next() 至少要被调用一次，下游不被征求意见就是不尊重契约')
  assert.equal(hooks.attempts.size, 0, '不重试就不该记账')
})

test('decideRequestError：新契约 + 原生接管该 code 且下游未表态 → 让位原生', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'Connection error.' }, { retryPolicy: nativePolicy() }),
    async () => undefined,
    hooks,
  )
  assert.equal(decision, undefined, '原生已接管 TRANSPORT，本插件再加码就是双重退避并绕开原生上限')
  assert.equal(hooks.attempts.size, 0, '让位时不应消耗本插件额度')
  assert.deepEqual(hooks.delays, [], '让位时不应等待退避')
})

test('decideRequestError：新契约但原生不接管该 code → 本插件兜底重试（退避取策略值）', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'WEIRD_CODE', message: '上游输出中断，请重试' }, { retryPolicy: nativePolicy() }),
    async () => undefined,
    hooks,
  )
  assert.deepEqual(decision, { kind: 'retry' }, '原生不管的 code（WEIRD_CODE 不在 retryableCodes）必须由本插件兜底')
  assert.equal(hooks.attempts.size, 1, '兜底重试应落一条计数')
  assert.deepEqual(hooks.delays, [500], '退避应取策略里的 initialDelayMs（jitterRatio=0 无抖动）')
})

test('decideRequestError：respectNativePolicy=false 时即便原生接管也继续重试', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2, respectNativePolicy: false }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'Connection error.' }, { retryPolicy: nativePolicy() }),
    async () => undefined,
    hooks,
  )
  assert.deepEqual(decision, { kind: 'retry' }, '关掉让位开关后，本插件应无视原生策略继续按自己的上限重试')
  assert.equal(hooks.attempts.size, 1, '继续重试应落一条计数')
})

test('decideRequestError：maxRetries=0 表示一次也不加码', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 0 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => undefined,
    hooks,
  )
  assert.equal(decision, undefined, 'maxRetries=0 时本插件不能额外重试')
  assert.deepEqual(hooks.delays, [], '不加码就不该等待退避')
})

test('decideRequestError：maxRetries=-1 仍受安全上限封顶（不再无限重试）', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: -1 }))
  // 已经远超安全上限：必须停下。旧行为在这里会继续重试（1.5.0 之前正是它把堆内存吃满）。
  hooks.attempts.set('p:3:4', __internals.SAFETY_MAX_ATTEMPTS + 10)
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => undefined,
    hooks,
  )
  assert.equal(decision, undefined, '超过安全上限后不再重试')

  // 预算内仍然重试，并正常计数。
  const fresh = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: -1 }))
  fresh.attempts.set('p:3:4', 0)
  const retried = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => undefined,
    fresh,
  )
  assert.deepEqual(retried, { kind: 'retry' })
  assert.equal(fresh.attempts.get('p:3:4'), 1)
})

test('decideRequestError：下游 next() 抛错不冒泡，仍按本插件策略重试', async () => {
  const warnings = []
  const ctx = makeCtx(warnings)
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }),
    async () => {
      throw new Error('downstream exploded')
    },
    hooks,
  )
  assert.deepEqual(decision, { kind: 'retry' }, '下游异常必须被吞掉，否则恢复决策会整条挂掉')
  assert.ok(warnings.length >= 1, '下游异常应记一条告警，不能静默')
  assert.match(String(warnings[0][0]), /downstream/, `告警应说明是下游恢复失败，实测 ${warnings[0][0]}`)
  assert.equal(hooks.attempts.size, 1, '继续兜底重试应落一条计数')
})

test('decideRequestError：signal 已中止时不要求重试', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const decision = await decideRequestError(
    ctx,
    legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }, { signal: { aborted: true } }),
    async () => undefined,
    hooks,
  )
  // 真实实现此时已经先记了一次账，返回 undefined 才是关键契约：
  // 取消后还回 retry，agent loop 里的 throwIfAborted 会把它变成用户可见的报错。
  assert.equal(decision, undefined, '用户已取消，不能再要求重试')
})

/* ------------------------------------------------------------------ */
/*  F. waterfall 组合仿真（cordis 语义：只返回最外层 listener 的返回值）  */
/* ------------------------------------------------------------------ */

/**
 * 极简 cordis waterfall 仿真。
 *
 * - 每一层 listener 收到 (`...args, next`)，next 是「继续往内层走」的一次性续体；
 * - next() 不接收参数：内层拿到的还是同一份 args；
 * - 只把**最外层** listener 的返回值交给宿主（cordis 里就是 `return dispatch()`）。
 */
function waterfall(chain, terminal) {
  const step = (i, args) => {
    if (i >= chain.length) return terminal(...args)
    let used = false
    const next = () => {
      assert.equal(used, false, `waterfall 语义：第 ${i} 层的 next() 只能调用一次`)
      used = true
      return step(i + 1, args)
    }
    return chain[i](...args, next)
  }
  return (...args) => step(0, args)
}

test('waterfall 组合：本插件在外层时，把内层（原生）的 retry 原样传出去', async () => {
  const ctx = makeCtx()
  // 本插件这侧开关全关：只有「透传下游」这一条路能得出 retry。
  const hooks = makeHooks(normalizePrefs({ retryTransport: false, maxRetries: 0 }))
  const pluginListener = (payload, next) => decideRequestError(ctx, payload, next, hooks)
  const fakeNativeListener = async () => ({ kind: 'retry' })
  // 注册顺序 = 链顺序：「外层」在前，「内层」在后。
  const dispatch = waterfall([pluginListener, fakeNativeListener], () => Promise.resolve(undefined))
  const decision = await dispatch(legacyPayload({ code: 'TRANSPORT', message: 'Connection error.' }))
  assert.deepEqual(decision, { kind: 'retry' }, '外层 listener 的返回值就是宿主拿到的动作：没透传 = 原生重试失效')
  assert.equal(hooks.attempts.size, 0, '透传时本插件不应消耗额度')
})

test('waterfall 组合：本插件在内层时，外层调用 next() 会拿到本插件的 retry', async () => {
  const ctx = makeCtx()
  const hooks = makeHooks(normalizePrefs({ retryTransport: true, maxRetries: 2 }))
  const pluginListener = (payload, next) => decideRequestError(ctx, payload, next, hooks)
  let innerDecision
  const outerListener = async (payload, next) => {
    innerDecision = await next()
    return innerDecision
  }
  const dispatch = waterfall([outerListener, pluginListener], () => Promise.resolve(undefined))
  const decision = await dispatch(legacyPayload({ code: 'TRANSPORT', message: 'upstream closed' }))
  assert.deepEqual(innerDecision, { kind: 'retry' }, '外层 next() 的返回值应是内层（本插件）的决定')
  assert.deepEqual(decision, { kind: 'retry' }, '外层原样透传后宿主才拿得到 retry')
  assert.equal(hooks.attempts.size, 1, '本插件确实做出了一次重试决策')
})

test('waterfall 组合：只有最外层返回值算数（外层返回 undefined 会盖掉内层的 retry）', async () => {
  const outerVeto = async () => undefined
  const innerRetry = async () => ({ kind: 'retry' })
  const dispatch = waterfall([outerVeto, innerRetry], () => Promise.resolve(undefined))
  const decision = await dispatch({ provider: 'p', turn: 0, step: 0 })
  assert.equal(decision, undefined, '这正是「不透传就丢重试」的机制：宿主只读最外层返回值')
})

const routeError = 'child LLM route "deepseek/gpt-6.2-sol" is not allowed for this Session; without a recorded model-selection policy, explicit selection is limited to the parent route'
const routeFailure = message => Object.freeze({
  error: Object.freeze({ message }),
  isError: true,
  content: Object.freeze([{ type: 'text', text: `Error: ${message}` }]),
})

test('subagent route denial gets recovery instructions without changing the error or args', async () => {
  const result = routeFailure(routeError)
  const args = Object.freeze({ provider: 'deepseek', model: 'gpt-6.2-sol' })
  const terminal = Object.freeze({ kind: 'accept', additionalContexts: [] })
  let calls = 0
  const dispatch = waterfall([__internals.withSubagentRouteHint], async () => { calls++; return terminal })
  for (const name of ['subagent', 'subagent_fork']) {
    const decision = await dispatch(Object.freeze({ name, arguments: args }), result)
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.additionalContexts, terminal.additionalContexts)
    assert.equal(decision.content[0], result.content[0])
    assert.match(decision.content[1].text, /`provider`、`model` 和 `reasoning_effort`/)
    assert.match(decision.content[1].text, /list_subagent_models/)
    assert.deepEqual(result.error, { message: routeError })
    assert.equal(result.content.length, 1)
    assert.deepEqual(args, { provider: 'deepseek', model: 'gpt-6.2-sol' })
  }
  assert.equal(calls, 2)
})

test('empty route fields add a next-step correction and forbid replaying the same call', async () => {
  const decision = await __internals.withSubagentRouteHint(
    { name: 'list_subagent_models', arguments: { provider: '', model: '' } },
    routeFailure('`provider` must be non-empty'),
    async () => ({ kind: 'accept' }),
  )
  assert.match(decision.content[1].text, /不要重复相同参数/)
  assert.equal(decision.additionalContexts.length, 1)
  const [context] = decision.additionalContexts
  assert.equal(typeof context.id, 'string')
  assert.equal(context.role, 'user')
  assert.equal(context.source.kind, 'perf-guard')
  assert.match(context.content[0].text, /授权的精确 ID/)
})

test('empty successful discovery stops enumeration and adds a next-step correction', async () => {
  const decision = await __internals.withSubagentRouteHint(
    { name: 'list_subagent_models', arguments: {} },
    { isError: false, value: '(no LLM providers)', content: [{ type: 'text', text: '(no LLM providers)' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.match(decision.content[1].text, /不要反复查询/)
  assert.equal(decision.additionalContexts.length, 1)
  assert.match(decision.additionalContexts[0].content[0].text, /不要猜测路由/)
})

test('discovery validation suggests an empty request, not empty fields', async () => {
  const decision = await __internals.withSubagentRouteHint(
    { name: 'list_subagent_models' }, routeFailure('`provider` must be non-empty'), async () => ({ kind: 'accept' }),
  )
  assert.match(decision.content[1].text, /list_subagent_models\(\{\}\)/)
})

test('subagent hint passes through unrelated calls and explicit post-execution decisions', async () => {
  const hint = __internals.withSubagentRouteHint
  const result = routeFailure(routeError)
  const exec = { name: 'subagent' }
  const accept = { kind: 'accept' }
  for (const decision of [{ kind: 'block', feedback: [] }, { kind: 'accept', content: [] }, { kind: 'accept', value: null }, undefined]) {
    assert.equal(await hint(exec, result, async () => decision), decision)
  }
  for (const [call, outcome] of [
    [{ name: 'other_tool' }, result],
    [{ ...exec, signal: AbortSignal.abort() }, result],
    [exec, { ...result, isError: false }],
    [exec, { isError: true, content: result.content }],
    [exec, routeFailure('permission denied')],
  ]) assert.equal(await hint(call, outcome, async () => accept), accept)
})

test('CONTENT_REFUSED is never treated as a plugin transport or gateway retry', async () => {
  const refusal = { code: 'CONTENT_REFUSED', message: 'upstream closed' }
  const prefs = normalizePrefs({ retryTransport: true, statuses: { 502: true } })
  const hooks = makeHooks(prefs)
  assert.equal(isTransportFailure(refusal), false)
  assert.equal(__internals.shouldRetry({ prefs, info: { ...refusal, status: 502, kind: 'http' }, emitted: false, attemptNumber: 1 }), false)
  assert.equal(await decideRequestError(makeCtx(), legacyPayload(refusal), async () => undefined, hooks), undefined)
  assert.deepEqual(hooks.delays, [])
})

test('resident session stats count idle agents without materializing history', () => {
  const summary = __internals.residentSessionStats
  assert.equal(summary(undefined), null)
  const idle = Object.freeze({
    status: 'idle',
    session: { seq: 42, snapshotEvents() { throw new Error('must not open history') } },
  })
  const running = Object.freeze({
    status: 'running',
    get session() { throw new Error('must not inspect a running session') },
  })
  assert.deepEqual(summary({ list: () => [idle, idle, running] }), {
    attached: 3, idle: 2, running: 1, idleEventCount: 84,
  })
})

test('diagnostic and settings routes require native owner admission, not just the plugin header', async () => {
  const routes = new Map()
  const stops = []
  let admission = { rejection: 401 }
  let connection = { admit: () => admission }
  apply({
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    get(name) { return name === 'connection' ? connection : undefined },
    inject() {},
    effect(start) { stops.push(start()) },
  })
  async function request(path, method = 'GET', headers = { 'x-dsh-plugin': 'perf-guard' }) {
    let status
    let body
    await routes.get('/api/perf-guard/' + path)({ method, headers, on() {
      throw new Error('an unauthorized write must not read the body')
    } }, {
      writeHead(code) { status = code },
      end(output) { body = JSON.parse(output) },
    })
    return { status, body }
  }
  try {
    for (const [path, method] of [['health', 'GET'], ['stats', 'GET'], ['retry', 'POST']]) {
      assert.equal((await request(path, method)).status, 401)
    }
    admission = { peer: { principal: { kind: 'other-principal' } } }
    assert.equal((await request('stats')).status, 403)
    admission = { peer: { principal: { kind: 'owner' } } }
    assert.equal((await request('health', 'GET', {})).status, 403)
    assert.equal((await request('health')).status, 200)
    connection = undefined
    assert.equal((await request('retry', 'POST')).status, 503)
  } finally {
    for (const stop of stops) stop()
  }
})
