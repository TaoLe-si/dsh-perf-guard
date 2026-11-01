(async () => {
  if (!window.__origFetch) window.__origFetch = window.fetch
  const demo = [
    { content: '对齐待办投影字段（content / status）', status: 'completed' },
    { content: '把待办面板接到 shell.overlay 常驻层', status: 'in_progress' },
    { content: '验证切会话与插话后不丢失', status: 'pending' },
    { content: '给面板补发丝边与柔和投影', status: 'pending' },
  ]
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.includes('/api/perf-guard/todos')) {
      return new Response(JSON.stringify({ ok: true, todos: demo }), { headers: { 'content-type': 'application/json' } })
    }
    return window.__origFetch(input, init)
  }
  await new Promise((resolve) => setTimeout(resolve, 5500))
  const panel = document.querySelector('.dsh-pg-todos')
  return JSON.stringify({
    panelMounted: !!panel,
    text: panel ? panel.innerText.slice(0, 220) : null,
    rect: panel ? (() => { const r = panel.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })() : null,
  })
})()