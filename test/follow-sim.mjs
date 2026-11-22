import { test } from 'node:test'
import assert from 'node:assert/strict'

const SCROLL = '[data-conversation-scroll]'
const SESSION = '[data-conversation-session]'
const SPACER = '[data-chat-turn-spacer]'
const FOLLOW = '[data-chat-following-tail]'

class Element {
  constructor(parent, ...selectors) {
    this.parent = parent
    this.selectors = new Set(selectors)
    this.isConnected = true
    this.rect = { top: 0, bottom: 600, height: 600 }
  }
  matches(selector) { return selector.split(', ').some(piece => this.selectors.has(piece)) }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  contains(element) { return element === this || (element.parent != null && this.contains(element.parent)) }
  getBoundingClientRect() { return this.rect }
}

function harness({ top = 400, native = false } = {}) {
  const listeners = new Map()
  const frames = new Map()
  let nextFrame = 0
  let clock = 0
  let interval
  let writes = 0
  let clicks = 0
  let sessionId = 'first'
  const session = new Element(null, SESSION)
  session.getAttribute = () => sessionId
  const scroller = Object.assign(new Element(session, SCROLL), { clientHeight: 600, scrollHeight: 1000 })
  const floor = () => scroller.scrollHeight - scroller.clientHeight
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: value => { writes += 1; top = Math.min(value, floor()) },
  })
  const chat = new Element(scroller)
  const spacer = new Element(chat, SPACER)
  let markers = native ? [spacer] : []
  scroller.querySelectorAll = selector => selector === SPACER ? markers : []
  let enabled = true
  const document = {
    activeElement: null,
    querySelectorAll: selector => selector === SCROLL && scroller.isConnected ? [scroller] : [],
    querySelector: selector => selector.includes('toBottomSlot') ? toBottom : null,
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
  }
  const send = (type, data = {}) => listeners.get(type)?.({ target: scroller, ...data })
  const move = value => { top = value; send('scroll') }
  const toBottom = { click() { clicks += 1; move(floor()) } }
  const window = {
    requestAnimationFrame(cb) { frames.set(++nextFrame, cb); return nextFrame },
    cancelAnimationFrame(id) { frames.delete(id) },
    setInterval(cb) { interval = cb; return 1 },
    clearInterval() { interval = undefined },
  }
  let mutation
  let observed
  return {
    env: {
      document, window,
      isEnabled: () => enabled,
      performance: { now: () => clock },
      MutationObserver: class {
        constructor(cb) { mutation = cb }
        observe(element) { observed = element }
        disconnect() { observed = undefined }
      },
    },
    scroller, chat, spacer, toBottom, send, move,
    get observed() { return observed },
    get writes() { return writes },
    get clicks() { return clicks },
    gap: () => floor() - top,
    advance(ms) { clock += ms },
    session(id) { sessionId = id },
    enable(value) { enabled = value },
    mark(elements) { markers = elements },
    attach() { interval?.() },
    grow(px) { scroller.scrollHeight += px },
    mutate() { if (observed) mutation([]) },
    flush() {
      let limit = 80
      while (frames.size > 0) {
        assert.ok(limit-- > 0, 'animation must converge')
        const [id, fn] = frames.entries().next().value
        frames.delete(id)
        fn()
      }
    },
  }
}

let definition
globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
try {
  await import(new URL('../client.js', import.meta.url).href)
} finally {
  delete globalThis.window
}
const { createFollowController, canAutoReveal } = definition.factory(() => ({})).__internals

function start(t, options) {
  const h = harness(options)
  const controller = createFollowController(h.env)
  t.after(controller.start())
  return { h, state: controller.state }
}

test('legacy tail follows growth without clicking the host button', t => {
  const { h, state } = start(t)
  assert.equal(state.mode, 'follow')
  h.grow(300)
  h.mutate()
  h.flush()
  assert.ok(h.writes > 0)
  assert.ok(h.gap() <= 1)
  assert.equal(h.clicks, 0)
})

test('a small upward scroll cancels legacy follow, including a queued frame', t => {
  const { h, state } = start(t)
  h.mutate()
  h.send('wheel', { deltaY: -10 })
  h.move(390)
  h.advance(1000)
  h.grow(300)
  h.mutate()
  h.flush()
  assert.equal(state.mode, 'reading')
  assert.equal(h.scroller.scrollTop, 390)
  assert.equal(h.writes, 0)
  assert.equal(h.clicks, 0)
})

test('legacy layout anchoring adjusts the offset without cancelling follow', t => {
  const { h, state } = start(t)
  h.grow(150)
  h.move(340)
  h.mutate()
  h.flush()
  assert.equal(state.mode, 'follow')
  assert.ok(h.gap() <= 1)
})

test('legacy manual return restores follow; near-bottom and layout shrink do not', t => {
  const { h, state } = start(t, { top: 200 })
  h.move(390)
  assert.equal(state.mode, 'reading')
  h.grow(-10)
  h.move(390)
  assert.equal(state.mode, 'reading')
  h.grow(80)
  h.toBottom.click()
  assert.equal(state.mode, 'follow')
  h.grow(200)
  h.mutate()
  h.flush()
  assert.ok(h.gap() <= 1)
  assert.equal(h.clicks, 1)
})

test('legacy scrollbar movement does not require pointerdown to pause', t => {
  const { h, state } = start(t)
  h.move(395)
  h.grow(200)
  h.mutate()
  h.flush()
  assert.equal(state.mode, 'reading')
  assert.equal(h.writes, 0)
})

test('legacy drag blocks writes; input in another scrollport is ignored', t => {
  const { h, state } = start(t)
  h.send('wheel', { target: new Element(null, SCROLL), deltaY: -10 })
  assert.equal(state.mode, 'follow')
  h.send('pointerdown')
  h.grow(200)
  h.mutate()
  h.flush()
  assert.equal(h.writes, 0)
})

test('native Chat owns scrolling in both reading and follow states', t => {
  const { h, state } = start(t, { top: 200, native: true })
  assert.equal(state.native, true)
  assert.equal(h.observed, undefined)
  h.grow(250)
  h.mutate()
  h.flush()
  assert.equal(h.scroller.scrollTop, 200)
  assert.equal(h.clicks, 0)
  h.toBottom.click()
  assert.equal(h.gap(), 0)
  h.chat.selectors.add(FOLLOW)
  h.grow(250)
  h.mutate()
  h.flush()
  assert.equal(h.writes, 0)
  assert.equal(h.clicks, 1)
})

test('a late native marker cancels pending legacy writes and survives remount', t => {
  const { h, state } = start(t)
  h.grow(150)
  h.mutate()
  h.mark([h.spacer])
  h.flush()
  assert.equal(state.native, true)
  assert.equal(h.writes, 0)
  h.mark([])
  h.session('second')
  h.attach()
  assert.equal(state.native, true)
  assert.equal(h.observed, undefined)
})

test('queued legacy frames cannot write to a different session or detached scrollport', t => {
  const { h, state } = start(t)
  h.grow(100)
  h.mutate()
  h.session('second')
  h.flush()
  assert.equal(h.writes, 0)
  h.attach()
  h.move(500)
  h.grow(100)
  h.mutate()
  h.scroller.isConnected = false
  h.flush()
  h.attach()
  assert.equal(h.writes, 0)
  assert.equal(state.attached, null)
})

test('nested Chat markers do not claim their ancestor scroller; preference still applies', t => {
  const { h, state } = start(t)
  const nested = new Element(h.scroller, SCROLL)
  h.mark([new Element(nested, SPACER)])
  h.attach()
  assert.equal(state.native, false)
  h.grow(100)
  h.mutate()
  h.enable(false)
  h.flush()
  assert.equal(h.writes, 0)
})

test('auto-reveal requires the same Chat to be following and the header to be visible', () => {
  const h = harness({ native: true })
  const button = new Element(h.chat, 'button')
  button.ownerDocument = h.env.document
  button.rect = { top: 100, bottom: 140, height: 40 }
  assert.equal(canAutoReveal(button), false)
  h.chat.selectors.add(FOLLOW)
  assert.equal(canAutoReveal(button), true)
  h.move(390)
  assert.equal(canAutoReveal(button), false)
  h.move(400)
  button.rect = { top: -5, bottom: 35, height: 40 }
  assert.equal(canAutoReveal(button), false)
  button.rect = { top: 100, bottom: 140, height: 40 }
  h.env.document.activeElement = new Element(h.scroller, 'textarea')
  assert.equal(canAutoReveal(button), false)
  h.env.document.activeElement = null
  button.parent = new Element(h.scroller, FOLLOW)
  assert.equal(canAutoReveal(button), false)
})
