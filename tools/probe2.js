(() => {
  const out = { loaded: !!window.__dshPerfGuard, state: window.__dshPerfGuard || null }
  const scroller = document.querySelector('[data-conversation-scroll]')
  out.gap = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null
  out.toBottom = !!document.querySelector('[class*="toBottomSlot"] button')
  const key = Object.keys(localStorage).find((k) => k.startsWith('dsh.conversation.'))
  out.storeKey = key || null
  if (key) {
    try {
      const raw = localStorage.getItem(key) || ''
      out.storeSample = raw.slice(0, 300)
      out.hasTodos = /"todos"|"todo_write"/.test(raw)
    } catch (e) { out.storeError = String(e) }
  }
  const text = (document.body.innerText || '')
  out.todoMarkers = ['待办', 'TODO', 'TODOS', 'todo_write', '已完成', '进行中'].filter((m) => text.includes(m))
  return JSON.stringify(out)
})()