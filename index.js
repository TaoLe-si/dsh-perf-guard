/**
 * dsh-perf-guard — 宿主半（Node / cordis 插件）。
 *
 * 只做"观测 + 诊断"，不碰会话数据：
 *  - 每 30s 采样宿主进程内存，超过阈值打 warn（提前发现 OOM 风险）；
 *  - 扫描 <DSH_HOME>/sessions 下的会话日志体积，找出真正撑爆内存的巨型会话；
 *  - 通过 /api/perf-guard/* 把上述数据交给浏览器半展示。
 *
 * 刻意不做的事：不裁剪、不重写任何 session 日志。历史数据属于用户，
 * 需要瘦身时由用户自己决定（设置页只给出体积排行与建议）。
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

const VERSION = '0.3.0'
const ROUTE_PREFIX = '/api/perf-guard'
/** 会话目录扫描结果缓存：目录很大时避免每次打开设置页都重新遍历。 */
const SESSION_SCAN_TTL_MS = 60 * 1000
/** 宿主内存采样间隔。 */
const MONITOR_INTERVAL_MS = 30 * 1000
/** 超过该 RSS 时打 warn，提示用户关注（不是硬限制）。 */
const RSS_WARN_BYTES = 2 * 1024 ** 3
/** 单次扫描最多收集的日志条数上限，防止异常目录把采样拖死。 */
const MAX_LOGGED_FILES = 5000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function isSessionLog(name) {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')
}

/** 递归收集会话日志文件（session 目录层级固定，深度上限 3 已足够）。 */
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

/** 会话目录名即 sessionId，取父目录最后一段。 */
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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function apply(ctx) {
  const disposers = []
  const logger = ctx.logger

  /** 只读路由仍要求自定义头，避免被跨站页面直接读取。 */
  function guard(handler) {
    return async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
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

  const routes = [
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/health',
      handler: guard(async (_req, res) => {
        sendJson(res, 200, { ok: true, version: VERSION })
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/stats',
      handler: guard(async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          host: hostSnapshot(),
          sessions: await collectSessionStats(),
        })
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
