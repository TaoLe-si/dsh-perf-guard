(async () => {
  const content = document.querySelector('[data-conversation-content]')
  const sessionId = content ? content.getAttribute('data-conversation-session') : ''
  const out = { sessionId, hasPanel: !!document.querySelector('.dsh-pg-todos') }
  try {
    const r = await fetch('/api/perf-guard/health', { headers: { 'x-dsh-plugin': 'perf-guard' } })
    out.health = r.status
    out.version = (await r.json()).version
  } catch (e) { out.healthError = String(e) }
  try {
    const r = await fetch('/api/perf-guard/todos?sessionId=' + encodeURIComponent(sessionId), { headers: { 'x-dsh-plugin': 'perf-guard' } })
    out.todosStatus = r.status
    out.todosBody = (await r.text()).slice(0, 200)
  } catch (e) { out.todosError = String(e) }
  return JSON.stringify(out)
})()