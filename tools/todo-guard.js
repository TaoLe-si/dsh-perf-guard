(() => {
  if (window.__pgTodoGuard) return JSON.stringify({ installed: false, reason: 'already' })
  const check = () => {
    const panel = document.querySelector('.dsh-pg-todos')
    if (!panel) return
    const content = document.querySelector('[data-conversation-content]')
    let active = true
    if (!content || content.getClientRects().length === 0) active = false
    else {
      const hit = document.elementFromPoint(Math.round(window.innerWidth * 0.5), Math.round(window.innerHeight * 0.35))
      active = !!(hit && content.contains(hit))
    }
    panel.style.display = active ? '' : 'none'
  }
  window.__pgTodoGuard = window.setInterval(check, 500)
  check()
  const panel = document.querySelector('.dsh-pg-todos')
  return JSON.stringify({ installed: true, display: panel ? panel.style.display : null })
})()