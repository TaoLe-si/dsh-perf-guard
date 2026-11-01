/**
 * 通过 CDP 截取 DSH 真实界面，并可选执行一段脚本。
 * 用法：node tools/cdp.mjs <输出png> [要执行的JS表达式]
 */
import { writeFile } from 'node:fs/promises'

const out = process.argv[2] || 'shot.png'
const expression = process.argv[3]
const endpoint = process.env.CDP || 'http://127.0.0.1:9333'

const targets = await (await fetch(endpoint + '/json/list')).json()
const page = targets.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://')) || targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => [t.type, t.url])))

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const messageId = ++id
    pending.set(messageId, { resolve, reject })
    ws.send(JSON.stringify({ id: messageId, method, params }))
  })
}
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  const slot = pending.get(data.id)
  if (!slot) return
  pending.delete(data.id)
  if (data.error) slot.reject(new Error(JSON.stringify(data.error)))
  else slot.resolve(data.result)
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

await send('Page.enable')
const evalFile = process.env.CDP_EVAL_FILE
const finalExpression = evalFile ? await (await import('node:fs/promises')).readFile(evalFile, 'utf8') : expression
if (finalExpression) {
  const result = await send('Runtime.evaluate', { expression: finalExpression, returnByValue: true, awaitPromise: true })
  console.log('EVAL', JSON.stringify(result.result?.value ?? result.result?.description ?? null).slice(0, 2000))
}
await new Promise((resolve) => setTimeout(resolve, 300))
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
await writeFile(out, Buffer.from(shot.data, 'base64'))
console.log('saved', out)
ws.close()