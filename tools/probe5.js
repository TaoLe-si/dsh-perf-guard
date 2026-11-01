(() => {
  const info = (el) => el === null ? null : { tag: el.tagName, cls: (el.className || '').toString().slice(0, 90), attrs: [...el.attributes].map(a => a.name).slice(0, 6) }
  const root = document.querySelector('#root')
  const kids = root ? [...root.children].map((el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 90) })) : []
  return JSON.stringify({
    rootKids: kids,
    sidebar: info(document.querySelector('aside') || document.querySelector('[class*=sidebar i]')),
    header: info(document.querySelector('[data-conversation-content]')?.previousElementSibling ?? null),
    tabs: [...document.querySelectorAll('[role=tab], [data-tab]')].slice(0, 5).map(info),
    newChat: info([...document.querySelectorAll('button')].find((b) => /新会话|New chat/.test(b.textContent || '')) || null),
    sessionRows: [...document.querySelectorAll('[class*=session i][class*=row i]')].slice(0, 3).map(info),
  })
})()