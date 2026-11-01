import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const sessionId = 'session-20ba250a-bc20-42d5-bd9b-45c1d50044d5'
const root = 'C:/Users/Administrator/.dsh/sessions'
for (const ws of readdirSync(root)) {
  const d = join(root, ws, sessionId)
  let files = []
  try { files = readdirSync(d) } catch { continue }
  for (const f of files) {
    if (!f.endsWith('.zstd')) continue
    const full = join(d, f)
    const size = statSync(full).size
    const text = zstdDecompressSync(readFileSync(full)).toString('utf8')
    console.log('FILE', f, size, 'bytes, lines', text.split(/\r?\n/).length)
    const idx = text.toLowerCase().indexOf('todo')
    console.log('first todo at', idx)
    if (idx >= 0) console.log(text.slice(Math.max(0, idx - 200), idx + 600).replace(/\n/g, '\n'))
    else {
      const keys = [...new Set(text.match(/"[a-zA-Z_]+":/g) || [])].slice(0, 25)
      console.log('sample keys', keys.join(' '))
    }
  }
}
