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
 * 刻意不做的事：不裁剪、不重写任何 session 日志。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const VERSION = '1.1.1'
const ROUTE_PREFIX = '/api/perf-guard'
const SESSION_SCAN_TTL_MS = 60 * 1000
const MONITOR_INTERVAL_MS = 30 * 1000
const RSS_WARN_BYTES = 2 * 1024 ** 3
const MAX_LOGGED_FILES = 5000
/** 用户可配置重试的状态码。 */
const WATCHED_STATUSES = ['400', '401', '402', '403', '429', '502', '503']
const DEFAULT_RETRY_PREFS = {
  logErrors: true,
  maxRetries: 2,
  /** 传输中断 / 流被截断（无 HTTP 状态码）是否重试。 */
  retryTransport: true,
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
/** UI 装饰素材：由 tools/generate-assets.mjs 生成的 PNG。 */
const ASSET_FILES = new Map([
  ['aurora.png', 'image/png'],
  ['sprig.png', 'image/png'],
  ['halo.png', 'image/png'],
  ['atelier.css', 'text/css; charset=utf-8'],
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

function normalizePrefs(raw) {
  const prefs = {
    logErrors: typeof raw?.logErrors === 'boolean' ? raw.logErrors : DEFAULT_RETRY_PREFS.logErrors,
    // -1 = 不设上限；其余 0–50。用户可以在设置页选择「不限」。
    maxRetries: Number.isInteger(raw?.maxRetries) && raw.maxRetries >= -1 ? Math.min(50, raw.maxRetries) : DEFAULT_RETRY_PREFS.maxRetries,
    retryTransport: typeof raw?.retryTransport === 'boolean' ? raw.retryTransport : DEFAULT_RETRY_PREFS.retryTransport,
    statuses: { ...DEFAULT_RETRY_PREFS.statuses },
  }
  for (const status of WATCHED_STATUSES) {
    if (typeof raw?.statuses?.[status] === 'boolean') prefs.statuses[status] = raw.statuses[status]
  }
  return prefs
}

async function loadRetryPrefs(force = false) {
  if (retryPrefs !== null && !force) return retryPrefs
  try {
    const raw = JSON.parse(await readFile(prefsPath(), 'utf8'))
    retryPrefs = normalizePrefs(raw)
  } catch {
    retryPrefs = normalizePrefs(undefined)
  }
  return retryPrefs
}

async function saveRetryPrefs(input) {
  const next = normalizePrefs(input)
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

function hostSnapshot() {
  const memory = process.memoryUsage()
  return {
    pid: process.pid,
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
  return RETRY_LATER_PATTERN.test(text) && UPSTREAM_CONTEXT_PATTERN.test(text)
}

/** 无 HTTP 状态码的传输层/截断/上游空转类失败。 */
function isTransportFailure(failure, error, message) {
  const code = String((failure && failure.code) || (error && error.code) || '')
  if (code === 'ABORTED' || code === 'CANCELLED') return false
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
function shouldRetry({ prefs, info, emitted, attemptNumber, aborted }) {
  const key = info.status === null ? null : String(info.status)
  const statusEnabled = key !== null && prefs.statuses[key] === true
  // 网关类 5xx 常常是在流到一半时返回的：正文是一整段错误 JSON，半截输出没有价值。
  // 仅在「截断 / 传输中断重试」开关打开时允许丢弃已输出内容重来；
  // 429 与 4xx 保持既有语义（已输出后不重试），避免把限流/参数错误打成循环。
  const partialRetryable = emitted === false
    || (prefs.retryTransport === true && key !== null && PARTIAL_RETRY_STATUSES.has(key))
  const statusRetry = statusEnabled && partialRetryable
  const transportRetry = info.kind === 'transport' && prefs.retryTransport === true
  return (statusRetry || transportRetry)
    && (prefs.maxRetries < 0 || attemptNumber <= prefs.maxRetries)
    && aborted !== true
}

function backoffMs(info, attempt) {
  if (info.retryAfterMs !== null && info.retryAfterMs > 0) return Math.min(info.retryAfterMs, 30_000)
  const base = info.status === 429 ? 2000 : 800
  return Math.min(base * 2 ** attempt, 15_000)
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
async function* withRetryAndLogging(ctx, options, next) {
  const prefs = await loadRetryPrefs()
  for (let attempt = 0; ; attempt += 1) {
    const attemptNumber = attempt + 1
    let emitted = false
    let emittedChars = 0
    let sawFinish = false
    let pending = null
    try {
      const stream = await next()
      for await (const chunk of stream) {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
          sawFinish = true
          const stopReason = String(chunk.reason?.stopReason ?? chunk.reason?.reason ?? chunk.reason?.kind ?? '')
          if (chunk.reason?.kind === 'error') {
            pending = { failure: chunk.reason.failure, chunk }
            break
          }
          if (chunk.reason?.kind === 'aborted') {
            yield chunk
            return
          }
          // 输出被截断（length / max_tokens）时，pi-ai 仍按正常结束上报，
          // 只能靠 finish 的 stopReason 识别；重试前先在日志里留下证据。
          if (/length|max_tokens|max_output/i.test(stopReason)) {
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
          yield chunk
          continue
        }
        emitted = true
        emittedChars += typeof chunk?.delta === 'string' ? chunk.delta.length : 0
        yield chunk
      }
    } catch (error) {
      pending = { failure: undefined, error }
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

    const retryable = shouldRetry({
      prefs,
      info,
      emitted,
      attemptNumber,
      aborted: options?.signal?.aborted === true,
    })

    if (!retryable) {
      if (pending.chunk !== undefined) {
        // 截断的 finish 仍然要交给上层，否则这一轮会没有收尾事件。
        yield pending.chunk
        return
      }
      if (pending.failure?.code === 'TRANSPORT' && pending.error === undefined) {
        // 静默截断：交给上层结束本轮，不抛错（协议里没有对应 chunk 形态）。
        return
      }
      throw pending.error
    }

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

export function apply(ctx) {
  const disposers = []
  const logger = ctx.logger

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
          sessions: await collectSessionStats(),
          retry: await loadRetryPrefs(),
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

  try {
    for (const route of routes) {
      disposers.push(ctx.webServer.register(route))
    }
  } catch (error) {
    logger?.warn?.('perf-guard: route registration failed: %s', error instanceof Error ? error.message : String(error))
  }

  // 拦截 llm/stream：错误日志 + 自动重试（未吐出内容时才重试）。
  ctx.inject(['llm'], (child) => {
    const off = child.on('llm/stream', (options, next) => withRetryAndLogging(child, options, next))
    child.effect(() => () => off())
    logger?.info?.('perf-guard: llm/stream middleware attached')

    // agent/request-error：宿主把「上游输出中断」这类失败包成 turn 级错误，
    // llm/stream 里已经看不到，只能在这一层要求重试。
    const attempts = new Map()
    const offAgent = child.on('agent/request-error', async (payload, next) => {
      try {
        const prefs = await loadRetryPrefs()
        if (!prefs.retryTransport) return next()
        const failure = payload?.failure
        const message = String(failure?.message ?? '')
        const code = String(failure?.code ?? '')
        if (!isTransportFailure(failure, undefined, message)) return next()
        const key = String(payload?.provider ?? '-') + ':' + String(payload?.turn ?? '-') + ':' + String(payload?.step ?? '-')
        const used = attempts.get(key) ?? 0
        if (prefs.maxRetries >= 0 && used >= prefs.maxRetries) {
          attempts.delete(key)
          return next()
        }
        attempts.set(key, used + 1)
        if (attempts.size > 200) attempts.clear()
        const delay = Math.min(800 * 2 ** used, 15_000)
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
        child.logger?.warn?.(
          'perf-guard: agent retry %s/%s in %sms · %s · %s',
          used + 1,
          prefs.maxRetries < 0 ? 'inf' : prefs.maxRetries,
          delay,
          payload?.provider ?? '-',
          message.slice(0, 200),
        )
        await sleep(delay, payload?.signal)
        return { kind: 'retry' }
      } catch (error) {
        child.logger?.warn?.('perf-guard: agent retry decision failed: %s', error instanceof Error ? error.message : String(error))
        return next()
      }
    })
    child.effect(() => () => offAgent())
    logger?.info?.('perf-guard: agent/request-error retry attached')
  })

  let warned = false
  const timer = setInterval(() => {
    try {
      const rss = process.memoryUsage().rss
      if (rss >= RSS_WARN_BYTES && !warned) {
        warned = true
        logger?.warn?.('perf-guard: host RSS %.1f GB - 大内存会话可能导致进程崩溃，建议清理历史会话', rss / 1024 ** 3)
      } else if (rss < RSS_WARN_BYTES * 0.75) {
        warned = false
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
export const __internals = { statusOf, backoffMs, normalizePrefs, withRetryAndLogging, isTransportFailure, shouldRetry, retryAfterFromMessage }

