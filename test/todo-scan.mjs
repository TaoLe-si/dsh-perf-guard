import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { __internals } from '../index.js'
const root = 'C:/Users/Administrator/.dsh/sessions'
let hits = 0
let checked = 0
for (const ws of readdirSync(root)) {
  const wp = join(root, ws)
  if (!statSync(wp).isDirectory()) continue
  for (const s of readdirSync(wp)) {
    const d = join(wp, s)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl.zstd')) continue
      const full = join(d, f)
      const size = statSync(full).size
      if (size > 20 * 1024 * 1024) continue
      checked += 1
      const text = zstdDecompressSync(readFileSync(full)).toString('utf8')
      if (!text.includes('todo_write') && !text.includes('"todos"')) continue
      const todos = __internals.extractTodos(text.split(/\r?\n/))
      if (todos && todos.length > 0) {
        hits += 1
        console.log('HIT', s, size, '->', todos.length, 'items')
        console.log(JSON.stringify(todos.slice(0, 2)))
        if (hits >= 2) process.exit(0)
      }
    }
  }
}
console.log('checked', checked, 'logs; hits', hits)
