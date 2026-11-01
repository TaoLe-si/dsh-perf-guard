import { readFileSync, writeFileSync } from 'node:fs'
const path = 'client.js'
let src = readFileSync(path, 'utf8')

// 1) 删除 atelier 注入块
src = src.replace(/    const ATELIER_ID = '[^']*'\n\n    \/\*\*[\s\S]*?\n    function injectStylesheet\(\) \{\n      if \(typeof document === 'undefined'\) return\n      injectAtelier\(\)\n/, "    function injectStylesheet() {\n      if (typeof document === 'undefined') return\n")

// 2) 删除所有主题覆盖的 CSS 行
src = src
  .split('\n')
  .filter((line) => !line.includes('data-perfguard-polish'))
  .join('\n')

// 3) 删除 polish 偏好、dataset 与设置项
src = src.replace(/^\s*polish: true,\n/m, '')
src = src.replace(/^\s*root\.dataset\.perfguardPolish = .*\n/m, '')
src = src.replace(/^\s*\['polish',[^\n]*\n/m, '')

writeFileSync(path, src)
console.log('remaining polish refs:', (src.match(/polish/gi) || []).length)
console.log('has injectAtelier:', src.includes('injectAtelier'))
