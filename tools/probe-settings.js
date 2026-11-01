(() => {
  const scroller = document.querySelector('[data-conversation-scroll]')
  const content = document.querySelector('[data-conversation-content]')
  const dialogs = [...document.querySelectorAll('[role="dialog"], [data-modal], [aria-modal="true"]')].map((el) => ({
    tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), rect: el.getBoundingClientRect().height,
  }))
  const panel = document.querySelector('.dsh-pg-todos')
  return JSON.stringify({
    hasScroller: !!scroller,
    scrollerVisible: scroller ? (scroller.getClientRects().length > 0 && scroller.clientHeight > 0) : false,
    scrollerHeight: scroller ? scroller.clientHeight : null,
    hasContent: !!content,
    contentVisible: content ? content.getClientRects().length > 0 : false,
    dialogs,
    panelMounted: !!panel,
    panelRect: panel ? (() => { const r = panel.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)] })() : null,
  })
})()