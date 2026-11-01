(() => {
  const style = document.getElementById('dsh-perf-guard-style')
  if (!style) return JSON.stringify({ found: false })
  const lines = style.textContent.split('\n')
  const kept = lines.filter((line) => !/animation:\s*dsh-pg-(pop|fade-in|slide-in|turn-in|session-in|reveal)/.test(line))
  style.textContent = kept.join('\n')
  return JSON.stringify({
    removed: lines.length - kept.length,
    remainingAnim: (style.textContent.match(/animation:\s*dsh-pg-/g) || []).length,
    menuLine: kept.filter((l) => l.includes('role="menu"')).length,
  })
})()