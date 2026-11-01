(() => {
  const pick = (el) => el ? { tag: el.tagName, cls: (el.className || '').toString().slice(0,140), attrs: [...el.attributes].map(a => a.name + '=' + String(a.value).slice(0,40)).slice(0,8) } : null
  return JSON.stringify({
    root: pick(document.querySelector('#root')),
    scroll: pick(document.querySelector('[data-conversation-scroll]')),
    content: pick(document.querySelector('[data-conversation-content]')),
    composer: pick(document.querySelector('[data-composer-seat]')),
    todoEls: [...document.querySelectorAll('[data-todo], [class*=todo], [class*=Todo]')].slice(0, 8).map(pick),
    todoText: [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /待办|TODO|todo/.test(el.textContent || '')).slice(0, 5).map((el) => ({ text: (el.textContent || '').slice(0, 50), cls: (el.className || '').toString().slice(0, 70) })),
    storage: Object.keys(localStorage).slice(0, 20),
    bodyKids: [...document.body.children].map((el) => ({ tag: el.tagName, id: el.id, cls: (el.className || '').toString().slice(0, 90) })),
  })
})()