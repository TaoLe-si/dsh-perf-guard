(async () => {
  const sid = "216cd3de-bf66-4a15-866d-2c3e870ae2d2"
  const r = await fetch('/api/perf-guard/todos?sessionId=' + encodeURIComponent(sid), { headers: { 'x-dsh-plugin': 'perf-guard' } })
  const body = await r.text()
  return JSON.stringify({ status: r.status, body: body.slice(0, 600) })
})()