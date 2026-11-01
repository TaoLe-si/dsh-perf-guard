import { pathToFileURL } from 'node:url'

class FakeElement {}
globalThis.Element = FakeElement
globalThis.MutationObserver = class { observe() {} disconnect() {} }
const attrs = new Map()
const root = {
  dataset: {},
  setAttribute(key, value) { attrs.set(key, value) },
  removeAttribute(key) { attrs.delete(key) },
  getAttribute(key) { return attrs.get(key) ?? null },
}
const store = new Map()
let captured = null
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
}
globalThis.window.__ModuleLoader__ = { load: (definition) => { captured = definition } }
globalThis.document = {
  documentElement: root,
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName: () => ({ length: 5321 }),
  querySelector: () => null,
  querySelectorAll: () => [],
}
root.querySelectorAll = () => []
root.matches = () => false
globalThis.performance = { memory: { usedJSHeapSize: 512 * 1024 * 1024 } }

const target = new URL('../client.js', import.meta.url).href
await import(target)
if (!captured) throw new Error('module loader was not called')

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
const injected = []
const registered = []
const cleanup = []
const ctx = {
  slots: {
    inject(name, factory) { injected.push(name); factory() },
    register(spec, render) { registered.push({ spec, render }) },
  },
  effect(fn) { cleanup.push(fn) },
}
mod.apply(ctx)

console.log('module id              :', captured.id)
console.log('exports.inject         :', JSON.stringify(mod.inject))
console.log('slots injected         :', injected.join(','))
console.log('slots registered       :', registered.map((entry) => entry.spec.id).join(','))
console.log('settings label         :', registered[0].spec.label())
console.log('root dataset           :', JSON.stringify(root.dataset))
console.log('effects registered     :', cleanup.length)
const disposers = cleanup.map((fn) => fn())
const element = registered[0].render({})
console.log('slot render type       :', typeof element.type)
const tree = element.type({})
console.log('section renders div    :', tree.type === 'div', 'children:', tree.props.children.length)
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
console.log('SMOKE OK')