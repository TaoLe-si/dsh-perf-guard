(() => {
  const style = document.getElementById('dsh-perf-guard-style')
  if (!style) return JSON.stringify({ stylePresent: false })
  const css = style.textContent
  return JSON.stringify({
    stylePresent: true,
    menuRule: /\[role="menu"\][^{]*\{/.test(css),
    dialogRule: /\[role="dialog"\][^{]*\{/.test(css),
    length: css.length,
  })
})()