import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/* ---------- 最小 DOM ---------- */
class FakeElement {
  constructor(props = {}) {
    Object.assign(this, props)
    this.isConnected = true
    this.clicks = 0
  }
  matches() { return false }
  closest() { return null }
  querySelector() { return null }
  querySelectorAll() { return [] }
  addEventListener() {}
  removeEventListener() {}
  click() { this.clicks += 1 }
}

function createHarness(options = {}) {
  const listeners = new Map()
  let rafs = []
  let clock = 0
  const scroller = new FakeElement({
    clientHeight: options.clientHeight ?? 600,
    scrollHeight: options.scrollHeight ?? 1000,
    scrollTop: options.scrollTop ?? 400,
  })
  const toBottom = options.toBottom ? new FakeElement() : null

  const document = {
    querySelectorAll: (sel) => (sel === '[data-conversation-scroll]' ? [scroller] : []),
    querySelector: (sel) => (toBottom !== null && String(sel).includes('toBottomSlot') ? toBottom : null),
    addEventListener(type, fn) {
      const list = listeners.get(type) || []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== fn))
    },
  }

  const window = {
    requestAnimationFrame(cb) { rafs.push(cb); return rafs.length },
    cancelAnimationFrame() { rafs = [] },
    setInterval() { return 1 },
    clearInterval() {},
  }

  const observers = []
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = [] ; observers.push(this) }
    observe(element) { this.targets.push(element) }
    disconnect() { this.targets = [] }
    trigger() { if (this.targets.length > 0) this.cb([]) }
  }

  const performance = { now: () => clock }

  return {
    env: {
      document,
      window,
      performance,
      MutationObserver,
      scrollerSelector: '[data-conversation-scroll]',
      isEnabled: () => true,
    },
    scroller,
    toBottom,
    advance(ms) { clock += ms },
    flushFrames(limit = 80) {
      let n = 0
      while (rafs.length > 0 && n < limit) {
        const cb = rafs.shift()
        cb()
        n += 1
      }
      return n
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) || []) fn(event)
    },
    grow(bytes) { scroller.scrollHeight += bytes },
    triggerMutation() { for (const observer of observers) observer.trigger() },
  }
}

/* ---------- 载入插件的客户端工厂，取到跟随控制器 ---------- */
let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } }, localStorage: { getItem: () => null, setItem: () => {} } }
globalThis.document = { documentElement: { dataset: {}, setAttribute() {}, removeAttribute() {} }, getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, getElementsByTagName: () => ({ length: 0 }), querySelector: () => null, querySelectorAll: () => [] }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.Element = FakeElement
globalThis.performance = { now: () => 0, memory: { usedJSHeapSize: 0 } }

await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname.replace(/^\//, '')))
const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, memo: (f) => f }
const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const { createFollowController } = mod.__internals

const gapOf = (scroller) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight

test('贴底时内容增长，缓动追到底部', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000 })
  const controller = createFollowController(h.env)
  const stop = controller.start()
  assert.equal(controller.state.mode, 'follow')

  h.grow(400)
  h.triggerMutation()
  h.flushFrames()
  assert.ok(gapOf(h.scroller) <= 1, 'gap 应收敛到 1px 内，实际 ' + gapOf(h.scroller))
  stop()
})

test('用户滚轮上滚后，内容增长不再自动滚动', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000 })
  const controller = createFollowController(h.env)
  const stop = controller.start()

  h.dispatch('wheel', { deltaY: -120, target: h.scroller })
  assert.equal(controller.state.mode, 'reading')

  const before = h.scroller.scrollTop
  h.grow(600)
  h.triggerMutation()
  h.flushFrames()
  assert.equal(h.scroller.scrollTop, before, '阅读模式不得写 scrollTop')
  stop()
})

test('布局锚定（无手势的 scrollTop 回退）不解除跟随', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000 })
  const controller = createFollowController(h.env)
  const stop = controller.start()

  h.grow(400)
  h.triggerMutation() // 内容变化 → 排队一次追底
  h.scroller.scrollTop = 340 // 浏览器锚定补偿（无手势）
  h.dispatch('scroll', { target: h.scroller })
  assert.equal(controller.state.mode, 'follow')

  h.flushFrames()
  assert.ok(gapOf(h.scroller) <= 1, '仍应追到底部')
  stop()
})

test('滚回底部后恢复跟随', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000 })
  const controller = createFollowController(h.env)
  const stop = controller.start()

  h.dispatch('wheel', { deltaY: -200, target: h.scroller })
  assert.equal(controller.state.mode, 'reading')
  h.advance(1000)

  h.scroller.scrollTop = h.scroller.scrollHeight - h.scroller.clientHeight
  h.dispatch('scroll', { target: h.scroller })
  assert.equal(controller.state.mode, 'follow')

  h.grow(300)
  h.triggerMutation()
  h.flushFrames()
  assert.ok(gapOf(h.scroller) <= 1, '恢复后应继续跟随')
  stop()
})

test('阅读模式下不点「回到底部」按钮（避免被拉回底部）', () => {
  const h = createHarness({ scrollTop: 200, scrollHeight: 1000, toBottom: true })
  const controller = createFollowController(h.env)
  const stop = controller.start()
  assert.equal(controller.state.mode, 'reading')

  h.triggerMutation()
  h.flushFrames()
  assert.equal(h.toBottom.clicks, 0)
  assert.equal(h.scroller.scrollTop, 200)
  stop()
})

test('跟随模式下 App 已脱离时点一次「回到底部」，并有节流', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000, toBottom: true })
  const controller = createFollowController(h.env)
  const stop = controller.start()
  assert.equal(controller.state.mode, 'follow')

  h.triggerMutation()
  assert.equal(h.toBottom.clicks, 1)
  h.triggerMutation()
  assert.equal(h.toBottom.clicks, 1, '900ms 内不应重复点击')

  h.advance(1000)
  h.triggerMutation()
  assert.equal(h.toBottom.clicks, 2)
  stop()
})

test('用户按住滚动条拖动时立即停止写入', () => {
  const h = createHarness({ scrollTop: 400, scrollHeight: 1000 })
  const controller = createFollowController(h.env)
  const stop = controller.start()

  h.dispatch('pointerdown', { target: h.scroller })
  h.grow(400)
  h.triggerMutation()
  h.flushFrames()
  assert.equal(h.scroller.scrollTop, 400)
  stop()
})