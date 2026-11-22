import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/* ---------- 最小 DOM（只覆盖 installHoverIntent 用到的那部分） ---------- */
class FakeElement {
  constructor(inTree) {
    this.inTree = inTree === true
    this.isConnected = true
    this.hovered = true
  }
  closest(selector) { return this.inTree && selector === '[role="tree"]' ? this : null }
  matches() { return this.hovered }
  dispatchEvent(event) {
    this.dispatched = this.dispatched || []
    this.dispatched.push(event.type)
    // 真实 DOM 里事件会冒泡到 document：合成事件必须走同一条路，
    // 否则测不到「补发后能到达 React」这个关键行为。
    const shared = {
      ...event,
      target: this,
      stopped: false,
      stopImmediatePropagation() { this.stopped = true },
      stopPropagation() { this.stopped = true },
    }
    for (const handler of listeners.get(event.type) ?? []) handler(shared)
    if (!shared.stopped && (event.type === 'pointerover' || event.type === 'pointerout')) reachedReact.push(this)
    return true
  }
}

const listeners = new Map()
const reachedReact = []
const replayed = []
const timers = new Map()
let clock = 0
let nextTimer = 0

function advance(ms) {
  clock += ms
  for (const [id, { at, fn }] of [...timers]) {
    if (at > clock) continue
    timers.delete(id)
    fn()
  }
}

globalThis.Element = FakeElement
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.PointerEvent = class { constructor(type, init) { this.type = type; this.relatedTarget = init?.relatedTarget ?? null; replayed.push(type) } }
globalThis.MouseEvent = class { constructor(type, init) { this.type = type; this.relatedTarget = init?.relatedTarget ?? null; replayed.push(type) } }

const root = {
  dataset: {},
  setAttribute() {},
  removeAttribute() {},
  getAttribute() { return null },
  querySelectorAll: () => [],
  matches: () => false,
}
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
  },
  setTimeout(fn, delay) {
    timers.set(++nextTimer, { at: clock + delay, fn })
    return nextTimer
  },
  clearTimeout(id) { timers.delete(id) },
  setInterval,
  clearInterval,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
}
let captured = null
globalThis.window.__ModuleLoader__ = { load: (definition) => { captured = definition } }
globalThis.document = {
  documentElement: root,
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type)
    if (!list) return
    listeners.set(type, list.filter((item) => item !== handler))
  },
  getElementsByTagName: () => ({ length: 100 }),
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.performance = { now: () => clock }

await import(new URL('../client.js', import.meta.url).href)
if (!captured) throw new Error('模块没有被加载')
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (value) => [value, () => {}],
  useEffect() {},
  useCallback: (fn) => fn,
  memo: (fn) => fn,
}
const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const installHoverIntent = mod.__internals.installHoverIntent

/** 模拟一次指针事件：走 document 捕获阶段的监听，未被打断就算「到达 React」。 */
function fire(type, target, props = {}) {
  const event = {
    type,
    target,
    buttons: 0,
    timeStamp: Date.now(),
    stopped: false,
    stopImmediatePropagation() { this.stopped = true },
    stopPropagation() { this.stopped = true },
    ...props,
  }
  for (const handler of listeners.get(type) ?? []) handler(event)
  // 只统计「悬停进入/离开」类事件：pointermove 本来就不该被拦。
  if (!event.stopped && (type === 'pointerover' || type === 'pointerout')) reachedReact.push(target)
  return event
}

test('悬停防抖：移动中的 pointerover 不会到达 React', async () => {
  listeners.clear()
  reachedReact.length = 0
  const off = installHoverIntent(() => true)
  const rowA = new FakeElement(true)
  fire('pointermove', rowA)
  fire('pointerover', rowA)
  assert.equal(reachedReact.length, 0, '移动中必须被拦下')
  off()
})

test('悬停防抖：移动推迟的回调不丢失待处理目标', (t) => {
  listeners.clear()
  reachedReact.length = 0
  replayed.length = 0
  t.after(installHoverIntent(() => true))
  const rowA = new FakeElement(true)
  fire('pointermove', rowA)
  fire('pointerover', rowA)
  assert.equal(reachedReact.length, 0)
  advance(120)
  fire('pointermove', rowA)
  advance(20) // 第一次到期时，最后一次移动只过去 20ms。
  assert.equal(reachedReact.length, 0)
  advance(119)
  assert.equal(reachedReact.length, 0)
  advance(1)
  assert.deepEqual(reachedReact, [rowA])
  assert.deepEqual(replayed, ['pointerover', 'mouseover'])
})

test('悬停防抖：按住鼠标键时一律放行（拖动多选依赖 pointerenter）', () => {
  listeners.clear()
  reachedReact.length = 0
  const off = installHoverIntent(() => true)
  const rowB = new FakeElement(true)
  fire('pointermove', rowB)
  fire('pointerover', rowB, { buttons: 1 })
  assert.equal(reachedReact.length, 1, '拖动中不能拦')
  off()
})

test('悬停防抖：列表之外的元素不受影响', () => {
  listeners.clear()
  reachedReact.length = 0
  const off = installHoverIntent(() => true)
  const outside = new FakeElement(false)
  fire('pointermove', outside)
  fire('pointerover', outside)
  assert.equal(reachedReact.length, 1, '树外事件必须原样通过')
  off()
})

test('悬停防抖：关掉开关后完全不拦截', () => {
  listeners.clear()
  reachedReact.length = 0
  const off = installHoverIntent(() => false)
  const rowC = new FakeElement(true)
  fire('pointermove', rowC)
  fire('pointerover', rowC)
  assert.equal(reachedReact.length, 1)
  off()
})
