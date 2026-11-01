/**
 * 生成 UI 装饰素材（SVG → PNG）。
 *
 * 设计语言参考「柔和高级感」：低饱和鼠尾草绿 / 奶油白 / 藕粉，
 * 大半径、软阴影、细描边植物线稿。所有素材都是透明底，
 * 由插件通过 /api/perf-guard/assets/<name>.png 提供。
 *
 * 用法：node tools/generate-assets.mjs  （需要 sharp；本机从 asar 提取的依赖里加载）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'assets')

/** sharp 可能来自本地安装，也可能来自 DSH 的 app.asar 解包目录。 */
function loadSharp() {
  const require = createRequire(import.meta.url)
  const candidates = ['sharp', 'D:/dsh-asar/node_modules/sharp']
  for (const id of candidates) {
    try {
      return require(id)
    } catch {
      // 试下一个
    }
  }
  throw new Error('sharp not found; install it or keep /d/dsh-asar extracted')
}

const sharp = loadSharp()

const aurora = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="700" viewBox="0 0 1600 700">
  <defs>
    <radialGradient id="a" cx="0.78" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#A8C3B4" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="#A8C3B4" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#A8C3B4" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b" cx="0.12" cy="0.85" r="0.65">
      <stop offset="0" stop-color="#E9D3C6" stop-opacity="0.5"/>
      <stop offset="0.5" stop-color="#E9D3C6" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#E9D3C6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="c" cx="0.55" cy="0.42" r="0.55">
      <stop offset="0" stop-color="#CFE3D9" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#CFE3D9" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="28"/></filter>
  </defs>
  <g filter="url(#soft)">
    <rect width="1600" height="700" fill="url(#a)"/>
    <rect width="1600" height="700" fill="url(#b)"/>
    <rect width="1600" height="700" fill="url(#c)"/>
  </g>
</svg>`

const sprig = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs>
    <linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C9B8B"/>
      <stop offset="1" stop-color="#4E6A5D"/>
    </linearGradient>
    <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8AA79A"/>
      <stop offset="1" stop-color="#5B7A6B"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke="url(#stem)" stroke-width="3" stroke-linecap="round">
    <path d="M320 600 C 300 470 300 330 340 170"/>
    <path d="M318 520 C 262 470 232 420 226 366"/>
    <path d="M322 430 C 380 384 412 336 418 282"/>
    <path d="M330 336 C 288 292 268 246 266 200"/>
  </g>
  <g fill="url(#leaf)" fill-opacity="0.5" stroke="#4E6A5D" stroke-opacity="0.45" stroke-width="1.2">
    <path d="M226 366 C 196 330 200 286 232 258 C 262 286 258 332 226 366 Z"/>
    <path d="M418 282 C 452 250 452 206 424 176 C 392 206 390 250 418 282 Z"/>
    <path d="M266 200 C 240 172 240 136 264 112 C 292 138 292 174 266 200 Z"/>
    <path d="M340 170 C 316 128 322 84 352 58 C 384 92 378 138 340 170 Z"/>
  </g>
</svg>`

const halo = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#A8C3B4" stop-opacity="0.85"/>
      <stop offset="0.55" stop-color="#E9D3C6" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#8AA79A" stop-opacity="0.2"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <circle cx="256" cy="256" r="176" fill="none" stroke="url(#ring)" stroke-width="26" filter="url(#blur)" stroke-opacity="0.55"/>
  <circle cx="256" cy="256" r="176" fill="none" stroke="url(#ring)" stroke-width="2.5" stroke-opacity="0.9" stroke-dasharray="3 10" stroke-linecap="round"/>
</svg>`

await mkdir(outDir, { recursive: true })
const jobs = [
  ['aurora', aurora, { width: 1600 }],
  ['sprig', sprig, { width: 640 }],
  ['halo', halo, { width: 512 }],
]
for (const [name, svg, options] of jobs) {
  await writeFile(join(outDir, name + '.svg'), svg, 'utf8')
  const png = await sharp(Buffer.from(svg)).resize(options).png({ compressionLevel: 9 }).toBuffer()
  await writeFile(join(outDir, name + '.png'), png)
  console.log(name + '.png', png.length + ' bytes')
}
