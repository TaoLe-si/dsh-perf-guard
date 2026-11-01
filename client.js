/**
 * dsh-perf-guard — 浏览器半。
 *
 * 目标：长上下文 / 多轮会话下，滚动对话不再重新布局整棵消息树。
 *
 * 三件事：
 *  1) 离屏跳过渲染：给 [data-chat-turn] / [data-step-process] 加 content-visibility: auto，
 *     浏览器只为可视区域付布局与绘制成本（DOM 仍在，语义不丢，可用开关关闭）。
 *  2) 滚动降载：滚动期间暂停动画/过渡、关掉 backdrop-filter，滚完 140ms 恢复。
 *  3) 巨型输出钳制：工具输出的 pre / 过程体限高并内部滚动，避免单条消息撑出几万像素。
 *
 * 另有自动降载：DOM 节点数或 JS 堆超过阈值时自动打开上述保守项。
 */
window.__ModuleLoader__.load({
  id: 'dsh-perf-guard',
  factory: (require) => {
    'use strict'
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const API = '/api/perf-guard'
    const STORAGE_KEY = 'dsh-perf-guard:prefs'
    const SCROLL_SELECTOR = '[data-conversation-scroll]'
    const STYLE_ID = 'dsh-perf-guard-style'
    const DEFAULTS = Object.freeze({
      contentVisibility: true,
      aggressiveTurns: false,
      clampTools: true,
      scrollGovernor: true,
      autoDegrade: true,
      autoExpandThinking: true,
      smoothReveal: true,
      followTail: true,
    })
    /** DOM 节点 / JS 堆到达该阈值时自动降载。 */
    const HEAVY_DOM_NODES = 12000
    const HEAVY_HEAP_BYTES = 1.1 * 1024 ** 3

    /** 运行时自检状态：设置页展示，同时挂到 window 上方便排查。 */
    const runtime = {
      scroller: false,
      pinned: true,
      thinkSeen: 0,
      thinkOpened: 0,
      seatOpened: 0,
      follows: 0,
      lastFollowAt: 0,
    }

    const CSS = [
      /* 过程块与工具块：默认离屏跳过布局与绘制。 */
      '[data-perfguard-cv="on"] [data-step-process],',
      '[data-perfguard-cv="on"] [data-turn-process] {',
      '  content-visibility: auto;',
      '  contain-intrinsic-size: auto 200px;',
      '}',
      /* 整回合离屏跳过：默认关闭，收益最大，也最依赖 contain-intrinsic-size 的准度。 */
      '[data-perfguard-turns="on"] [data-chat-turn],',
      '[data-perfguard-heavy] [data-chat-turn] {',
      '  content-visibility: auto;',
      '  contain-intrinsic-size: auto 360px;',
      '}',
      /* 正在流式输出的回合不做离屏跳过，避免增量高度抖动的测量噪声。 */
      '[data-perfguard-turns="on"] [data-chat-turn][data-streaming],',
      '[data-perfguard-heavy] [data-chat-turn][data-streaming] {',
      '  content-visibility: visible;',
      '  contain-intrinsic-size: none;',
      '}',
      /* 滚动期间不做合成层滤镜与动画，滚完自动恢复。 */
      '[data-perfguard-scrolling] [data-chat-turn] *,',
      '[data-perfguard-scrolling] [data-chat-turn] {',
      '  animation-play-state: paused !important;',
      '  transition-duration: 0s !important;',
      '}',
      '[data-perfguard-scrolling] [data-conversation-scroll] * {',
      '  backdrop-filter: none !important;',
      '}',
      /* 巨型工具输出：限高 + 内部滚动，避免一条消息几万像素。 */
      '[data-perfguard-clamp="on"] [data-chat-turn] pre {',
      '  max-height: 320px;',
      '  overflow: auto;',
      '}',
      '[data-perfguard-clamp="on"] [data-step-process-body],',
      '[data-perfguard-clamp="on"] [data-turn-process-body] {',
      '  max-height: 420px;',
      '  overflow: auto;',
      '}',
      /* 设置页样式（全部走主题变量，深浅色自动跟随）。 */
      '.dsh-pg { display: flex; flex-direction: column; gap: 22px; max-width: 820px; padding: 10px 4px 40px; }',
      '.dsh-pg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.dsh-pg-head-main { display: flex; flex-direction: column; gap: 6px; }',
      '.dsh-pg-badge { flex: none; font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 999px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); opacity: .68; }',
      '.dsh-pg-group { display: flex; flex-direction: column; gap: 10px; }',
      '.dsh-pg-group-title { font-size: 13px; font-weight: 600; opacity: .85; }',
      '.dsh-pg-group-hint { font-size: 12px; line-height: 1.6; opacity: .55; margin-bottom: 2px; }',
      '.dsh-pg-title { font-size: 14px; font-weight: 600; opacity: .9; }',
      '.dsh-pg-desc { font-size: 12px; line-height: 1.7; opacity: .62; }',
      '.dsh-pg-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--dsh-border, rgba(127,127,127,.24)); border-radius: 12px; background: var(--dsh-fill-1, rgba(127,127,127,.03)); }',
      '.dsh-pg-row-main { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-pg-row b { font-size: 13px; font-weight: 600; }',
      '.dsh-pg-row span { font-size: 12px; line-height: 1.6; opacity: .62; }',
      '.dsh-pg-switch { flex: none; width: 38px; height: 22px; border-radius: 999px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); background: transparent; cursor: pointer; position: relative; }',
      '.dsh-pg-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsh-text-3, #999); transition: transform .16s ease; }',
      '.dsh-pg-switch[data-on="true"] { background: var(--dsh-accent, #4c8dff); border-color: transparent; }',
      '.dsh-pg-switch[data-on="true"]::after { transform: translateX(16px); background: #fff; }',
      '.dsh-pg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }',
      '.dsh-pg-card { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--dsh-border, rgba(127,127,127,.24)); background: var(--dsh-fill-1, rgba(127,127,127,.03)); }',
      '.dsh-pg-card em { display: block; font-style: normal; font-size: 11px; opacity: .55; margin-bottom: 4px; }',
      '.dsh-pg-card strong { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }',
      '.dsh-pg-list { margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 1.8; opacity: .75; }',
      '.dsh-pg-actions { display: flex; gap: 8px; }',
      '.dsh-pg-btn { font-size: 12px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); background: transparent; cursor: pointer; }',
      '.dsh-pg-btn:hover { background: var(--dsh-fill-1, rgba(127,127,127,.12)); }',
      /* 思考链展开时的入场动画：淡入 + 轻微上移，避免内容突然撑开。 */
      '@keyframes dsh-pg-reveal { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }',
      '[data-perfguard-reveal="on"] [data-variant="think"][data-expanded] { animation: dsh-pg-reveal .18s ease-out both; }',
      '[data-perfguard-reveal="on"] [data-step-process-body] { animation: dsh-pg-reveal .2s ease-out both; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-perfguard-reveal="on"] [data-variant="think"][data-expanded],',
      '  [data-perfguard-reveal="on"] [data-step-process-body] { animation: none; }',
      '}',
    ].join('\n')

    function injectStylesheet() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        // 插件热更新后旧的 <style> 会留在页面上，必须覆盖：否则新类名没有样式，
        // 设置页会退化成浏览器默认字号（曾经踩过）。
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head ?? document.documentElement).appendChild(style)
    }

    function readPrefs() {
      const prefs = { ...DEFAULTS }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw) Object.assign(prefs, JSON.parse(raw))
      } catch {
        // 存储损坏或隐私模式：退回默认值。
      }
      return prefs
    }

    function writePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch {
        // 写入失败不影响本次会话内的开关。
      }
    }

    function applyPrefs(prefs) {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      root.dataset.perfguardCv = prefs.contentVisibility ? 'on' : 'off'
      root.dataset.perfguardTurns = prefs.aggressiveTurns ? 'on' : 'off'
      root.dataset.perfguardClamp = prefs.clampTools ? 'on' : 'off'
      root.dataset.perfguardReveal = prefs.smoothReveal ? 'on' : 'off'
    }

    /** 滚动期间给 <html> 打标，滚完 140ms 摘掉。 */
    function installScrollGovernor(isEnabled) {
      let idleTimer = 0
      let scrolling = false
      const root = document.documentElement

      function markScrolling() {
        if (!isEnabled() || scrolling) return
        scrolling = true
        root.setAttribute('data-perfguard-scrolling', '')
      }

      function release() {
        if (!scrolling) return
        scrolling = false
        root.removeAttribute('data-perfguard-scrolling')
      }

      function onScroll(event) {
        const target = event.target
        if (!(target instanceof Element) || !target.matches(SCROLL_SELECTOR)) return
        markScrolling()
        if (idleTimer) window.clearTimeout(idleTimer)
        idleTimer = window.setTimeout(() => {
          idleTimer = 0
          release()
        }, 140)
      }

      document.addEventListener('scroll', onScroll, { capture: true, passive: true })
      return () => {
        document.removeEventListener('scroll', onScroll, { capture: true })
        if (idleTimer) window.clearTimeout(idleTimer)
        release()
      }
    }

    /** DOM 节点 / JS 堆超阈值时自动切到保守模式。 */
    function installAutoDegrade(isEnabled) {
      const root = document.documentElement
      let heavy = false
      const timer = window.setInterval(() => {
        if (!isEnabled()) {
          if (heavy) {
            heavy = false
            root.removeAttribute('data-perfguard-heavy')
          }
          return
        }
        const nodes = document.getElementsByTagName('*').length
        const heap = performance.memory ? performance.memory.usedJSHeapSize : 0
        const next = nodes > HEAVY_DOM_NODES || heap > HEAVY_HEAP_BYTES
        if (next === heavy) return
        heavy = next
        if (heavy) root.setAttribute('data-perfguard-heavy', '')
        else root.removeAttribute('data-perfguard-heavy')
      }, 5000)
      return () => {
        window.clearInterval(timer)
        root.removeAttribute('data-perfguard-heavy')
      }
    }

    function formatMb(bytes) {
      if (!bytes || bytes < 0) return '-'
      return (bytes / 1024 ** 2).toFixed(bytes >= 1024 ** 3 ? 0 : 1) + ' MB'
    }

    const THINK_SELECTOR = '[data-variant="think"]'
    const SEAT_SELECTOR = '[data-step-process]'
    /** 用户手动收起过的元素：不再自动展开。 */
    const USER_CLOSED = new WeakSet()

    /**
     * 展开控件：DisclosureRow 在 expandOnRowClick 下渲染的是 div[role=button][aria-expanded]，
     * 过程组头部才是真正的 <button>；所以只按 aria-expanded 找，不能限定 button。
     */
    function toggleTarget(element) {
      return element.querySelector('[aria-expanded]')
    }

    /**
     * 自动展开正在流式输出的思考链：
     *  - 只处理 data-state="running" 的思考行，历史回合保持折叠，避免 DOM 膨胀；
     *  - 承载它的过程组若折叠，先展开组再展开思考行；
     *  - 用户手动收起过的元素记进 WeakSet，之后不再自动打开。
     */
    function installAutoExpandThinking(isEnabled) {
      const opened = new WeakSet()
      let lateScan = 0
      /** 自动开组的时间闸：最多每 800ms 一次，防止流式期间反复点开。 */
      let lastOpenAt = 0

      const seen = new WeakSet()

      function clickOnce(element, button) {
        if (button === null || button.getAttribute('aria-expanded') !== 'false') return false
        opened.add(element)
        button.click()
        return true
      }

      function reveal(think) {
        if (!isEnabled() || opened.has(think) || USER_CLOSED.has(think)) return
        if (think.getAttribute('data-state') !== 'running') return
        if (!seen.has(think)) {
          seen.add(think)
          runtime.thinkSeen += 1
        }
        const seat = think.closest(SEAT_SELECTOR)
        if (seat !== null && !USER_CLOSED.has(seat) && clickOnce(seat, toggleTarget(seat))) runtime.seatOpened += 1
        if (!think.isConnected) return
        if (clickOnce(think, toggleTarget(think))) runtime.thinkOpened += 1
      }

      /**
       * 过程组折叠时，思考行根本不在 DOM 里 —— 从「当前流式回合」反推：
       * 页面存在 data-streaming 时，展开最后一个（= 最新的）过程组，让思考链露出来。
       */
      function openLiveSeat() {
        if (!isEnabled()) return
        const now = Date.now()
        if (now - lastOpenAt < 800) return
        // data-streaming 要等 assistant 文本出现；过程组头部的 TextShimmer 在开始思考时就有 data-shimmer。
        if (document.querySelector('[data-streaming], [data-shimmer]') === null) return
        let latest = null
        let latestTurn = -1
        for (const seat of document.querySelectorAll(SEAT_SELECTOR)) {
          const raw = seat.getAttribute('data-chat-turn')
          if (raw === null) continue
          const turn = Number(raw)
          if (!Number.isFinite(turn) || turn < latestTurn) continue
          latest = seat
          latestTurn = turn
        }
        if (latest === null || USER_CLOSED.has(latest) || opened.has(latest)) return
        if (toggleTarget(latest)?.getAttribute('aria-expanded') !== 'false') return
        lastOpenAt = now
        if (clickOnce(latest, toggleTarget(latest))) runtime.seatOpened += 1
      }

      function scan(root) {
        if (!(root instanceof Element)) return
        if (root.matches(THINK_SELECTOR)) reveal(root)
        for (const think of root.querySelectorAll(THINK_SELECTOR)) reveal(think)
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            scan(record.target)
            continue
          }
          for (const node of record.addedNodes) scan(node)
        }
        openLiveSeat()
      })
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state'],
      })

      scan(document.documentElement)
      lateScan = window.setTimeout(() => {
        lateScan = 0
        scan(document.documentElement)
        openLiveSeat()
      }, 1000)

      const onClick = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const button = target.closest('button[aria-expanded]')
        if (button === null) return
        // 点击时仍是展开态 = 这是收起动作，记下来别打扰用户。
        if (button.getAttribute('aria-expanded') !== 'true') return
        const think = target.closest(THINK_SELECTOR)
        if (think !== null) USER_CLOSED.add(think)
        const seat = target.closest(SEAT_SELECTOR)
        if (seat !== null) USER_CLOSED.add(seat)
      }
      document.addEventListener('click', onClick, true)

      return () => {
        observer.disconnect()
        document.removeEventListener('click', onClick, true)
        if (lateScan) window.clearTimeout(lateScan)
      }
    }

    /**
     * 跟随最新输出：
     *  - 贴底时，新内容到达后用 rAF 缓动追到最新一行（不是瞬移）；
     *  - 一旦用户向上滚离底部（>64px）立刻脱离；
     *  - 再滚回距底 24px 内自动恢复跟随。
     */
    function installFollowTail(isEnabled) {
      let pinned = true
      let frame = 0
      let active = null
      const observed = new WeakSet()
      const positions = new WeakMap()

      /** 页面上可能同时存在多个 [data-conversation-scroll]（主对话 + 侧栏预览），取最大的可见那个。 */
      function pickScroller() {
        let best = null
        for (const element of document.querySelectorAll(SCROLL_SELECTOR)) {
          if (element.clientHeight <= 0) continue
          if (best === null || element.clientHeight > best.clientHeight) best = element
        }
        return best
      }

      function bottomGap(element) {
        return element.scrollHeight - element.scrollTop - element.clientHeight
      }

      function tick() {
        frame = 0
        const element = pickScroller()
        if (element === null || !pinned || !isEnabled()) return
        const gap = bottomGap(element)
        if (gap <= 1) return
        element.scrollTop = element.scrollTop + Math.max(1, gap * 0.3)
        positions.set(element, { top: element.scrollTop, height: element.scrollHeight })
        runtime.follows += 1
        runtime.lastFollowAt = Date.now()
        frame = window.requestAnimationFrame(tick)
      }

      function follow() {
        if (!isEnabled() || !pinned || frame !== 0) return
        frame = window.requestAnimationFrame(tick)
      }

      function adopt(element) {
        if (element === null) return
        if (!observed.has(element)) {
          observed.add(element)
          observer.observe(element, { childList: true, subtree: true, characterData: true })
        }
        if (element !== active) {
          active = element
          pinned = bottomGap(element) <= 24
          positions.set(element, { top: element.scrollTop, height: element.scrollHeight })
        }
        runtime.scroller = true
        runtime.pinned = pinned
      }

      const onScroll = (event) => {
        const element = event.target
        if (!(element instanceof Element) || !element.matches(SCROLL_SELECTOR)) return
        const gap = bottomGap(element)
        const previous = positions.get(element)
        const movedUp = previous !== undefined && element.scrollTop < previous.top - 2
        positions.set(element, { top: element.scrollTop, height: element.scrollHeight })
        if (gap <= 24) {
          pinned = true
          runtime.pinned = true
          return
        }
        // 只有「位置真的往上走」才脱离；内容变高导致的 gap 变大不算。
        if (movedUp) {
          pinned = false
          runtime.pinned = false
        }
      }

      const onWheel = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        // 过程体 / 工具输出里的嵌套滚动不算「离开底部」。
        if (target.closest('[data-step-process-body]') !== null) return
        const element = target.closest(SCROLL_SELECTOR)
        if (element === null || event.deltaY >= 0) return
        if (bottomGap(element) > 64) {
          pinned = false
          runtime.pinned = false
        }
      }

      const onKeyDown = (event) => {
        if (event.key !== 'PageUp' && event.key !== 'ArrowUp' && event.key !== 'Home') return
        const element = pickScroller()
        if (element !== null && bottomGap(element) > 64) {
          pinned = false
          runtime.pinned = false
        }
      }

      const observer = new MutationObserver(() => {
        adopt(pickScroller())
        follow()
      })

      adopt(pickScroller())
      const attachTimer = window.setInterval(() => adopt(pickScroller()), 1500)

      document.addEventListener('scroll', onScroll, { capture: true, passive: true })
      document.addEventListener('wheel', onWheel, { capture: true, passive: true })
      document.addEventListener('keydown', onKeyDown, { capture: true })

      return () => {
        observer.disconnect()
        window.clearInterval(attachTimer)
        window.cancelAnimationFrame(frame)
        document.removeEventListener('scroll', onScroll, { capture: true })
        document.removeEventListener('wheel', onWheel, { capture: true })
        document.removeEventListener('keydown', onKeyDown, { capture: true })
      }
    }
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-pg-switch',
        'data-on': String(props.on),
        'aria-pressed': props.on ? 'true' : 'false',
        onClick: props.onToggle,
      })
    }

    function PerfSection() {
      const [prefs, setPrefs] = React.useState(readPrefs)
      const [stats, setStats] = React.useState(null)

      const sample = React.useCallback(async () => {
        const nodes = document.getElementsByTagName('*').length
        const heap = performance.memory ? performance.memory.usedJSHeapSize : null
        let host = null
        try {
          const response = await fetch(API + '/stats', { headers: { 'x-dsh-plugin': 'perf-guard' } })
          if (response.ok) host = await response.json()
        } catch {
          // 宿主半未挂载或重启中：保留浏览器侧指标即可。
        }
        setStats({ nodes, heap, host, at: Date.now() })
      }, [])

      React.useEffect(() => {
        sample()
        const timer = window.setInterval(sample, 15000)
        return () => window.clearInterval(timer)
      }, [sample])

      const toggle = (key) => {
        const next = { ...prefs, [key]: !prefs[key] }
        setPrefs(next)
        writePrefs(next)
        applyPrefs(next)
      }

      const reset = () => {
        const next = { ...DEFAULTS }
        setPrefs(next)
        writePrefs(next)
        applyPrefs(next)
      }

      const GROUPS = [
        {
          title: '思考链与跟随',
          hint: '流式输出时的阅读体验：思考链自动展开、贴底跟随、回到底部自动续跟。',
          rows: [
            ['autoExpandThinking', '自动展开思考链', '模型思考时自动展开正在流式输出的思考行（含外层过程组）：只处理当前正在跑的步骤，历史步骤保持折叠；手动收起过的行不再自动打开。'],
            ['followTail', '跟随最新输出', '贴底时，新内容到达后用缓动追到最新一行；向上滚动立即脱离跟随，滚回距底部 24px 内自动恢复。'],
            ['smoothReveal', '展开平滑动画', '思考链与过程组展开时淡入并轻微上移；系统开启「减少动态效果」时自动取消动画。'],
          ],
        },
        {
          title: '滚动与渲染',
          hint: '控制浏览器为长会话付出多少布局与绘制成本。',
          rows: [
            ['contentVisibility', '离屏过程块跳过渲染', '给工具块与过程块加 content-visibility: auto，滚动时浏览器不为屏幕外的步骤付布局与绘制成本。'],
            ['aggressiveTurns', '整回合离屏跳过（实验）', '把离屏跳过提升到整条回合。长会话收益最大；若滚动位置偶尔跳动，关掉这一项即可。'],
            ['clampTools', '工具输出限高', '把超长的终端输出、diff、过程体限制在几百像素内并内部滚动，避免单条消息撑出几万像素。'],
            ['scrollGovernor', '滚动期间降载', '滚动时暂停动画与毛玻璃合成，停止滚动 140ms 后恢复，减少掉帧。'],
            ['autoDegrade', '自动降载', 'DOM 节点超过 12000 或 JS 堆超过 1.1GB 时自动提醒并开启保守项。'],
          ],
        },
      ]

      const host = stats && stats.host
      const sessions = host && host.sessions

      return h(
        'div',
        { className: 'dsh-pg' },
        h(
          'div',
          { className: 'dsh-pg-head' },
          h(
            'div',
            { className: 'dsh-pg-head-main' },
            h('div', { className: 'dsh-pg-title' }, '性能守卫'),
            h('div', { className: 'dsh-pg-desc' }, '长上下文与多轮会话下的滚动降载、思考链自动展开与贴底跟随。所有开关即时生效，只影响渲染，不改动任何会话数据。'),
          ),
          h('span', { className: 'dsh-pg-badge' }, host ? 'v' + host.version : '本地插件'),
        ),
        ...GROUPS.map((group) =>
          h(
            'section',
            { className: 'dsh-pg-group', key: group.title },
            h('div', { className: 'dsh-pg-group-title' }, group.title),
            h('div', { className: 'dsh-pg-group-hint' }, group.hint),
            ...group.rows.map(([key, title, desc]) =>
              h(
                'div',
                { className: 'dsh-pg-row', key },
                h('div', { className: 'dsh-pg-row-main' }, h('b', null, title), h('span', null, desc)),
                h(Switch, { on: Boolean(prefs[key]), onToggle: () => toggle(key) }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-pg-grid' },
          h('div', { className: 'dsh-pg-card' }, h('em', null, '渲染进程 JS 堆'), h('strong', null, stats && stats.heap ? formatMb(stats.heap) : '不可用')),
          h('div', { className: 'dsh-pg-card' }, h('em', null, 'DOM 节点'), h('strong', null, stats ? String(stats.nodes) : '-')),
          h('div', { className: 'dsh-pg-card' }, h('em', null, '宿主进程 RSS'), h('strong', null, host ? formatMb(host.host.rss) : '未连接')),
          h('div', { className: 'dsh-pg-card' }, h('em', null, '会话日志总量'), h('strong', null, sessions ? formatMb(sessions.totalBytes) : '未扫描')),
        ),
        h(
          'section',
          { className: 'dsh-pg-group' },
          h('div', { className: 'dsh-pg-group-title' }, '自检'),
          h('div', { className: 'dsh-pg-group-hint' }, '跟随或展开没生效时先看这里；也可以在 DevTools 里执行 window.__dshPerfGuard 查看实时状态。'),
          h(
            'div',
            { className: 'dsh-pg-grid' },
            h('div', { className: 'dsh-pg-card' }, h('em', null, '滚动容器'), h('strong', null, runtime.scroller ? '已连接' : '未找到')),
            h('div', { className: 'dsh-pg-card' }, h('em', null, '跟随状态'), h('strong', null, runtime.pinned ? '贴底跟随中' : '已脱离')),
            h('div', { className: 'dsh-pg-card' }, h('em', null, '思考行 发现/展开'), h('strong', null, runtime.thinkSeen + ' / ' + runtime.thinkOpened)),
            h('div', { className: 'dsh-pg-card' }, h('em', null, '跟随次数'), h('strong', null, String(runtime.follows))),
          ),
        ),
        sessions && sessions.largest.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dsh-pg-title', style: { marginBottom: 6 } }, '最大的会话日志'),
              h(
                'ul',
                { className: 'dsh-pg-list' },
                ...sessions.largest.map((item) =>
                  h('li', { key: item.path }, item.sessionId + ' · ' + formatMb(item.bytes)),
                ),
              ),
              h('div', { className: 'dsh-pg-desc', style: { marginTop: 6 } }, '日志越大，打开会话时宿主解压与投影的开销越高；确认不再需要的历史可在侧边栏删除。'),
            )
          : null,
        h(
          'div',
          { className: 'dsh-pg-actions' },
          h('button', { type: 'button', className: 'dsh-pg-btn', onClick: sample }, '立即采样'),
          h('button', { type: 'button', className: 'dsh-pg-btn', onClick: reset }, '恢复默认'),
        ),
      )
    }

    function apply(ctx) {
      injectStylesheet()
      try {
        window.__dshPerfGuard = runtime
      } catch {
        // 只读环境下忽略。
      }
      const initial = readPrefs()
      applyPrefs(initial)

      ctx.effect(() => installScrollGovernor(() => readPrefs().scrollGovernor))
      ctx.effect(() => installAutoDegrade(() => readPrefs().autoDegrade))
      ctx.effect(() => installAutoExpandThinking(() => readPrefs().autoExpandThinking))
      ctx.effect(() => installFollowTail(() => readPrefs().followTail))

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'perf-guard',
            order: 900,
            label: () => '性能守卫',
          },
          () => h(PerfSection),
        ),
      )

      console.info('[perf-guard] applied', initial)
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports
  },
})