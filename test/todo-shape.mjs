import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const root = 'C:/Users/Administrator/.dsh/sessions'
let shown = 0
for (const ws of readdirSync(root)) {
  const wp = join(root, ws)
  if (!statSync(wp).isDirectory()) continue
  for (const s of readdirSync(wp)) {
    const d = join(wp, s)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl.zstd')) continue
      const full = join(d, f)
      if (statSync(full).size > 30 * 1024 * 1024) continue
      const text = zstdDecompressSync(readFileSync(full)).toString('utf8')
      if (!text.includes('todo/write')) continue
      const line = text.split(/\r?\n/).find((l) => l.includes('todo/write'))
      console.log('FILE', s)
      console.log(line.slice(0, 900))
      shown += 1
      if (shown >= 2) process.exit(0)
    }
  }
}
console.log('no todo/write found')
