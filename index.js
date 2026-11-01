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

const VERSION = '0.7.1'
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
const ASSET_FILES = new Set(['aurora.png', 'sprig.png', 'halo.png'])

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

const TRANSPORT_PATTERN = /TRANSPORT|STREAM|TRUNCATED|terminated|Connection error|stream ended|socket hang up|ECONNRESET|other side closed|premature close|unexpected end/i

/** 无 HTTP 状态码的传输层/截断类失败。 */
function isTransportFailure(failure, error, message) {
  const code = String((failure && failure.code) || (error && error.code) || '')
  if (code === 'ABORTED' || code === 'CANCELLED') return false
  if (TRANSPORT_PATTERN.test(code)) return true
  return TRANSPORT_PATTERN.test(message || messageOf(failure, error))
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
    retryAfterMs: failure && Number.isFinite(failure.providerRetryAfterMs) ? failure.providerRetryAfterMs : null,
    message: message.slice(0, 600),
  }
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

    const key = info.status === null ? null : String(info.status)
    const httpRetry = key !== null && prefs.statuses[key] === true && !emitted
    // 传输中断 / 截断：允许在已输出部分内容后重试（整段重来），由用户开关控制。
    const transportRetry = info.kind === 'transport' && prefs.retryTransport === true
    const retryable = (httpRetry || transportRetry)
      && (prefs.maxRetries < 0 || attemptNumber <= prefs.maxRetries)
      && options?.signal?.aborted !== true

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

  const assetRoutes = [...ASSET_FILES].map((name) => ({
    kind: 'exact',
    path: ROUTE_PREFIX + '/assets/' + name,
    handler: assetGuard(async (_req, res) => {
      const bytes = await readFile(assetPath(name))
      res.writeHead(200, {
        'content-type': 'image/png',
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
export const __internals = { statusOf, backoffMs, normalizePrefs, withRetryAndLogging, isTransportFailure }

