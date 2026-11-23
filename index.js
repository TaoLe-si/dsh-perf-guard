/**
 * dsh-perf-guard — 宿主半（Node / cordis 插件）。
 *
 * 三块能力：
 *  1. 观测：30s 采样宿主 RSS，扫描 <DSH_HOME>/sessions 找超大会话日志；
 *  2. 错误日志：拦截 llm/stream，把 HTTP 400/401/402/403/429/502/503 的
 *     状态码、error code、provider/model、响应片段、重试次数写进宿主日志，
 *     同时保留环形缓冲供设置页展示；
 *  3. 自动重试：按状态码分别开关 + 可选上限，只在「尚未吐出任何内容」时重试，
 *     避免重复输出；429 优先使用 Retry-After。
 *
 * 版本适配：同一份代码同时跑在 DSH 0.2.1-rc.4（旧契约）与 0.2.2-rc.1+（新契约）上。
 * 差别集中在三处，全部用「能力探测」而不是版本号判断：
 *  - finish chunk 的 reason：旧版给 stopReason 文案，新版是判别式 kind='max-tokens'；
 *  - 失败对象：新版带归一化 code（TRANSPORT/TIMEOUT/EMPTY_RESPONSE/RATE_LIMIT/SERVER）；
 *  - agent/request-error 载荷：新版多一个 retryPolicy，且下游有原生
 *    @deepseek-ai/dsh-llm-retry 在同一个 waterfall 上做重试。
 *
 * 刻意不做的事：不裁剪、不重写任何 session 日志。
 */
import { getHeapStatistics } from 'node:v8'
import { readFile, writeFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DISCOVERY_TOOL, modelCatalogMiddleware } from './model-catalog.js'

export const inject = ['webServer']

const VERSION = '1.9.5'
const ROUTE_PREFIX = '/api/perf-guard'
const SESSION_SCAN_TTL_MS = 60 * 1000
const MONITOR_INTERVAL_MS = 30 * 1000
const RSS_WARN_BYTES = 2 * 1024 ** 3
/**
 * 堆压力告警线。
 *
 * 真正让长会话「卡」的不是 RSS，而是 **V8 堆接近上限**：堆快满时 major GC 会频繁打断
 * 单线程事件循环，所有会话一起停帧。heapUsed / heap_size_limit 才是能提前告警的信号
 *（heapTotal 只是已提交量，接近上限说明马上要扩堆或 GC）。
 */
const HEAP_PRESSURE_WARN = 0.85
const MAX_LOGGED_FILES = 5000
/** 用户可配置重试的状态码。 */
const WATCHED_STATUSES = ['400', '401', '402', '403', '429', '502', '503']

/**
 * DSH 0.2.2-rc.1 起 LLM 失败自带归一化 code（@deepseek-ai/dsh-llm/lib/types/error.js）。
 * 旧版本只有适配器原始 code（PI_AI_ERROR 之类）加正文，所以这层映射只是**补充**：
 * 新信号有就用，没有就退回按状态码/正文分类，旧版行为不受影响。
 */
const NON_RETRYABLE_CODES = new Set(['ABORTED', 'CANCELLED', 'CONTENT_REFUSED'])
const NORMALIZED_TRANSPORT_CODES = new Set([
  'TRANSPORT',      // pi-ai :1473 network|socket|ECONN*|other side closed|terminated
  'TIMEOUT',        // pi-ai :1472 与 idle watchdog :2051
  'STREAM_CLOSED',  // pi-ai :1677 流提前结束 —— 不在原生默认 retryableCodes 里，正是本插件该补的
  'EMPTY_RESPONSE', // error.js:36 官方常量
])
/** 归一化 code → 等价的 HTTP 状态码，用于复用用户已有的「按状态码开关」。 */
const NORMALIZED_STATUS_CODES = new Map([
  ['RATE_LIMIT', 429],
  ['SERVER', 502],
])
const DEFAULT_RETRY_PREFS = {
  logErrors: true,
  maxRetries: 2,
  /** 传输中断 / 流被截断（无 HTTP 状态码）是否重试。 */
  retryTransport: true,
  /**
   * 正文思维链怎么处理。
   *
   * 有些渠道/模型不走 reasoning 通道，把 `<thinking>…</thinking>` 原样当正文吐出来：
   * - `keep`（默认）：改写成真正的 reasoning 块，内容**保留**、界面按思考行折叠显示；
   * - `strip`：整段丢弃，不写进消息；
   * - `off`：不处理，原样打印。
   */
  thinkingMode: 'keep',
  /**
   * 新版原生 @deepseek-ai/dsh-llm-retry 接管某个 code 时，本插件是否让位（默认 true）。
   * 让位能避免双重退避，也避免绕开 provider 策略里的 maxRetries 上限；
   * 置 false 表示「原生预算耗尽后仍按本插件上限继续重试」。
   */
  respectNativePolicy: true,
  statuses: {
    '400': false,
    '401': false,
    '402': false,
    '403': false,
    '429': true,
    '502': true,
    '503': true,
  },
}
const MAX_ERRORS = 60

/**
 * 重试次数**安全上限**。
 *
 * 设置页里的「不设上限」（maxRetries = -1）只表示「不受用户设定次数限制」，
 * 仍然受这里硬封顶：永久性错误重试一万次也不会成功，而每次重试都要重建完整
 * 请求与流，宿主侧会话状态只增不减 —— 这正是堆内存单调上涨直到崩溃的路径。
 */
const SAFETY_MAX_ATTEMPTS = 8

/** 重试永远不会成功的状态码（永久性错误：参数错、鉴权失败、无权限、余额不足、路由不存在、语义错误）。 */
const PERMANENT_STATUSES = new Set(['400', '401', '402', '403', '404', '405', '422'])
/** UI 装饰素材：由 tools/generate-assets.mjs 生成的 PNG。 */
const ASSET_FILES = new Map([
  ['aurora.png', 'image/png'],
  ['sprig.png', 'image/png'],
  ['halo.png', 'image/png'],
])

function assetPath(name) {
  return fileURLToPath(new URL('./assets/' + name, import.meta.url))
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function prefsPath() {
  return join(dshHome(), 'perf-guard.retry.json')
}

let retryPrefs = null

/**
 * 归一化思维链处理方式，并兼容 1.3.0 的布尔字段 `stripThinking`。
 *
 * @param {object} raw - 原始配置。
 * @returns {'keep' | 'strip' | 'off'} 处理方式。
 */
function normalizeThinkingMode(raw) {
  const mode = raw?.thinkingMode
  if (mode === 'keep' || mode === 'strip' || mode === 'off') return mode
  // 旧字段：false 即「不处理」；true 在 1.3.x 的语义是丢弃，但保留内容更符合预期，故回落到默认 keep。
  if (raw?.stripThinking === false) return 'off'
  return DEFAULT_RETRY_PREFS.thinkingMode
}

function normalizePrefs(raw) {
  const prefs = {
    logErrors: typeof raw?.logErrors === 'boolean' ? raw.logErrors : DEFAULT_RETRY_PREFS.logErrors,
    // -1 = 不设上限；其余 0–50。用户可以在设置页选择「不限」。
    maxRetries: Number.isInteger(raw?.maxRetries) && raw.maxRetries >= -1 ? Math.min(50, raw.maxRetries) : DEFAULT_RETRY_PREFS.maxRetries,
    retryTransport: typeof raw?.retryTransport === 'boolean' ? raw.retryTransport : DEFAULT_RETRY_PREFS.retryTransport,
    respectNativePolicy: typeof raw?.respectNativePolicy === 'boolean' ? raw.respectNativePolicy : DEFAULT_RETRY_PREFS.respectNativePolicy,
    thinkingMode: normalizeThinkingMode(raw),
    statuses: { ...DEFAULT_RETRY_PREFS.statuses },
  }
  for (const status of WATCHED_STATUSES) {
    if (typeof raw?.statuses?.[status] === 'boolean') prefs.statuses[status] = raw.statuses[status]
  }
  // 永久性错误无论用户怎么设都不重试：重试它们只会拖垮内存与回合上限。
  const forced = []
  for (const status of PERMANENT_STATUSES) {
    if (status in prefs.statuses && prefs.statuses[status] === true) forced.push('HTTP ' + status)
    if (status in prefs.statuses) prefs.statuses[status] = false
  }
  if (Number.isInteger(raw?.maxRetries) && raw.maxRetries < 0) forced.push('不限次数')
  if (forced.length > 0) prefs.forcedSafe = forced
  return prefs
}

async function loadRetryPrefs(force = false) {
  if (retryPrefs !== null && !force) return retryPrefs
  try {
    const raw = JSON.parse(await readFile(prefsPath(), 'utf8'))
    retryPrefs = normalizePrefs(raw)
    if (retryPrefs.forcedSafe !== undefined) {
      // 不静默：用户以为开着的东西其实被关掉了，必须让他看见原因。
      console.warn(
        '[perf-guard] 已强制收敛不安全的重试配置：%s。永久性错误重试不会成功，' +
        '「不限次数」在持续故障下会把堆内存吃满导致崩溃。上限 %s 次。',
        retryPrefs.forcedSafe.join(' / '),
        SAFETY_MAX_ATTEMPTS,
      )
    }
  } catch {
    retryPrefs = normalizePrefs(undefined)
  }
  return retryPrefs
}

/** 丢掉内存里的偏好缓存，下次 {@link loadRetryPrefs} 重新读盘（测试与热更新用）。 */
function resetPrefsCache() {
  retryPrefs = null
}

async function saveRetryPrefs(input) {
  // 用当前值兜底再归一化：浏览器半只提交它认识的字段，整体替换会把新增偏好
  //（例如 respectNativePolicy）在每次保存时悄悄重置成默认值。
  const current = retryPrefs ?? normalizePrefs(undefined)
  const next = normalizePrefs({
    ...current,
    ...input,
    statuses: { ...current.statuses, ...(typeof input?.statuses === 'object' && input.statuses !== null ? input.statuses : {}) },
  })
  retryPrefs = next
  try {
    await writeFile(prefsPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch {
    // 只读环境：内存里生效即可。
  }
  return next
}

/* ------------------------------------------------------------------ */
/*  错误环缓冲                                                          */
/* ------------------------------------------------------------------ */

const recentErrors = []

function recordError(entry) {
  recentErrors.unshift(entry)
  if (recentErrors.length > MAX_ERRORS) recentErrors.length = MAX_ERRORS
}

/* ------------------------------------------------------------------ */
/*  会话日志统计（原有能力）                                             */
/* ------------------------------------------------------------------ */

function isSessionLog(name) {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')
}

async function collectSessionLogs(dir, out, depth) {
  if (depth > 3 || out.length >= MAX_LOGGED_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_LOGGED_FILES) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionLogs(full, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !isSessionLog(entry.name)) continue
    try {
      const info = await stat(full)
      out.push({ path: full, bytes: info.size, sessionId: sessionIdOf(full) })
    } catch {
      // 单个文件读不到不影响整体统计。
    }
  }
}

function sessionIdOf(filePath) {
  const parts = filePath.split(/[\\/]/)
  return parts.length >= 2 ? parts[parts.length - 2] : filePath
}

let sessionCache = { at: 0, value: null }

async function collectSessionStats() {
  if (sessionCache.value !== null && Date.now() - sessionCache.at < SESSION_SCAN_TTL_MS) {
    return sessionCache.value
  }
  const files = []
  await collectSessionLogs(join(dshHome(), 'sessions'), files, 0)
  files.sort((left, right) => right.bytes - left.bytes)
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const value = {
    scannedAt: new Date().toISOString(),
    count: files.length,
    totalBytes,
    largest: files.slice(0, 8),
  }
  sessionCache = { at: Date.now(), value }
  return value
}

/** Count attached agents without opening cold sessions or materializing their logs. */
function residentSessionStats(agents) {
  if (typeof agents?.list !== 'function') return null
  const live = agents.list()
  const counts = { attached: live.length, idle: 0, running: 0, idleEventCount: 0 }
  for (const agent of live) {
    if (agent.status === 'running') counts.running++
    else if (agent.status === 'idle') {
      counts.idle++
      const seq = agent.session?.seq
      if (Number.isSafeInteger(seq) && seq >= 0) counts.idleEventCount += seq
    }
  }
  return counts
}

function hostSnapshot() {
  const memory = process.memoryUsage()
  const heap = getHeapStatistics()
  // 堆上限是启动时定的（--max-old-space-size 或默认值），运行期改不了；
  // 这里把它量出来，客户端与设置页才能给出「还差多少」而不是拍脑袋的固定阈值。
  const heapLimit = heap.heap_size_limit
  const heapUsed = memory.heapUsed
  return {
    pid: process.pid,
    heapLimit,
    heapPressure: heapLimit > 0 ? Math.min(1, heapUsed / heapLimit) : null,
    heapPressureWarn: HEAP_PRESSURE_WARN,
    /** 距离堆上限还有多少可用字节（负数表示已超）。 */
    heapHeadroom: heapLimit - memory.heapUsed,
    uptimeSeconds: Math.round(process.uptime()),
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    nodeVersion: process.version,
  }
}

/* ------------------------------------------------------------------ */
/*  错误分类 / 重试                                                     */
/* ------------------------------------------------------------------ */

function messageOf(failure, error) {
  if (failure && typeof failure.message === 'string') return failure.message
  if (error instanceof Error) return error.message
  if (error !== undefined && error !== null) return String(error)
  return ''
}

function statusOf(failure, error) {
  if (failure && Number.isInteger(failure.status)) return failure.status
  if (error && Number.isInteger(error.status)) return error.status
  const mapped = NORMALIZED_STATUS_CODES.get(String((failure && failure.code) || (error && error.code) || ''))
  if (mapped !== undefined) return mapped
  const message = messageOf(failure, error)
  const leading = /^\s*(\d{3})\b/.exec(message)
  if (leading !== null) return Number(leading[1])
  const embedded = /"?status(?:Code)?"?\s*[:=]\s*(\d{3})/.exec(message)
  if (embedded !== null) return Number(embedded[1])
  return null
}

const TRANSPORT_PATTERN = /TRANSPORT|STREAM|TRUNCATED|TIMEOUT|ETIMEDOUT|timed out|request timeout|terminated|Connection error|stream ended|socket hang up|ECONNRESET|other side closed|premature close|unexpected end|上游输出中断|输出中断|连接中断|中断，请重试|上游中断/i

/**
 * 上游「这一轮什么都没产出」的失败（强信号）。
 *
 * 中转/网关在上游长时间不吐 token 时会自己掐断并回一条中文错误，例如
 * `上游 95 秒内没有产出，请稍后重试`。它既没有 HTTP 状态码，也不含
 * TRANSPORT_PATTERN 里的任何一个词，所以过去落在 `unknown` 类而不重试
 * —— 但这恰好是最该重试的一种：整轮零内容落地，重试不可能产生重复输出。
 */
const NO_OUTPUT_PATTERN = /没有产出|未产出|无输出|没输出|空响应|no output|produced no (?:output|content|response|text)|empty (?:response|completion|reply)/i

/** 账号池/中转排队这类瞬时拥塞（强信号：繁忙本身就是临时的，等一会儿就会好）。 */
const BUSY_PATTERN = /账号池|号池|池繁忙|繁忙|排队|拥挤|overloaded|server busy|too many requests/i

/**
 * 并发上限：同一账号/用户**同时在跑**的请求数超了（强信号）。
 *
 * 和「账号池繁忙」同类，是瞬时拥塞而不是配置错误：等同账号别的请求跑完就会放行，
 * 所以重试有意义。实测形态（2026-11-06 宿主日志）：
 *
 *     perf-guard: LLM UNKNOWN PI_AI_ERROR · anliang/gpt-6.1-terra · attempt 1 ·
 *       Concurrency limit exceeded for user, please retry later
 *
 * 也就是 code=PI_AI_ERROR、**无 HTTP 状态码**、kind=unknown。它不含 TRANSPORT 关键词，
 * 「稍后重试」这条弱信号又缺少上游/超时语境，于是过去整类被放行不重试。
 *
 * 仍然刻意**不**认泛化的 `PI_AI_ERROR` code —— 那会把这一层变成「任何 pi-ai 错误都重试」，
 * 在 `maxRetries = -1` 下足以打成死循环。
 */
const CONCURRENCY_PATTERN = /concurren(?:cy|t)[\s_-]*(?:limit|request)|max(?:imum)?[\s_-]*concurren|too many concurrent|并发(?:数|量)?\s*(?:上限|超限|超过|限制|已满)|(?:同时|并行)请求(?:数)?\s*(?:上限|超限|过多|超出)/i

/** 「稍后重试」这种弱信号，只有配合上游/超时语境才足以判定为空转。 */
const RETRY_LATER_PATTERN = /稍后重试|稍后再试|(?:please )?(?:retry|try) (?:again )?later/i

/** 弱信号的语境条件：不能说"任何带请稍后重试的错误都重试"。 */
const UPSTREAM_CONTEXT_PATTERN = /上游|网关|中转|超时|账号池|号池|upstream|gateway|proxy|timeout|timed out|timed-out/i

/**
 * 判定一次失败是否属于「上游空转」。
 *
 * 分两级，避免把 `余额不足，请稍后重试` 这类**不该重试**的失败也拉进来：
 * - 强信号「没产出 / 空响应」：本身即充分；
 * - 弱信号「稍后重试」：必须同时出现上游/超时语境。
 *
 * 刻意**不**认 `PI_AI_ERROR` 这种泛化 code——那会把这层变成
 * 「任何 pi-ai 错误都重试」，在 `maxRetries = -1` 下足以打成死循环。
 */
function isUpstreamStall(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (NO_OUTPUT_PATTERN.test(text)) return true
  if (BUSY_PATTERN.test(text)) return true
  if (CONCURRENCY_PATTERN.test(text)) return true
  return RETRY_LATER_PATTERN.test(text) && UPSTREAM_CONTEXT_PATTERN.test(text)
}

/** 无 HTTP 状态码的传输层/截断/上游空转类失败。 */
function isTransportFailure(failure, error, message) {
  const code = String((failure && failure.code) || (error && error.code) || '')
  if (NON_RETRYABLE_CODES.has(code)) return false
  if (NORMALIZED_TRANSPORT_CODES.has(code)) return true
  if (TRANSPORT_PATTERN.test(code) || isUpstreamStall(code)) return true
  const text = message || messageOf(failure, error)
  return TRANSPORT_PATTERN.test(text) || isUpstreamStall(text)
}

/**
 * 从错误正文里读服务端自己给出的等待秒数。
 *
 * Cloudflare / 网关的 502、503 正文常带 `"retry_after":60` 与
 * "wait and retry, back off for at least N seconds"。pi-ai 未必把它抬到
 * `providerRetryAfterMs`，所以这里补一条正文兜底；具体等待仍由
 * {@link backoffMs} 的封顶决定。
 *
 * @param {string} message - 错误正文。
 * @returns {number | null} 秒数，没有则为 null。
 */
function retryAfterFromMessage(message) {
  if (typeof message !== 'string' || message.length === 0) return null
  const jsonField = /"retry_after"\s*:\s*(\d+(?:\.\d+)?)/.exec(message)
  if (jsonField !== null) return Number(jsonField[1])
  const header = /retry-after\s*[:=]\s*(\d+)/i.exec(message)
  if (header !== null) return Number(header[1])
  return null
}

function describeFailure(failure, error, options, attempt) {
  const message = messageOf(failure, error)
  const status = statusOf(failure, error)
  return {
    at: new Date().toISOString(),
    kind: status === null && isTransportFailure(failure, error, message) ? 'transport' : status === null ? 'unknown' : 'http',
    status,
    code: (failure && failure.code) || (error && error.code) || null,
    provider: options?.provider ?? null,
    model: options?.model ?? null,
    /** 拥塞类（并发上限 / 账号池繁忙）：退避要给别人让路，见 {@link backoffMs}。 */
    busy: CONCURRENCY_PATTERN.test(message) || BUSY_PATTERN.test(message),
    attempt,
    retryAfterMs: failure && Number.isFinite(failure.providerRetryAfterMs)
      ? failure.providerRetryAfterMs
      : (() => {
          const seconds = retryAfterFromMessage(message)
          return seconds === null ? null : seconds * 1000
        })(),
    message: message.slice(0, 600),
  }
}

/** 允许在「已输出部分内容」后整段重来的网关类状态码。 */
const PARTIAL_RETRY_STATUSES = new Set(['500', '502', '503', '504'])

/**
 * 判定一次失败是否应当重试。
 *
 * 纯函数，便于在不动真实重试配置的前提下覆盖整张矩阵。
 *
 * 规则：
 * - 状态码类：配置里开着该状态即可重试。**已输出部分内容后**只有
 *   {@link PARTIAL_RETRY_STATUSES}（500/502/503/504）在「截断 / 传输中断重试」开关
 *   打开时仍可重试——那个开关的语义正是"允许丢弃已输出内容、整段重来"。
 *   502 常常是在流到一半时由网关返回的，正文是完整的错误 JSON，半截输出没有价值。
 *   429 与 4xx 保持既有语义：已输出后不重试。
 * - 传输 / 截断 / 上游空转：由同一开关控制，不受是否已输出限制。
 * - 用户取消（signal.aborted）永不重试；`maxRetries` < 0 表示不限。
 *
 * @param {object} args
 * @param {object} args.prefs - 归一化后的重试偏好。
 * @param {{ status: number|null, kind: string }} args.info - 本次失败的分类结果。
 * @param {boolean} args.emitted - 本轮是否已经向调用方吐出过内容。
 * @param {number} args.attemptNumber - 当前是第几次尝试（从 1 起）。
 * @param {boolean} args.aborted - 调用方的 signal 是否已中止。
 * @returns {boolean} 是否重试。
 */
/**
 * 本轮允许的重试次数：用户设定与安全上限取小（-1 视为「不设上限」但仍封顶）。
 * @param {{ maxRetries: number }} prefs 归一化后的偏好。
 * @returns {number} 允许的最大尝试次数。
 */
function retryBudgetOf(prefs) {
  if (!(prefs?.maxRetries >= 0)) return SAFETY_MAX_ATTEMPTS
  return Math.min(prefs.maxRetries, SAFETY_MAX_ATTEMPTS)
}

/** 当前堆是否已经接近上限（此时任何「重试」都是在给崩溃加速）。 */
function isUnderHeapPressure() {
  const heap = getHeapStatistics()
  if (!(heap.heap_size_limit > 0)) return false
  return process.memoryUsage().heapUsed / heap.heap_size_limit >= HEAP_PRESSURE_WARN
}

function shouldRetry({ prefs, info, emitted, attemptNumber, aborted }) {
  if (NON_RETRYABLE_CODES.has(info.code)) return false
  const key = info.status === null ? null : String(info.status)
  const statusEnabled = key !== null && prefs.statuses[key] === true
  // 网关类 5xx 常常是在流到一半时返回的：正文是一整段错误 JSON，半截输出没有价值。
  // 仅在「截断 / 传输中断重试」开关打开时允许丢弃已输出内容重来；
  // 429 与 4xx 保持既有语义（已输出后不重试），避免把限流/参数错误打成循环。
  const partialRetryable = emitted === false
    || (prefs.retryTransport === true && key !== null && PARTIAL_RETRY_STATUSES.has(key))
  const statusRetry = statusEnabled && partialRetryable
  const transportRetry = info.kind === 'transport' && prefs.retryTransport === true
  // 永久性错误：重试不可能成功，直接拒绝（配置里开着也不认）。
  if (key !== null && PERMANENT_STATUSES.has(key)) return false
  // 堆压力过高时不再重试：重试会再建一份完整请求与流，
  // 在内存已经吃紧时继续重试就是把「慢」变成「崩」。
  if (aborted !== true && isUnderHeapPressure()) return false
  return (statusRetry || transportRetry)
    && attemptNumber <= retryBudgetOf(prefs)
    && aborted !== true
}

function backoffMs(info, attempt) {
  if (info.retryAfterMs !== null && info.retryAfterMs > 0) return Math.min(info.retryAfterMs, 30_000)
  // 429 与并发上限/账号池繁忙同属**拥塞**：0.8s 复撞的概率很高，
  // 起步就给到 2s，让占用并发额度的那个请求先跑完。
  const base = info.status === 429 || info.busy === true ? 2000 : 800
  return Math.min(base * 2 ** attempt, 15_000)
}

/**
 * 新版（DSH 0.2.2-rc.1+）的 `agent/request-error` 载荷带 `retryPolicy` 键。
 *
 * 按**键是否存在**判定，而不是看值：新版由 llm 服务从 provider 注册表解析后注入，
 * 即使 provider 没显式配置也一定存在（默认 normal 策略）；旧版（0.2.1-rc.4）
 * 的载荷里根本没有这个键。
 *
 * @param {object} payload - agent/request-error 载荷。
 * @returns {boolean} 是否新契约。
 */
function hasNativeRetryContract(payload) {
  return payload !== null && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'retryPolicy')
}

/**
 * 该失败是否已被原生 @deepseek-ai/dsh-llm-retry 接管。
 *
 * 原生判定（packages/llm/llm-retry/lib/index.js）：`mode: 'always'` 全接管；
 * `mode: 'normal'` 只接管 retryableCodes 里列出的 code。被接管时我们还返回一次
 * `{ kind: 'retry' }` 就是双重退避，而且能绕开 provider 策略的 maxRetries 上限。
 *
 * @param {object} policy - 载荷里的 retryPolicy（可能为 undefined）。
 * @param {string} code - 归一化失败 code。
 * @returns {boolean} 是否交给原生处理。
 */
function isNativeOwned(policy, code) {
  if (policy === null || typeof policy !== 'object') return false
  if (policy.mode === 'always') return true
  if (policy.mode !== 'normal') return false
  if (typeof code !== 'string' || code.length === 0) return false
  return Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code)
}

/**
 * 用 provider 策略里的退避参数算等待时间（带抖动）；策略缺失/不合法时退回插件默认。
 *
 * @param {object} policy - retryPolicy（可能为 undefined）。
 * @param {number} attempt - 已重试次数（从 0 起）。
 * @param {(attempt: number) => number} fallback - 默认算法。
 * @returns {number} 毫秒。
 */
function backoffMsFromPolicy(policy, attempt, fallback) {
  const backoff = policy !== null && typeof policy === 'object' ? policy.backoff : undefined
  const initial = Number(backoff?.initialDelayMs)
  const max = Number(backoff?.maxDelayMs)
  if (!Number.isFinite(initial) || !Number.isFinite(max) || initial <= 0 || max <= 0 || initial > max) {
    return fallback(attempt)
  }
  const rawJitter = Number(backoff?.jitterRatio)
  const jitter = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0
  const exponential = Math.min(initial * 2 ** attempt, max)
  const factor = 1 - jitter + 2 * jitter * Math.random()
  return Math.min(Math.round(exponential * factor), max)
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * 包装一次 llm stream：记录错误并在允许时重试。
 * 只有「还没有向调用方吐出任何 chunk」才重试，避免重复输出。
 */
/* ------------------------------------------------------------------ */
/*  思维链防泄漏                                                        */
/* ------------------------------------------------------------------ */

/**
 * 认哪些思维链标签。
 *
 * 有些渠道/模型不走 reasoning 通道，而是把思维链**原样塞进正文**，例如
 * `<thinking>Now let me read the Flutter navigation…`。用户看到的就是一坨本该折叠的推理。
 * 标签集合刻意收得很窄：宁可漏判，也不要把正常正文/代码块里的尖括号吃掉。
 */
const THINKING_OPEN_RE = /<(thinking|thought|reasoning)\s*>/i
const THINKING_CLOSE_RE = /<\/(thinking|thought|reasoning)\s*>/i
/** 标签最长形态（`<reasoning >`）再留余量，用于判断末尾是不是「半个标签」。 */
const THINKING_TAG_LOOKAHEAD = 24

/** 累计拦下的思维链字符数（设置页/自检用）。 */
let thinkingStrippedChars = 0

/**
 * 末尾可能是「半个标签」的起点：从最后一个 `<` 起扣住，等下一个 chunk 再判。
 * 没有 `<` 或离得太远就说明不可能是标签，全部放行。
 *
 * @param {string} pending - 尚未决断的尾巴。
 * @returns {number} 需要扣住的下标。
 */
function holdFrom(pending) {
  const lt = pending.lastIndexOf('<')
  if (lt === -1) return pending.length
  if (pending.length - lt >= THINKING_TAG_LOOKAHEAD) return pending.length
  return lt
}

/**
 * 流式思维链过滤器（跨 chunk 保留状态）。
 *
 * 标签可能被切断在两个 chunk 之间（`<thi` + `nking>`），所以不能只看单个 chunk：
 * 未决断的尾巴留在 `pending` 里，下一个 chunk 到了再一起判。
 *
 * @returns {{ push: (text: string) => string, flush: () => string, isThinking: () => boolean }}
 */
function createThinkingFilter() {
  let inThinking = false
  let pending = ''

  return {
    /**
     * 喂入一段增量，返回**可以放行**的文本（思维链部分已被摘掉）。
     * @param {string} text - 原始增量。
     * @returns {string} 清洗后的增量，可能为空串。
     */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) return ''
      pending += text
      let out = ''
      for (;;) {
        if (inThinking) {
          const close = THINKING_CLOSE_RE.exec(pending)
          if (close !== null) {
            thinkingStrippedChars += close.index
            pending = pending.slice(close.index + close[0].length)
            inThinking = false
            continue
          }
          // 还没闭合：正文一律丢掉，只留可能是半个闭标签的尾巴。
          const hold = holdFrom(pending)
          thinkingStrippedChars += hold
          pending = pending.slice(hold)
          return out
        }
        const open = THINKING_OPEN_RE.exec(pending)
        if (open !== null) {
          out += pending.slice(0, open.index)
          pending = pending.slice(open.index + open[0].length)
          inThinking = true
          continue
        }
        const hold = holdFrom(pending)
        out += pending.slice(0, hold)
        pending = pending.slice(hold)
        return out
      }
    },
    /**
     * 收尾：把扣住的尾巴交出来。
     *
     * 仍停在思维链里说明这个 `<thinking>` 没闭合——此时**丢弃**剩余内容（用户要的正是
     * 「别把它当输出打印」），并复位状态，避免后续正文被无限吞掉。
     *
     * @returns {string} 可以放行的尾巴。
     */
    flush() {
      const rest = pending
      pending = ''
      if (inThinking) {
        thinkingStrippedChars += rest.length
        inThinking = false
        return ''
      }
      return rest
    },
    /** @returns {boolean} 当前是否处在思维链内部。 */
    isThinking() {
      return inThinking
    },
  }
}

/**
 * 一次性摘除整段文本里的思维链（用于 `block-end` 的整块改写）。
 *
 * 必须做这一步：assembler 里 `block-end` 会**整块覆盖**已累积的 deltas
 * （`assemble(): if (partial.block) return partial.block`），只过滤增量的话，
 * 最终消息仍会带上被摘掉的原文。
 *
 * @param {string} text - 整块原文。
 * @returns {string} 清洗后的文本。
 */
function stripThinkingText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!THINKING_OPEN_RE.test(text) && !THINKING_CLOSE_RE.test(text)) return text
  const filter = createThinkingFilter()
  return filter.push(text) + filter.flush()
}

/**
 * 流式切分器：把正文切成 text / reasoning 两类片段。
 *
 * 和 {@link createThinkingFilter} 用同一套标签与「半个标签」处理，区别是**不丢弃**内容，
 * 只标注这段属于正文还是思维链。
 *
 * @returns {{ push: (text: string) => Array<{ type: 'text'|'reasoning', text: string }>, flush: () => Array<{ type: 'text'|'reasoning', text: string }> }}
 */
function createThinkingSplitter() {
  let inThinking = false
  let pending = ''

  return {
    /**
     * @param {string} text - 增量。
     * @returns {Array<{ type: 'text'|'reasoning', text: string }>} 片段（按到达顺序）。
     */
    push(text) {
      const segments = []
      if (typeof text !== 'string' || text.length === 0) return segments
      pending += text
      for (;;) {
        if (inThinking) {
          const close = THINKING_CLOSE_RE.exec(pending)
          if (close !== null) {
            if (close.index > 0) segments.push({ type: 'reasoning', text: pending.slice(0, close.index) })
            pending = pending.slice(close.index + close[0].length)
            inThinking = false
            continue
          }
          const hold = holdFrom(pending)
          if (hold > 0) segments.push({ type: 'reasoning', text: pending.slice(0, hold) })
          pending = pending.slice(hold)
          return segments
        }
        const open = THINKING_OPEN_RE.exec(pending)
        if (open !== null) {
          if (open.index > 0) segments.push({ type: 'text', text: pending.slice(0, open.index) })
          pending = pending.slice(open.index + open[0].length)
          inThinking = true
          continue
        }
        const hold = holdFrom(pending)
        if (hold > 0) segments.push({ type: 'text', text: pending.slice(0, hold) })
        pending = pending.slice(hold)
        return segments
      }
    },
    /**
     * 收尾：把扣住的尾巴交出来；仍停在思维链里就按 reasoning 交还（内容保留）。
     * @returns {Array<{ type: 'text'|'reasoning', text: string }>} 剩余片段。
     */
    flush() {
      const rest = pending
      pending = ''
      const type = inThinking ? 'reasoning' : 'text'
      inThinking = false
      return rest.length === 0 ? [] : [{ type, text: rest }]
    },
  }
}

/** 我们自己分配的块序号起点，避开适配器用的 0..n。 */
const SYNTHETIC_INDEX_BASE = 1_000_000

/**
 * 把正文里的思维链**改写**成真正的 reasoning 块（内容保留、界面按思考行折叠）。
 *
 * 为什么不能只改增量：`BlockAssembler.assemble()` 里 `if (partial.block) return partial.block`，
 * 适配器结尾的 `block-end` 带着整块原文，会覆盖已累积的 deltas。所以这里把 text 块的
 * `block-start`/`block-end` 一起接管，按片段重新开块。
 *
 * 关键取舍——**没遇到标签时完全透传**：原生块、序号、`block-end` 一律原样下发，
 * 这样绝大多数正常消息的块结构与 `replayState` 保持不变（`assembled()` 要求
 * `envelope.blocks.length === all.length` 才保留 replay）。只有真的出现思维链标签，
 * 才切换成自建块；此时块数变化，DSH 会自动丢弃该轮的 replayState（内容不受影响）。
 *
 * @returns {object} 路由器。
 */
function createThinkingRouter() {
  const splitter = createThinkingSplitter()
  let sequence = 0
  /** 适配器 text 块的序号与原始 block-start；延迟下发，等第一个片段确定类型。 */
  let nativeIndex = null
  let nativeStart = null
  let nativeOpen = false
  let nativeText = ''
  /** 是否已经遇到思维链标签（此后不再复用原生块）。 */
  let committed = false
  /** 由我们打开的当前块。 */
  let mine = null

  const openMine = (chunks, type) => {
    sequence += 1
    mine = { index: SYNTHETIC_INDEX_BASE + sequence, type, text: '' }
    chunks.push({ type: 'block-start', index: mine.index, blockType: type })
  }
  const closeMine = (chunks) => {
    if (mine === null) return
    chunks.push({ type: 'block-end', index: mine.index, block: { type: mine.type, text: mine.text } })
    mine = null
  }
  const appendMine = (chunks, type, text) => {
    if (text.length === 0) return
    if (mine === null || mine.type !== type) {
      closeMine(chunks)
      openMine(chunks, type)
    }
    mine.text += text
    chunks.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: mine.index, text })
  }
  const emitSegment = (chunks, segment) => {
    if (!committed && segment.type === 'text' && nativeIndex !== null) {
      // 还没遇到标签：继续用原生块，保持块结构与 replayState 对齐。
      if (!nativeOpen) {
        nativeOpen = true
        // 用适配器原始的 block-start（保留其全部字段），不要自己造一个。
        const start = nativeStart ?? { type: 'block-start', index: nativeIndex, blockType: 'text' }
        nativeStart = null
        chunks.push(start)
      }
      nativeText += segment.text
      chunks.push({ type: 'text-delta', index: nativeIndex, text: segment.text })
      return
    }
    if (!committed) {
      // 第一次遇到思维链：把原生 text 块就地收尾，转到自建块。
      committed = true
      if (nativeOpen) {
        chunks.push({ type: 'block-end', index: nativeIndex, block: { type: 'text', text: nativeText } })
        nativeOpen = false
      }
      nativeIndex = null
      nativeStart = null
    }
    appendMine(chunks, segment.type, segment.text)
  }

  return {
    /**
     * 适配器的 text block-start：延迟下发，先只记下来。
     *
     * 延迟是为了「纯思维链的块」不产生一个空的正文块；但**没内容时必须在 block-end
     * 前补回来**（否则整条 chunk 流就少了一个 block-start，落盘流与原来不一致）。
     *
     * @param {number} index - 块序号。
     * @param {object} [chunk] - 原始 block-start（原样回放，保留全部字段）。
     * @returns {Array<object>} 立即要下发的 chunk（延迟策略下为空）。
     */
    beginTextBlock(index, chunk) {
      if (committed) return []
      nativeIndex = index
      nativeStart = chunk ?? null
      nativeOpen = false
      nativeText = ''
      return []
    },
    /** 文本增量：返回要下发的 chunk 序列（可能是 0..n 个）。 */
    pushDelta(index, text) {
      if (!committed && nativeIndex === null) nativeIndex = index
      const chunks = []
      for (const segment of splitter.push(text)) emitSegment(chunks, segment)
      return chunks
    },
    /**
     * 适配器的 text block-end。
     * @param {object} chunk - 原始 block-end。
     * @returns {{ chunks: Array<object>, passthrough: boolean }} 先下发的 chunk；passthrough 为真时调用方应原样转发 chunk。
     */
    endTextBlock(chunk) {
      const chunks = []
      for (const segment of splitter.flush()) emitSegment(chunks, segment)
      if (!committed) {
        // 整块没有思维链：原样转发，块结构与 replayState 一点不动。
        // 若这块一个字节都没有（延迟的 block-start 还没下发），先把 block-start 补上。
        if (!nativeOpen && nativeStart !== null) chunks.push(nativeStart)
        nativeStart = null
        return { chunks, passthrough: true }
      }
      closeMine(chunks)
      return { chunks, passthrough: false }
    },
    /** 是否真的改写过块结构（改写过就不能再沿用适配器的 replayState）。 */
    get rewritten() {
      return committed
    },
    /** 正常收尾：冲洗残留片段并关闭当前块。 */
    flush() {
      const chunks = []
      for (const segment of splitter.flush()) emitSegment(chunks, segment)
      closeMine(chunks)
      return chunks
    },
  }
}

/**
 * 本插件自己发起「流级重试」时打在请求上的标记。
 *
 * 为什么需要它：cordis 的 waterfall 发给每个 listener 的 next 是**一次性**的
 * （lib/index.js：if (called) throw new Error('next() called multiple times')），
 * 而流级重试必须重新发起一次模型调用。所以重试时不再调 next()，而是带上这个标记
 * 重新进入 llm.stream()：waterfall 从最外层重跑，本中间件认出标记后只透传，
 * 不会层层套娃。旧内核的 next 可重复调用，走同一条重新进入的路径也无害。
 */
const LAYERED_RETRY = Symbol.for('dsh-perf-guard.layered-retry')

/** 是否是我们自己发起的重试再入（内层只透传）。 */
function isLayeredRetry(options) {
  return options !== null && typeof options === 'object' && options[LAYERED_RETRY] === true
}

/** 内核拒绝二次调用 next 时抛的错。 */
function isSingleShotNextError(error) {
  return error instanceof Error && /next\(\) called multiple times/.test(error.message)
}

/**
 * 打开一次模型调用流。
 *
 * 第 0 次走 waterfall 的 next()；重试必须重新发起调用，但 next() 不能二次调用
 * （DSH 0.2.2-rc.1 的 cordis 会抛 next() called multiple times），所以改为重新进入
 * llm.stream() 并带上 {@link LAYERED_RETRY} 标记。
 *
 * @param {object} ctx - 插件上下文（取 llm 服务）。
 * @param {object} options - 本次请求。
 * @param {() => Promise<AsyncIterable>} next - waterfall 下游入口（一次性）。
 * @param {number} attempt - 第几次尝试（从 0 起）。
 * @returns {Promise<AsyncIterable>} chunk 流。
 */
async function openStream(ctx, options, next, attempt) {
  if (attempt === 0) return await next()
  const llm = ctx?.llm
  if (llm !== undefined && llm !== null && typeof llm.stream === 'function') {
    return llm.stream({ ...options, [LAYERED_RETRY]: true })
  }
  // 拿不到 llm 服务时退回老路（旧内核的 next 可重复调用）；新版会抛错，由调用方兜底。
  return await next()
}

async function* withRetryAndLogging(ctx, options, next) {
  // 我们自己发起的重试再入：纯透传，避免递归包装与重复计数。
  if (isLayeredRetry(options)) {
    for await (const chunk of await next()) yield chunk
    return
  }

  const prefs = await loadRetryPrefs()
  /** 上一次的失败；重试不了时用它把「原始失败」交回上层，而不是暴露内部错误。 */
  let lastFailure = null
  for (let attempt = 0; ; attempt += 1) {
    const attemptNumber = attempt + 1
    let emitted = false
    let emittedChars = 0
    let sawFinish = false
    let pending = null
    // 思维链处理：每次尝试各建一个，避免重试时把上一轮的半截状态带过来。
    const thinkingMode = prefs.thinkingMode
    const thinking = thinkingMode === 'strip' ? createThinkingFilter() : null
    const router = thinkingMode === 'keep' ? createThinkingRouter() : null
    /**
     * 改写过块结构后，适配器的 replayState 描述的是**原来那条消息**，再沿用会被
     * pi-ai 判为对不上（`unusable replay state ... block 0 does not match assistant content`）。
     * 块数恰好相同（纯思维链块 → reasoning 块）时 assembler 不会自动丢弃，必须由我们摘掉。
     */
    const finishChunk = (chunk) => {
      if (router === null || !router.rewritten) return chunk
      if (chunk?.type !== 'finish' || chunk.replayState === undefined) return chunk
      // 必须**整个键剔除**。写成 { ...chunk, replayState: undefined } 会留下一个
      // 「键存在、值为 undefined」的自有属性：JSON.stringify 会把它丢掉，往返不再无损，
      // 宿主 snapshotJsonValue 会判定为非无损 JSON 并抛
      // "Assistant stream chunk must be losslessly JSON-serializable"。
      const { replayState: _dropped, ...rest } = chunk
      return rest
    }
    let lastTextIndex = 0
    try {
      const stream = await openStream(ctx, options, next, attempt)
      for await (const chunk of stream) {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
          sawFinish = true
          const reasonKind = String(chunk.reason?.kind ?? '')
          const stopReason = String(chunk.reason?.stopReason ?? chunk.reason?.reason ?? reasonKind)
          if (chunk.reason?.kind === 'error') {
            pending = { failure: chunk.reason.failure, chunk }
            break
          }
          if (chunk.reason?.kind === 'aborted') {
            yield finishChunk(chunk)
            return
          }
          // 输出被截断时适配器仍按正常结束上报，只能靠 finish 自己识别：
          // 旧契约把原因放在 stopReason 文案里（length / max_tokens），
          // 新契约（0.2.2-rc.1+）改成判别式 kind='max-tokens'，两种都要认，
          // 否则升级后这条告警会静默失效。
          if (reasonKind === 'max-tokens' || /length|max[_-]?tokens?|max[_-]?output/i.test(stopReason)) {
            if (prefs.logErrors) {
              ctx.logger?.warn?.(
                'perf-guard: output truncated (finish=%s, %s chars) · %s/%s · 重试通常无效，建议提高该模型的 maxTokens',
                stopReason,
                emittedChars,
                options?.provider ?? '-',
                options?.model ?? '-',
              )
            }
            pending = { failure: { code: 'TRUNCATED', message: 'finish reason ' + stopReason + ' after ' + emittedChars + ' chars' }, chunk, truncated: true }
            break
          }
          // 正常完成：先把可能被扣住的尾巴交出来（半个标签、或 delta-only 协议下的残留）。
          if (router !== null) {
            for (const produced of router.flush()) {
              emitted = true
              emittedChars += typeof produced.text === 'string' ? produced.text.length : 0
              yield produced
            }
          }
          if (thinking !== null) {
            const tail = thinking.flush()
            if (tail.length > 0) {
              emitted = true
              emittedChars += tail.length
              yield { type: 'text-delta', index: lastTextIndex, text: tail }
            }
          }
          yield finishChunk(chunk)
          continue
        }
        // 新契约的文本增量字段是 text（旧版是 delta），两个都认，否则字数统计恒为 0。
        const piece = typeof chunk?.text === 'string' ? chunk.text : typeof chunk?.delta === 'string' ? chunk.delta : ''
        // keep 模式：把正文里的思维链改写成 reasoning 块（内容保留、界面折叠显示）。
        if (router !== null) {
          if (chunk?.type === 'block-start' && chunk.blockType === 'text') {
            for (const produced of router.beginTextBlock(chunk.index, chunk)) {
              emitted = true
              yield produced
            }
            continue
          }
          if (chunk?.type === 'text-delta') {
            lastTextIndex = chunk.index
            for (const produced of router.pushDelta(chunk.index, piece)) {
              emitted = true
              emittedChars += typeof produced.text === 'string' ? produced.text.length : 0
              yield produced
            }
            continue
          }
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
            const result = router.endTextBlock(chunk)
            for (const produced of result.chunks) {
              emitted = true
              emittedChars += typeof produced.text === 'string' ? produced.text.length : 0
              yield produced
            }
            if (result.passthrough) {
              emitted = true
              yield chunk
            }
            continue
          }
        }

        let outgoing = chunk
        if (thinking !== null) {
          if (chunk?.type === 'text-delta') {
            lastTextIndex = chunk.index
            const clean = thinking.push(piece)
            // 整段都是思维链：不往下游吐，于是 emitted 保持 false（此时重试仍是安全的）。
            if (clean.length === 0) continue
            emittedChars += clean.length
            if (clean !== piece) outgoing = { ...chunk, text: clean }
          } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
            // block-end 会整块覆盖已累积的 deltas，必须在这里也摘一遍，
            // 否则最终消息仍是原文。扣住的尾巴按整段重算，丢弃以免重复。
            thinking.flush()
            const clean = stripThinkingText(chunk.block.text)
            if (clean !== chunk.block.text) outgoing = { ...chunk, block: { ...chunk.block, text: clean } }
          }
        }
        if (outgoing === chunk) emittedChars += piece.length
        emitted = true
        yield outgoing
      }
    } catch (error) {
      if (attempt > 0 && isSingleShotNextError(error) && lastFailure !== null) {
        // 内核不允许二次调用 next 且拿不到 llm 服务：这一层没法再重试。
        // 把上一次的原始失败原样交回上层，让 agent/request-error（原生 llm-retry
        // 或本插件）接手 —— 否则会把 next() called multiple times 暴露成回合失败。
        pending = { ...lastFailure, noRetry: true }
        lastFailure = null
      } else {
        pending = { failure: undefined, error }
      }
    }

    // 流结束却没有 finish chunk：静默截断（代理掐断、连接提前关闭）。
    if (pending === null && !sawFinish && emitted) {
      pending = { failure: { code: 'TRANSPORT', message: 'stream ended without finish chunk' } }
    }
    if (pending === null) return

    const info = describeFailure(pending.failure, pending.error, options, attemptNumber)
    recordError(info)
    if (prefs.logErrors) {
      const scope = [info.provider, info.model].filter(Boolean).join('/')
      ctx.logger?.warn?.(
        'perf-guard: LLM %s%s · %s · attempt %s · %s',
        info.kind === 'http' ? 'HTTP ' + (info.status ?? '?') : info.kind.toUpperCase(),
        info.code ? ' ' + info.code : '',
        scope || (options?.provider ?? '-'),
        attemptNumber,
        info.message,
      )
    }

    const retryable = pending.noRetry === true ? false : shouldRetry({
      prefs,
      info,
      emitted,
      attemptNumber,
      aborted: options?.signal?.aborted === true,
    })

    if (!retryable) {
      if (pending.chunk !== undefined) {
        // 截断的 finish 仍然要交给上层，否则这一轮会没有收尾事件。
        yield finishChunk(pending.chunk)
        return
      }
      if (pending.failure?.code === 'TRANSPORT' && pending.error === undefined) {
        // 静默截断：交给上层结束本轮，不抛错（协议里没有对应 chunk 形态）。
        return
      }
      throw pending.error
    }

    lastFailure = pending
    const delay = backoffMs(info, attempt)
    ctx.logger?.warn?.(
      'perf-guard: retry %s/%s in %sms after %s%s%s',
      attemptNumber,
      prefs.maxRetries < 0 ? 'inf' : prefs.maxRetries,
      delay,
      info.kind === 'http' ? 'HTTP ' : '',
      info.status ?? info.kind,
      emitted ? ' (partial output discarded)' : '',
    )
    await sleep(delay, options?.signal)
    if (options?.signal?.aborted) return
  }
}

/**
 * `agent/request-error` 的恢复决策：宿主「这一步的模型请求失败了」的扩展点。
 *
 * **契约变化（DSH 0.2.2-rc.1）**。这个 waterfall 只把**最外层 listener** 的返回值
 * 交给 agent loop（cordis `events.waterfall` 的 `return dispatch()`），而 loop 里是
 *
 *     const action = await this.dispatch.waterfall('agent/request-error', {...}, () => Promise.resolve(void 0))
 *     if (action?.kind !== 'retry') throw new LlmError(...)
 *
 * 所以 listener 若不把 `next()` 的结论传回去，就等于**否掉**下游已经做出的重试决定。
 * 新版下游正坐着原生 @deepseek-ai/dsh-llm-retry（durable 的 llm/retry 事件 + 投影计数），
 * 而旧版（0.2.1-rc.4）没有下游，`next()` 恒等于 `() => Promise.resolve(undefined)`。
 * 因此统一先 `await next()`：对旧版是空操作，对新版是「让原生先决」。
 *
 * 新版还会在载荷里给出 `retryPolicy`（provider 注册时解析，见
 * @deepseek-ai/dsh-llm/lib/types/retry-policy.js）。若某 code 由原生接管，本插件让位：
 * 原生此刻没有给出 retry，说明策略不允许或预算已耗尽，再加码只会双重退避并绕开上限。
 *
 * @param {object} ctx - 插件上下文（取 logger）。
 * @param {object} payload - waterfall 载荷：{ agent, turn, step, provider, failure, retryPolicy?, signal }。
 * @param {() => Promise<any>} next - 继续 waterfall 链。
 * @param {{ prefs?: object, attempts?: Map, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [hooks]
 *   测试用注入点：偏好、重试计数表、等待函数。
 * @returns {Promise<{ kind: 'retry' } | undefined | any>} 决策（原样透传下游结论）。
 */
async function decideRequestError(ctx, payload, next, hooks = {}) {
  const logger = ctx?.logger
  const attempts = hooks.attempts ?? new Map()
  const wait = hooks.sleep ?? sleep

  let prefs
  try {
    prefs = hooks.prefs ?? (await loadRetryPrefs())
  } catch {
    prefs = normalizePrefs(undefined)
  }

  // 1) 先让下游（新版原生重试）决策，并把它给出的任何结论原样传上去。
  let downstream
  try {
    downstream = await next()
  } catch (error) {
    logger?.warn?.(
      'perf-guard: downstream request-error recovery failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    downstream = undefined
  }
  if (downstream !== undefined && downstream !== null) return downstream

  // 2) 下游没表态，才轮到本插件的老策略（传输中断 / 上游空转）。
  if (prefs.retryTransport !== true) return undefined
  const failure = payload?.failure
  const message = String(failure?.message ?? '')
  const code = String(failure?.code ?? '')
  if (!isTransportFailure(failure, undefined, message)) return undefined

  // 3) 新版：该 code 若属于原生策略的职责范围，让位。
  const newContract = hasNativeRetryContract(payload)
  const policy = newContract ? payload.retryPolicy : undefined
  if (newContract && prefs.respectNativePolicy !== false && isNativeOwned(policy, code)) {
    logger?.warn?.(
      'perf-guard: agent retry skipped · native llm-retry owns code %s · %s',
      code || '-',
      message.slice(0, 160),
    )
    return undefined
  }

  // 4) 本插件自己的重试（旧版一直如此；新版只兜原生不接管的 code）。
  const key = String(payload?.provider ?? '-') + ':' + String(payload?.turn ?? '-') + ':' + String(payload?.step ?? '-')
  const used = attempts.get(key) ?? 0
  // 与流级同一套封顶：-1 只是「不受用户设定限制」，仍受安全上限约束。
  if (used >= retryBudgetOf(prefs)) {
    attempts.delete(key)
    return undefined
  }
  // 取消优先：已经取消的回合不该消耗一次重试额度。
  if (payload?.signal?.aborted === true) return undefined
  // 内存已经吃紧时不要再叠加请求：这是把「慢」变成「崩」的那一步。
  if (isUnderHeapPressure()) {
    logger?.warn?.('perf-guard: agent retry skipped · heap pressure above %s', HEAP_PRESSURE_WARN)
    return undefined
  }
  attempts.set(key, used + 1)
  if (attempts.size > 200) attempts.clear()

  // 退避口径与流级保持一致：拥塞类 2s 起步，并读正文里的 retry_after。
  const retryAfterSeconds = retryAfterFromMessage(message)
  const fallbackInfo = {
    status: null,
    retryAfterMs: retryAfterSeconds === null ? null : retryAfterSeconds * 1000,
    busy: CONCURRENCY_PATTERN.test(message) || BUSY_PATTERN.test(message),
  }
  const delay = backoffMsFromPolicy(policy, used, (attempt) => backoffMs(fallbackInfo, attempt))
  recordError({
    at: new Date().toISOString(),
    kind: 'transport',
    status: null,
    code: code || 'UPSTREAM_INTERRUPTED',
    provider: payload?.provider ?? null,
    model: null,
    attempt: used + 1,
    retryAfterMs: null,
    message: message.slice(0, 600),
  })
  logger?.warn?.(
    'perf-guard: agent retry %s/%s in %sms%s · %s · %s',
    used + 1,
    prefs.maxRetries < 0 ? 'inf' : prefs.maxRetries,
    delay,
    newContract ? ' (plugin-owned code)' : '',
    payload?.provider ?? '-',
    message.slice(0, 200),
  )
  await wait(delay, payload?.signal)
  // 等退避期间用户取消：没有真正重试，把额度还回去（loop 随后会 throwIfAborted）。
  if (payload?.signal?.aborted === true) {
    attempts.set(key, used)
    return undefined
  }
  return { kind: 'retry' }
}

/* ------------------------------------------------------------------ */
/*  HTTP 路由                                                          */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])
const DENIED_CHILD_ROUTE = /^child LLM route "[^\r\n]+" is not allowed for this Session(?:; without a recorded model-selection policy, explicit selection is limited to the parent route)?$/
const INVALID_CHILD_FIELDS = /^child LLM (?:`(?:provider|model|reasoning_effort)` must be non-empty|`provider` and `model` must be supplied together|`reasoning_effort` requires both `provider` and `model`; supply both or omit all three fields)$/
const INVALID_DISCOVERY_FIELDS = /^(?:LLM provider "[^\r\n]+" is not allowed for this Session|`(?:provider|model)` must be non-empty|`model` requires `provider`)$/
const DELEGATION_HINT = '性能守卫：不要重放被拒绝的参数。使用默认路由时，同时省略 `provider`、`model` 和 `reasoning_effort`。必须指定模型时，只能从 `list_subagent_models({})` 输出的 Session explicit child routes 中选，不要从宿主模型目录猜测授权。'
const DISCOVERY_HINT = '性能守卫：不要重复相同参数。`list_subagent_models({})` 不带筛选条件；指定提供方或模型时须使用本会话授权的精确 ID。'
const NO_ROUTE_HINT = '性能守卫：这次查询未返回可用的子代理模型。不要反复查询同一条件，也不要猜测路由。'

function withRouteGuidance(decision, result, text, addContext) {
  const content = [...result.content, { type: 'text', text }]
  if (!addContext) return { ...decision, content }
  return {
    ...decision,
    content,
    additionalContexts: [...decision.additionalContexts ?? [], {
      id: randomUUID(), role: 'user', source: { kind: 'perf-guard' },
      content: [{ type: 'text', text }],
    }],
  }
}

/** 追加纠正上下文，不改原始错误、参数或授权裁决。 */
async function withSubagentRouteHint(exec, result, next) {
  const decision = await next()
  const discovery = exec.name === DISCOVERY_TOOL
  if (!discovery && !DELEGATION_TOOLS.has(exec.name)) return decision
  if (decision?.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.signal?.aborted || !Array.isArray(result.content)) return decision

  if (!result.isError) {
    const value = result.value
    return discovery && typeof value === 'string' && /^(?:|\(no (?:LLM providers|advertised models for [^\r\n]+)\))$/.test(value.trim())
      ? withRouteGuidance(decision, result, NO_ROUTE_HINT, true) : decision
  }

  const message = result.error?.message
  if (typeof message !== 'string') return decision
  const args = exec.arguments ?? {}
  if (DELEGATION_TOOLS.has(exec.name) && (DENIED_CHILD_ROUTE.test(message) || INVALID_CHILD_FIELDS.test(message))) {
    return withRouteGuidance(decision, result, DELEGATION_HINT, [args.provider, args.model, args.reasoning_effort].includes(''))
  }
  if (discovery && (DENIED_CHILD_ROUTE.test(message) || INVALID_DISCOVERY_FIELDS.test(message))) {
    return withRouteGuidance(decision, result, DISCOVERY_HINT, [args.provider, args.model].includes(''))
  }
  return decision
}

export function apply(ctx) {
  const disposers = []
  const logger = ctx.logger

  ctx.inject(['tools'], (child) => {
    child.on('tools/execute', modelCatalogMiddleware(child))
    child.on('tools/post-execute', withSubagentRouteHint)
  })

  /** 素材路由：浏览器以 <img>/background 请求，不会带自定义头，只做方法与路径校验。 */
  function assetGuard(handler) {
    return async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      try {
        await handler(req, res)
      } catch {
        sendJson(res, 404, { ok: false, error: 'not found' })
      }
    }
  }

  function guard(methods, handler) {
    return async (req, res) => {
      if (!methods.includes(req.method)) {
        sendJson(res, 405, { ok: false, error: methods.join('/') + ' only' })
        return
      }
      if (req.headers['x-dsh-plugin'] !== 'perf-guard') {
        sendJson(res, 403, { ok: false, error: 'missing x-dsh-plugin header' })
        return
      }
      try {
        // Exact WebServer routes do not inherit the shared /api handshake.
        const connection = ctx.get('connection')
        if (typeof connection?.admit !== 'function') {
          sendJson(res, 503, { ok: false, error: 'DSH owner authentication unavailable' })
          return
        }
        const admission = connection.admit(req)
        if (admission?.peer?.principal?.kind !== 'owner') {
          const status = admission?.rejection === 401 ? 401 : 403
          sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        await handler(req, res)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const assetRoutes = [...ASSET_FILES].map(([name, contentType]) => ({
    kind: 'exact',
    path: ROUTE_PREFIX + '/assets/' + name,
    handler: assetGuard(async (_req, res) => {
      const bytes = await readFile(assetPath(name))
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': bytes.length,
        'cache-control': 'public, max-age=86400',
      })
      res.end(bytes)
    }),
  }))

  const routes = [
    ...assetRoutes,
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/health',
      handler: guard(['GET'], async (_req, res) => {
        sendJson(res, 200, { ok: true, version: VERSION })
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/stats',
      handler: guard(['GET'], async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          host: hostSnapshot(),
          residentSessions: residentSessionStats(ctx.get('agents')),
          sessions: await collectSessionStats(),
          retry: await loadRetryPrefs(),
          contract: {
            nativeRetryAvailable: nativeRetry,
            // 新契约：先 await next() 让原生重试表态，再决定是否自行重试。
            requestError: 'waterfall-chain',
            emitChars: 'text|delta',
            truncation: 'max-tokens|stopReason',
          },
          thinking: { stripThinking: (await loadRetryPrefs()).stripThinking, strippedChars: thinkingStrippedChars },
          errors: recentErrors.slice(0, 20),
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/retry',
      handler: guard(['GET', 'POST'], async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, retry: await loadRetryPrefs(), statuses: WATCHED_STATUSES })
          return
        }
        const body = await readBody(req)
        const retry = await saveRetryPrefs(body)
        sendJson(res, 200, { ok: true, retry })
      }),
    },
  ]

  // 新版 llm 服务是否暴露 providerRetryPolicy（0.2.2-rc.1+）。仅用于日志与自检展示：
  // 真正的决策依据是 agent/request-error 载荷里的 retryPolicy 键。
  let nativeRetry = false

  try {
    for (const route of routes) {
      disposers.push(ctx.webServer.register(route))
    }
  } catch (error) {
    logger?.warn?.('perf-guard: route registration failed: %s', error instanceof Error ? error.message : String(error))
  }

  // 拦截 llm/stream：错误日志 + 自动重试（未吐出内容时才重试）。
  ctx.inject(['llm'], (child) => {
    try {
      nativeRetry = typeof child.llm?.providerRetryPolicy === 'function'
    } catch {
      nativeRetry = false
    }
    logger?.info?.(
      'perf-guard: LLM 契约 %s（%s）',
      nativeRetry ? 'new (0.2.2-rc.1+)' : 'legacy (<=0.2.1-rc.4)',
      nativeRetry ? 'llm.providerRetryPolicy 存在，原生 llm-retry 可能已在同一 waterfall 上' : '无 providerRetryPolicy',
    )
    const off = child.on('llm/stream', (options, next) => withRetryAndLogging(child, options, next))
    child.effect(() => () => off())
    logger?.info?.('perf-guard: llm/stream middleware attached')

    // agent/request-error：宿主把「上游输出中断」这类失败包成 turn 级错误，
    // llm/stream 里已经看不到，只能在这一层要求重试。决策逻辑见 decideRequestError
    //（新契约下先让下游原生 llm-retry 表态，再按本插件策略兜底）。
    const attempts = new Map()
    const offAgent = child.on('agent/request-error', (payload, next) =>
      decideRequestError(child, payload, next, { attempts }))
    child.effect(() => () => offAgent())
    logger?.info?.('perf-guard: agent/request-error retry attached (native-aware chain)')
  })

  let warned = false
  let heapWarned = false
  const timer = setInterval(() => {
    try {
      const memory = process.memoryUsage()
      const rss = memory.rss
      if (rss >= RSS_WARN_BYTES && !warned) {
        warned = true
        logger?.warn?.('perf-guard: host RSS %.1f GB - 大内存会话可能导致进程崩溃，建议清理历史会话', rss / 1024 ** 3)
      } else if (rss < RSS_WARN_BYTES * 0.75) {
        warned = false
      }

      // 堆压力：真正决定「卡不卡」的是这个。给一条能直接照做的配方，而不是只报数字。
      const limit = getHeapStatistics().heap_size_limit
      if (limit > 0) {
        const pressure = memory.heapUsed / limit
        if (pressure >= HEAP_PRESSURE_WARN && !heapWarned) {
          heapWarned = true
          const suggested = Math.max(8192, Math.ceil((limit / 1024 ** 3) * 2))
          logger?.warn?.(
            'perf-guard: V8 堆已用 %.0f%%（%.2f/%.2f GB）- major GC 会开始频繁打断长会话。' +
              '堆上限启动后不可改；如需更大余量，用 NODE_OPTIONS=--max-old-space-size=%d 重启 DSH NEXT。',
            pressure * 100,
            memory.heapUsed / 1024 ** 3,
            limit / 1024 ** 3,
            suggested,
          )
        } else if (pressure < HEAP_PRESSURE_WARN * 0.85) {
          heapWarned = false
        }
      }
    } catch {
      // 采样失败不影响主流程。
    }
  }, MONITOR_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  disposers.push(() => clearInterval(timer))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 卸载失败不影响宿主退出。
      }
    }
  })

  logger?.info?.('perf-guard: mounted v%s at %s', VERSION, ROUTE_PREFIX)
}

/** 仅供测试：错误分类、退避与偏好归一化。 */
export const __internals = {
  statusOf,
  backoffMs,
  normalizePrefs,
  normalizeAndMergePrefs: (current, patch) => normalizePrefs({
    ...current,
    ...patch,
    statuses: { ...(current?.statuses ?? {}), ...(patch?.statuses ?? {}) },
  }),
  withRetryAndLogging,
  isTransportFailure,
  shouldRetry,
  retryBudgetOf,
  isUnderHeapPressure,
  SAFETY_MAX_ATTEMPTS,
  PERMANENT_STATUSES,
  retryAfterFromMessage,
  createThinkingFilter,
  createThinkingSplitter,
  createThinkingRouter,
  stripThinkingText,
  resetPrefsCache,
  hasNativeRetryContract,
  isNativeOwned,
  backoffMsFromPolicy,
  decideRequestError,
  withSubagentRouteHint,
  residentSessionStats,
}

