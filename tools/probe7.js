(async () => {
  const content = document.querySelector('[data-conversation-content]')
  const sid = content ? content.getAttribute('data-conversation-session') : ''
  const r = await fetch('/api/perf-guard/todos?sessionId=' + encodeURIComponent(sid), { headers: { 'x-dsh-plugin': 'perf-guard' } })
  const data = await r.json()
  await new Promise((resolve) => setTimeout(resolve, 6000))
  const panel = document.querySelector('.dsh-pg-todos')
  return JSON.stringify({
    sessionId: sid,
    count: Array.isArray(data.todos) ? data.todos.length : -1,
    first: data.todos && data.todos[0] ? data.todos[0].content.slice(0, 60) : null,
    panelMounted: !!panel,
    panelText: panel ? panel.innerText.slice(0, 200) : null,
  })
})()