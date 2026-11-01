import { readFileSync, writeFileSync } from 'node:fs'
const path = 'client.js'
let src = readFileSync(path, 'utf8')
const before = src.length
// 只删全局动效/入场 CSS：role=menu 的 opacity 动画会让浮层看起来半透明
src = src.split('\n').filter((line) => !/data-perfguard-(motion|reveal)/.test(line)).join('\n')
// 去掉调用（函数保留但不再启用）
src = src.replace("      ctx.effect(() => installMotion(() => readPrefs().motion))\n", '')
// 去掉对应开关
src = src.replace(/^\s*\['motion',[^\n]*\n/m, '')
src = src.replace(/^\s*\['smoothReveal',[^\n]*\n/m, '')
writeFileSync(path, src)
console.log('shrunk', before - src.length)
