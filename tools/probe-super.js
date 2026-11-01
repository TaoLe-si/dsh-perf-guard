(() => {
  const text = document.body.innerText || ''
  return JSON.stringify({
    hasSuperagentText: /superagent|Superagent|SuperAgent/.test(text),
    sections: [...document.querySelectorAll('[class*="section"], [role="tab"]')].slice(0, 8).map((el) => (el.textContent || '').trim().slice(0, 20)),
    perfGuard: !!window.__dshPerfGuard,
  })
})()