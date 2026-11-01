(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /设置|Settings/.test((b.getAttribute('aria-label') || '') + (b.textContent || '')))
  if (!btn) return JSON.stringify({ opened: false, reason: 'no settings trigger' })
  btn.click()
  await new Promise((resolve) => setTimeout(resolve, 900))
  const dialog = document.querySelector('[role=dialog], [data-modal]')
  return JSON.stringify({ opened: !!dialog, title: dialog ? (dialog.innerText || '').slice(0, 80) : null })
})()