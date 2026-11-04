(async () => {
  if (window.__pgTodoGuard) { clearInterval(window.__pgTodoGuard); delete window.__pgTodoGuard }
  const panel = document.querySelector('.dsh-pg-todos')
  if (panel) panel.remove()
  let todosStatus = null
  try {
    const r = await fetch('/api/perf-guard/todos?sessionId=x', { headers: { 'x-dsh-plugin': 'perf-guard' } })
    todosStatus = r.status
  } catch (e) { todosStatus = 'ERR ' + e }
  const health = await fetch('/api/perf-guard/health', { headers: { 'x-dsh-plugin': 'perf-guard' } }).then((r) => r.json()).catch(() => null)
  return JSON.stringify({ todosStatus, version: health && health.version, panelLeft: !!document.querySelector('.dsh-pg-todos') })
})()