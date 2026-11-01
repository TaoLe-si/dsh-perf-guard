(() => {
  const style = document.getElementById('dsh-perf-guard-style')
  if (!style) return JSON.stringify({ found: false })
  const before = style.textContent.length
  style.textContent = style.textContent
    .split('\n')
    .filter((line) => !/data-perfguard-(motion|reveal)/.test(line))
    .join('\n')
  return JSON.stringify({ found: true, before, after: style.textContent.length, menus: (style.textContent.match(/role="menu"/g) || []).length })
})()