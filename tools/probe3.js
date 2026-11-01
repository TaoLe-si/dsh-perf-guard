(async () => {
  const out = {}
  const content = document.querySelector('[data-conversation-content]')
  out.sessionId = content ? content.getAttribute('data-conversation-session') : null
  out.panel = !!document.querySelector('.dsh-pg-todos')
  try {
    const r = await fetch('/api/perf-guard/todos?sessionId=' + encodeURIComponent(out.sessionId || ''), { headers: { 'x-dsh-plugin': 'perf-guard' } })
    out.status = r.status
    out.body = (await r.text()).slice(0, 500)
  } catch (e) { out.fetchError = String(e) }
  out.todoDom = [...document.querySelectorAll('[class*=todo], [data-todo]')].slice(0, 5).map((el) => el.className.toString().slice(0, 80))
  return JSON.stringify(out)
})()