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
      motion: true,
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
      restores: 0,
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
      /* ---- 动效 ----
       * 曲线：入场 cubic-bezier(.22,1,.36,1)=easeOutQuint（快进慢停，适合出现）；
       *       场景切换 cubic-bezier(.16,1,.3,1)（更缓的收尾，避免闪）；
       *       微交互 cubic-bezier(.4,0,.2,1)（Material 标准曲线）。
       * 时长：列表项 240–260ms，场景 220–260ms，微交互 120ms；过长会显得迟钝。
       */
      '@keyframes dsh-pg-turn-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }',
      '@keyframes dsh-pg-session-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
      '@keyframes dsh-pg-fade-in { from { opacity: 0; } to { opacity: 1; } }',
      '[data-perfguard-motion="on"] .dsh-pg { animation: dsh-pg-fade-in .22s cubic-bezier(.22,1,.36,1) both; }',
      '[data-perfguard-motion="on"] .dsh-pg-enter { animation: dsh-pg-turn-in .26s cubic-bezier(.22,1,.36,1) both; }',
      '[data-perfguard-motion="on"] [data-conversation-content].dsh-pg-session-enter { animation: dsh-pg-session-in .24s cubic-bezier(.16,1,.3,1) both; }',
      '.dsh-pg-switch, .dsh-pg-btn { transition: transform .12s cubic-bezier(.4,0,.2,1), background-color .12s cubic-bezier(.4,0,.2,1); }',
      '.dsh-pg-switch:active { transform: scale(.94); }',
      '.dsh-pg-btn:active { transform: scale(.97); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-perfguard-motion="on"] .dsh-pg,',
      '  [data-perfguard-motion="on"] .dsh-pg-enter,',
      '  [data-perfguard-motion="on"] [data-conversation-content].dsh-pg-session-enter { animation: none; }',
      '  .dsh-pg-switch, .dsh-pg-btn { transition: none; }',
      '}',
      /* ---- 全局动效：对话框 / 菜单 / 面板 / 列表项 / 按钮 ---- */
      '@keyframes dsh-pg-pop { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }',
      '@keyframes dsh-pg-slide-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }',
      '[data-perfguard-motion="on"] [data-dockkit-pane], [data-perfguard-motion="on"] [data-dockkit-float] { animation: dsh-pg-slide-in .22s cubic-bezier(.16,1,.3,1) both; }',
      '[data-perfguard-motion="on"] [data-dockkit-tab] { transition: background-color .14s cubic-bezier(.4,0,.2,1), color .14s cubic-bezier(.4,0,.2,1), transform .14s cubic-bezier(.4,0,.2,1); }',
      '[data-perfguard-motion="on"] [data-dockkit-tab]:active { transform: scale(.985); }',
      '[data-perfguard-motion="on"] button, [data-perfguard-motion="on"] [role="button"] { transition: background-color .12s cubic-bezier(.4,0,.2,1), color .12s cubic-bezier(.4,0,.2,1), border-color .12s cubic-bezier(.4,0,.2,1), opacity .12s; }',
      '[data-perfguard-motion="on"] [data-chat-turn] { animation: dsh-pg-turn-in .26s cubic-bezier(.22,1,.36,1) both; }',
      /* ---- 界面质感：统一的圆角 / 留白 / 层次，降低「浏览器默认控件」感 ---- */
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-perfguard-motion="on"] [role="dialog"], [data-perfguard-motion="on"] [role="menu"],',
      '  [data-perfguard-motion="on"] [data-dockkit-pane], [data-perfguard-motion="on"] [data-chat-turn] { animation: none; }',
      '  [data-perfguard-motion="on"] button, [data-perfguard-motion="on"] [role="button"] { transition: none; }',
      '}',
      /* 对话区顶部一层极淡的极光洗色，让大面积留白不像空白表格。 */
      /* 设置页样式（全部走主题变量，深浅色自动跟随）。 */
      '.dsh-pg { display: flex; flex-direction: column; gap: 22px; max-width: 820px; padding: 10px 4px 40px; }',
      /* 柔和高级感：hero 用生成的极光底图 + 植物线稿，卡片用大圆角与极淡投影。 */
      '.dsh-pg-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 22px 22px 20px; border: 1px solid rgba(127,127,127,.14); background-image: url("/api/perf-guard/assets/aurora.png"); background-size: cover; background-position: center; }',
      '.dsh-pg-sprig { position: absolute; right: -30px; bottom: -52px; width: 210px; height: 210px; opacity: .34; pointer-events: none; user-select: none; }',
      '[data-ds-dark-theme] .dsh-pg-hero { background-image: linear-gradient(rgba(10,14,12,.62), rgba(10,14,12,.62)), url("/api/perf-guard/assets/aurora.png"); }',
      '[data-ds-dark-theme] .dsh-pg-sprig { opacity: .2; filter: invert(1) brightness(1.6); }',
      '.dsh-pg-head { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.dsh-pg-head-main { display: flex; flex-direction: column; gap: 6px; }',
      '.dsh-pg-badge { flex: none; font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 999px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); opacity: .68; }',
      '.dsh-pg-group { display: flex; flex-direction: column; gap: 10px; }',
      '.dsh-pg-group-title { font-size: 12px; font-weight: 600; letter-spacing: .08em; opacity: .58; }',
      '.dsh-pg-group-hint { font-size: 12px; line-height: 1.6; opacity: .55; margin-bottom: 2px; }',
      '.dsh-pg-title { font-size: 17px; font-weight: 600; letter-spacing: .01em; opacity: .94; }',
      '.dsh-pg-desc { font-size: 12px; line-height: 1.7; opacity: .62; }',
      '.dsh-pg-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--dsh-border, rgba(127,127,127,.18)); border-radius: 16px; background: var(--dsh-fill-1, rgba(127,127,127,.03)); box-shadow: 0 1px 2px rgba(20,30,25,.03), 0 12px 32px -22px rgba(20,30,25,.45); transition: border-color .16s cubic-bezier(.4,0,.2,1), box-shadow .16s cubic-bezier(.4,0,.2,1); }',
      '.dsh-pg-row:hover { border-color: var(--dsh-border-strong, rgba(127,127,127,.32)); box-shadow: 0 1px 2px rgba(20,30,25,.04), 0 16px 40px -24px rgba(20,30,25,.5); }',
      '.dsh-pg-row-main { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-pg-row b { font-size: 13px; font-weight: 600; }',
      '.dsh-pg-row span { font-size: 12px; line-height: 1.6; opacity: .62; }',
      '.dsh-pg-switch { flex: none; width: 38px; height: 22px; border-radius: 999px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); background: transparent; cursor: pointer; position: relative; }',
      '.dsh-pg-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsh-text-3, #999); transition: transform .16s ease; }',
      '.dsh-pg-switch[data-on="true"] { background: var(--dsh-accent, #4c8dff); border-color: transparent; }',
      '.dsh-pg-switch[data-on="true"]::after { transform: translateX(16px); background: #fff; }',
      '.dsh-pg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }',
      '.dsh-pg-card { padding: 14px 16px; border-radius: 16px; border: 1px solid var(--dsh-border, rgba(127,127,127,.18)); background: var(--dsh-fill-1, rgba(127,127,127,.03)); box-shadow: 0 1px 2px rgba(20,30,25,.03), 0 12px 32px -22px rgba(20,30,25,.45); }',
      '.dsh-pg-card em { display: block; font-style: normal; font-size: 11px; opacity: .55; margin-bottom: 4px; }',
      '.dsh-pg-card strong { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }',
      '.dsh-pg-list { margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 1.8; opacity: .75; }',
      '.dsh-pg-actions { display: flex; gap: 8px; }',
      '.dsh-pg-input { width: 72px; font-size: 13px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsh-border, rgba(127,127,127,.3)); background: transparent; color: inherit; text-align: center; }',
      '.dsh-pg-errors { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }',
      '.dsh-pg-error { display: flex; gap: 10px; align-items: baseline; padding: 6px 10px; border-radius: 8px; background: var(--dsh-fill-1, rgba(127,127,127,.05)); }',
      '.dsh-pg-error b { font-variant-numeric: tabular-nums; }',
      '.dsh-pg-error span { opacity: .62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
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
      root.dataset.perfguardMotion = prefs.motion ? 'on' : 'off'
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
    /**
     * 跟随最新输出（可注入环境，便于在 Node 里跑仿真）。
     *
     * 设计要点：
     *  - 只有「贴底」才算跟随；判定用 scrollHeight - scrollTop - clientHeight <= 24。
     *  - 解除跟随只认用户手势：滚轮向上、PageUp/↑/Home、按住滚动条拖动（pointerdown）。
     *    内容重排 / 浏览器滚动锚定造成的回退不算。
     *  - 只要用户正在操作（intent 窗口内），一律不写 scrollTop —— 避免"被拉回底部"。
     *  - 跟随中若 App 自己脱离了跟随（它渲染「回到底部」按钮），点它一次让 App 状态机自愈。
     */
    function createFollowController(env) {
      const doc = env.document
      const win = env.window
      const clock = env.performance
      const scrollerSelector = env.scrollerSelector || '[data-conversation-scroll]'
      const isEnabled = env.isEnabled || (() => true)
      const state = {
        mode: 'follow',
        intentUntil: 0,
        pointerDown: false,
        frame: 0,
        attached: null,
        /** 用 -Infinity 起步，否则时钟从 0 开始时会白白节流掉第一次。 */
        lastRestoreAt: Number.NEGATIVE_INFINITY,
        lastGap: 0,
        lastTop: 0,
        disabled: false,
      }

      function pickScroller() {
        const list = doc.querySelectorAll(scrollerSelector)
        let best = null
        for (const element of list) {
          if (element.clientHeight <= 0) continue
          if (best === null || element.clientHeight > best.clientHeight) best = element
        }
        return best
      }

      function gapOf(element) {
        return element.scrollHeight - element.scrollTop - element.clientHeight
      }

      function now() {
        return clock.now()
      }

      function intentActive() {
        return state.pointerDown || now() < state.intentUntil
      }

      function markIntent() {
        state.intentUntil = now() + 700
      }

      /** 用户明确的向上手势：立刻转为阅读模式，且不再由我们来滚。 */
      function markReading() {
        if (state.mode === 'reading') return
        state.mode = 'reading'
        if (env.onState) env.onState(state.mode)
      }

      function markFollow() {
        // 回到贴底：立刻清掉手势窗口，否则刚滚回底部还要再等 700ms 才恢复跟随。
        state.intentUntil = 0
        if (state.mode === 'follow') return
        state.mode = 'follow'
        if (env.onState) env.onState(state.mode)
      }

      function restoreAppFollow() {
        if (state.mode !== 'follow') return
        if (now() - state.lastRestoreAt < 900) return
        const button = doc.querySelector('[class*="toBottomSlot"] button')
        if (button === null || button === undefined) return
        state.lastRestoreAt = now()
        if (env.onRestore) env.onRestore()
        if (typeof button.click === 'function') button.click()
      }

      function step() {
        state.frame = 0
        if (state.disabled || !isEnabled()) return
        if (state.mode !== 'follow' || intentActive()) return
        const element = state.attached || pickScroller()
        if (element === null) return
        const gap = gapOf(element)
        if (gap <= 1) return
        element.scrollTop = element.scrollTop + Math.max(1, gap * 0.45)
        state.frame = win.requestAnimationFrame(step)
      }

      /** 内容变化时调用：跟随模式下请求一次追底。 */
      function follow() {
        if (state.disabled || !isEnabled()) return
        if (state.mode !== 'follow' || intentActive()) return
        restoreAppFollow()
        if (state.frame !== 0) return
        state.frame = win.requestAnimationFrame(step)
      }

      function onScroll(event) {
        const element = event.target
        if (!element || element !== state.attached) return
        const gap = gapOf(element)
        const movedUp = element.scrollTop < state.lastTop - 2
        state.lastTop = element.scrollTop
        state.lastGap = gap
        if (gap <= 24) {
          markFollow()
          return
        }
        if (state.mode !== 'follow') return
        // 只认「有手势的上移」。布局锚定同样会让 scrollTop 变小，但它没有手势。
        if (movedUp && intentActive()) markReading()
      }

      function onWheel(event) {
        if (state.disabled) return
        markIntent()
        if (event.deltaY < 0) markReading()
      }

      function onPointerDown(event) {
        if (state.disabled) return
        if (!event.target) return
        state.pointerDown = true
        markIntent()
      }

      function onPointerUp() {
        state.pointerDown = false
      }

      function onKeyDown(event) {
        if (event.key !== 'PageUp' && event.key !== 'ArrowUp' && event.key !== 'Home') return
        markIntent()
        markReading()
      }

      const observer = new env.MutationObserver(() => {
        follow()
      })

      function attach() {
        const element = pickScroller()
        if (element === null) return
        if (element !== state.attached) {
          if (state.attached !== null) observer.disconnect()
          state.attached = element
          state.lastTop = element.scrollTop
          state.lastGap = gapOf(element)
          state.mode = gapOf(element) <= 24 ? 'follow' : 'reading'
          observer.observe(element, { childList: true, subtree: true, characterData: true })
        }
      }

      function start() {
        attach()
        const timer = win.setInterval(attach, 1500)
        doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
        doc.addEventListener('wheel', onWheel, { capture: true, passive: true })
        doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
        doc.addEventListener('pointerup', onPointerUp, { capture: true, passive: true })
        doc.addEventListener('keydown', onKeyDown, { capture: true })
        return () => {
          state.disabled = true
          observer.disconnect()
          win.clearInterval(timer)
          win.cancelAnimationFrame(state.frame)
          doc.removeEventListener('scroll', onScroll, { capture: true })
          doc.removeEventListener('wheel', onWheel, { capture: true })
          doc.removeEventListener('pointerdown', onPointerDown, { capture: true })
          doc.removeEventListener('pointerup', onPointerUp, { capture: true })
          doc.removeEventListener('keydown', onKeyDown, { capture: true })
        }
      }

      return {
        start,
        state,
        /** 仅供测试：模拟一次内容增长后的回调。 */
        __follow: follow,
        __scroll: onScroll,
      }
    }

    function installFollowTail(isEnabled) {
      const controller = createFollowController({
        document,
        window,
        performance,
        MutationObserver,
        scrollerSelector: SCROLL_SELECTOR,
        isEnabled,
        onState: (mode) => {
          runtime.pinned = mode === 'follow'
        },
        onRestore: () => {
          runtime.restores += 1
        },
      })
      const stop = controller.start()
      runtime.scroller = controller.state.attached !== null
      return () => {
        stop()
      }
    }

    /** 中键关闭标签页（dockkit 标签 chip 上的 [data-dockkit-tab-close]）。 */
    function installMiddleClickClose() {
      const onAuxClick = (event) => {
        if (event.button !== 1) return
        const target = event.target
        if (!(target instanceof Element)) return
        const tab = target.closest('[data-dockkit-tab]')
        if (tab === null) return
        const close = tab.querySelector('[data-dockkit-tab-close]')
        if (close === null) return
        event.preventDefault()
        event.stopPropagation()
        close.click()
      }
      // 中键按下时浏览器可能进入自动滚动模式，先拦掉。
      const onMouseDown = (event) => {
        if (event.button !== 1) return
        if (event.target instanceof Element && event.target.closest('[data-dockkit-tab]') !== null) event.preventDefault()
      }
      document.addEventListener('auxclick', onAuxClick, true)
      document.addEventListener('mousedown', onMouseDown, true)
      return () => {
        document.removeEventListener('auxclick', onAuxClick, true)
        document.removeEventListener('mousedown', onMouseDown, true)
      }
    }

    /** 新回合淡入 + 会话切换整体过渡：只加 class，动画结束即摘除，不改布局。 */
    function installMotion(isEnabled) {
      const seen = new WeakSet()
      let sessionTimer = 0

      function play(element) {
        if (seen.has(element)) return
        seen.add(element)
        element.classList.add('dsh-pg-enter')
        const clear = () => {
          element.classList.remove('dsh-pg-enter')
          element.removeEventListener('animationend', clear)
        }
        element.addEventListener('animationend', clear)
        window.setTimeout(clear, 420)
      }

      function walk(root) {
        if (!(root instanceof Element)) return
        if (root.matches('[data-chat-turn]')) play(root)
        for (const turn of root.querySelectorAll('[data-chat-turn]')) play(turn)
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            if (!isEnabled()) continue
            const target = record.target
            if (!(target instanceof Element)) continue
            const content = target.closest('[data-conversation-content]') ?? target
            content.classList.remove('dsh-pg-session-enter')
            void content.offsetWidth
            content.classList.add('dsh-pg-session-enter')
            if (sessionTimer) window.clearTimeout(sessionTimer)
            sessionTimer = window.setTimeout(() => content.classList.remove('dsh-pg-session-enter'), 320)
            continue
          }
          if (!isEnabled()) continue
          for (const node of record.addedNodes) walk(node)
        }
      })
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-conversation-session'],
      })

      return () => {
        observer.disconnect()
        if (sessionTimer) window.clearTimeout(sessionTimer)
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
          title: '动效',
          hint: '新回合淡入上移 260ms、会话切换 240ms；曲线 easeOutQuint，系统「减少动态效果」时自动关闭。',
          rows: [
            ['motion', '界面动画', '新回合、会话切换、对话框、菜单、面板、按钮都做一次克制的过渡；动画只挂 class，不改布局，不再重复播放。'],          ],
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
      const retry = host && host.retry ? host.retry : null
      const errors = host && host.errors ? host.errors : []

      const saveRetry = (next) => {
        setStats((current) => (current && current.host ? { ...current, host: { ...current.host, retry: next } } : current))
        fetch(API + '/retry', {
          method: 'POST',
          headers: { 'x-dsh-plugin': 'perf-guard', 'content-type': 'application/json' },
          body: JSON.stringify(next),
        }).catch(() => {})
      }

      return h(
        'div',
        { className: 'dsh-pg' },
        h(
          'div',
          { className: 'dsh-pg-hero' },
          h('img', {
            className: 'dsh-pg-sprig',
            src: '/api/perf-guard/assets/sprig.png',
            alt: '',
            'aria-hidden': 'true',
            draggable: 'false',
          }),
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
          h('div', { className: 'dsh-pg-group-title' }, '错误与重试'),
          h('div', { className: 'dsh-pg-group-hint' }, 'HTTP 400/401/402/403/429/502/503 会带状态码、provider/model、响应片段写入宿主日志；按状态码分别开关自动重试，只在本轮尚未输出内容时重试。'),
          retry === null
            ? h('div', { className: 'dsh-pg-desc' }, '宿主半未连接，暂不可配置。')
            : [
                h(
                  'div',
                  { className: 'dsh-pg-row', key: 'log' },
                  h('div', { className: 'dsh-pg-row-main' }, h('b', null, '详细错误日志'), h('span', null, '把状态码、错误码、模型与响应片段写进 desktop-next.log，并在下方保留最近 20 条。')),
                  h(Switch, { on: retry.logErrors === true, onToggle: () => saveRetry({ ...retry, logErrors: retry.logErrors !== true }) }),
                ),
                h(
                  'div',
                  { className: 'dsh-pg-row', key: 'transport' },
                  h('div', { className: 'dsh-pg-row-main' }, h('b', null, '截断 / 传输中断重试'), h('span', null, '流被掐断、连接提前关闭、输出被截断（没有 HTTP 状态码）时整段重试；已经显示出来的部分会丢弃重来。')),
                  h(Switch, { on: retry.retryTransport === true, onToggle: () => saveRetry({ ...retry, retryTransport: retry.retryTransport !== true }) }),
                ),
                h(
                  'div',
                  { className: 'dsh-pg-row', key: 'max' },
                  h(
                    'div',
                    { className: 'dsh-pg-row-main' },
                    h('b', null, '最大重试次数'),
                    h('span', null, retry.maxRetries < 0 ? '当前不设上限：失败会一直重试，遇到持续故障可能长时间卡住，可随时关掉右侧开关。' : '0 表示不自动重试；指数退避 0.8s 起，429 优先用 Retry-After。'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-pg-actions' },
                    h('span', { className: 'dsh-pg-desc' }, '不限'),
                    h(Switch, {
                      on: retry.maxRetries < 0,
                      onToggle: () => saveRetry({ ...retry, maxRetries: retry.maxRetries < 0 ? 3 : -1 }),
                    }),
                    h('input', {
                      className: 'dsh-pg-input',
                      type: 'number',
                      min: 0,
                      max: 50,
                      disabled: retry.maxRetries < 0,
                      value: retry.maxRetries < 0 ? '' : retry.maxRetries,
                      onChange: (event) => {
                        const parsed = Number(event.target.value)
                        const value = Number.isFinite(parsed) ? Math.max(0, Math.min(50, Math.round(parsed))) : 0
                        saveRetry({ ...retry, maxRetries: value })
                      },
                    }),
                  ),
                ),
                ...Object.entries({ '400': '参数错误', '401': '鉴权失败', '402': '余额不足', '403': '无权限', '429': '限流', '502': '网关错误', '503': '服务不可用' }).map(([status, label]) =>
                  h(
                    'div',
                    { className: 'dsh-pg-row', key: 'status-' + status },
                    h('div', { className: 'dsh-pg-row-main' }, h('b', null, 'HTTP ' + status + ' · ' + label), h('span', null, retry.statuses[status] ? '失败后自动重试（未输出内容时）' : '只记录日志，不自动重试')),
                    h(Switch, {
                      on: retry.statuses[status] === true,
                      onToggle: () => saveRetry({ ...retry, statuses: { ...retry.statuses, [status]: retry.statuses[status] !== true } }),
                    }),
                  ),
                ),
                errors.length > 0
                  ? h(
                      'div',
                      { className: 'dsh-pg-errors', key: 'errors' },
                      ...errors.slice(0, 8).map((item, index) =>
                        h('div', { className: 'dsh-pg-error', key: String(index) },
                          h('b', null, String(item.status ?? '?')),
                          h('span', null, (item.provider ?? '-') + ' · ' + (item.code ?? '-') + ' · ' + item.message),
                        ),
                      ),
                    )
                  : null,
              ],
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
            h('div', { className: 'dsh-pg-card' }, h('em', null, '距底部'), h('strong', null, runtime.gap === undefined ? '-' : runtime.gap + ' px')),
            h('div', { className: 'dsh-pg-card' }, h('em', null, '跟随次数 / 重挂跟随'), h('strong', null, runtime.follows + ' / ' + runtime.restores)),
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
      ctx.effect(() => installMotion(() => readPrefs().motion))
      ctx.effect(() => installMiddleClickClose())

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
    /** 仅供测试：跟随控制器在假 DOM 上跑仿真。 */
    exports.__internals = { createFollowController }

    return module.exports
  },
})
