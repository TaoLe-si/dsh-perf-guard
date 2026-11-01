import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { __internals } from '../index.js'
const root = 'C:/Users/Administrator/.dsh/sessions'
let best = null
for (const ws of readdirSync(root)) {
  const p = join(root, ws)
  if (!statSync(p).isDirectory()) continue
  for (const s of readdirSync(p)) {
    const d = join(p, s)
    if (!statSync(d).isDirectory()) continue
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl.zstd')) continue
      const full = join(d, f)
      const size = statSync(full).size
      if (!best || size > best.size) best = { full, size }
    }
  }
}
const text = zstdDecompressSync(readFileSync(best.full)).toString('utf8')
const todos = __internals.extractTodos(text.split(/\r?\n/))
console.log('log', best.size, 'bytes; todos:', todos ? todos.length : 'none')
if (todos) console.log(JSON.stringify(todos.slice(0, 3)))
