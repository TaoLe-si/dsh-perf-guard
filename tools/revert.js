(() => {
  const removed = []
  for (const id of ['__pg_probe', '__pg_probe2', '__pg_probe3']) {
    const node = document.getElementById(id)
    if (node) { node.remove(); removed.push(id) }
  }
  const link = document.getElementById('dsh-perf-guard-atelier')
  if (link) { link.remove(); removed.push('atelier-link') }
  const style = document.getElementById('dsh-perf-guard-style')
  document.documentElement.removeAttribute('data-perfguard-polish')
  return JSON.stringify({ removed, polishAttr: document.documentElement.hasAttribute('data-perfguard-polish') })
})()