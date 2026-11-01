(() => {
  if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch }
  return JSON.stringify({ restored: !window.__origFetch })
})()