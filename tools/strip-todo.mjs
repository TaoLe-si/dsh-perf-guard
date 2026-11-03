import { readFileSync, writeFileSync } from 'node:fs'

function cut(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker)
  if (start < 0) { console.log('MISS start', label); return text }
  const end = text.indexOf(endMarker, start + startMarker.length)
  if (end < 0) { console.log('MISS end', label); return text }
  console.log('cut', label, end - start, 'chars')
  return text.slice(0, start) + text.slice(end)
}

/* ---------- client ---------- */
let client = readFileSync('client.js', 'utf8')
// 注释 + todoStore ... TodoPanel 结束（下一个「中键关闭标签页」注释之前）
let startIdx = client.indexOf('    const todoStore = {')
if (startIdx > 0) {
  const commentIdx = client.lastIndexOf('    /**', startIdx)
  const between = client.slice(commentIdx, startIdx)
  if (commentIdx > 0 && between.includes('待办')) startIdx = commentIdx
}
const endIdx = client.indexOf('    /** 中键关闭标签页', startIdx)
if (startIdx > 0 && endIdx > startIdx) {
  console.log('cut client todo block', endIdx - startIdx, 'chars')
  client = client.slice(0, startIdx) + client.slice(endIdx)
} else {
  console.log('MISS client todo block', startIdx, endIdx)
}
client = client.replace(/^\s*ctx\.effect\(\(\) => installTodoSync\(\)\)\n/m, '')
const slotStart = client.indexOf("      ctx.slots.inject('shell.overlay'")
if (slotStart > 0) {
  const slotEnd = client.indexOf('\n', client.indexOf(')', client.indexOf('ctx.slots.register({', slotStart)))
  // 直接删到该语句块结束的 ')' 行
  const blockEnd = client.indexOf('\n      )\n', slotStart)
  if (blockEnd > slotStart) {
    console.log('cut overlay slot', blockEnd - slotStart, 'chars')
    client = client.slice(0, slotStart) + client.slice(blockEnd + '\n      )\n'.length)
  } else console.log('MISS overlay slot end')
} else console.log('MISS overlay slot')
writeFileSync('client.js', client)

/* ---------- host ---------- */
let host = readFileSync('index.js', 'utf8')
host = cut(host, '/* ------------------------------------------------------------------ */\n/*  待办（todo_write）常驻', '/* ------------------------------------------------------------------ */\n/*  HTTP 路由', 'host todo section')
host = host.replace(/^import \{ zstdDecompressSync \} from 'node:zlib'\n/m, '')
host = host.replace(/, extractTodos \}/, ' }')
// 删除 /todos 路由对象
const routeStart = host.indexOf("    {\n      kind: 'exact',\n      path: ROUTE_PREFIX + '/todos',")
if (routeStart > 0) {
  const routeEnd = host.indexOf("    {\n      kind: 'exact',\n      path: ROUTE_PREFIX + '/retry',", routeStart)
  if (routeEnd > routeStart) {
    console.log('cut todos route', routeEnd - routeStart, 'chars')
    host = host.slice(0, routeStart) + host.slice(routeEnd)
  } else console.log('MISS route end')
} else console.log('MISS route start')
writeFileSync('index.js', host)
console.log('remaining todo refs: client', (client.match(/todo/gi) || []).length, 'host', (host.match(/todo/gi) || []).length)
