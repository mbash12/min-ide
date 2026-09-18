const { marked } = require('marked')
const createDOMPurify = require('dompurify')

/* GFM (tables, task lists, strikethrough, fenced code) plus chat-style
soft line breaks. Raw HTML in the model output is parsed by marked and
then stripped to a tag whitelist by DOMPurify. */
marked.setOptions({
  gfm: true,
  breaks: true
})

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'span', 'div',
    'strong', 'em', 'del', 's', 'code', 'pre',
    'a', 'blockquote', 'hr',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'input', 'sup', 'sub'
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'target', 'rel',
    'class', 'src', 'alt',
    'type', 'checked', 'disabled',
    'colspan', 'rowspan', 'start', 'align'
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|min):/i
}

const boundRoots = new WeakSet()
let purifyHooksInstalled = false

function getPurify () {
  if (typeof createDOMPurify.sanitize === 'function') return createDOMPurify
  return createDOMPurify(window)
}

function installPurifyHooks (purify) {
  if (purifyHooksInstalled) return
  purifyHooksInstalled = true
  purify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || ''
      if (!/^(https?:|mailto:|min:)/i.test(href)) {
        node.removeAttribute('href')
      }
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || ''
      if (!/^https?:/i.test(src)) node.removeAttribute('src')
    }
    if (node.tagName === 'INPUT') {
      node.setAttribute('disabled', '')
      if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox' && node.parentNode) {
        node.parentNode.removeChild(node)
      }
    }
  })
}

function sanitize (html) {
  const purify = getPurify()
  installPurifyHooks(purify)
  return purify.sanitize(html, PURIFY_CONFIG)
}

function wrapCodeBlocks (root) {
  const codes = root.querySelectorAll('pre > code')
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    const pre = code.parentNode
    if (!pre || !pre.parentNode || pre.parentNode.classList.contains('agent-md-code')) continue
    const langMatch = String(code.className || '').match(/language-([\w+-]+)/)
    const wrap = document.createElement('div')
    wrap.className = 'agent-md-code'
    const head = document.createElement('div')
    head.className = 'agent-md-code-head'
    const lang = document.createElement('span')
    lang.className = 'agent-md-code-lang'
    lang.textContent = langMatch ? langMatch[1] : 'code'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'agent-md-copy'
    copy.title = 'Copy'
    const icon = document.createElement('i')
    icon.className = 'codicon codicon-copy'
    copy.appendChild(icon)
    head.appendChild(lang)
    head.appendChild(copy)
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(head)
    wrap.appendChild(pre)
  }
}

function wrapTables (root) {
  const tables = root.querySelectorAll('table')
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]
    if (table.parentNode && table.parentNode.classList.contains('agent-md-table-wrap')) continue
    const wrap = document.createElement('div')
    wrap.className = 'agent-md-table-wrap'
    table.parentNode.insertBefore(wrap, table)
    wrap.appendChild(table)
  }
}

function markTaskItems (root) {
  const inputs = root.querySelectorAll('li > input[type="checkbox"]')
  for (let i = 0; i < inputs.length; i++) {
    inputs[i].parentNode.classList.add('agent-md-task')
    inputs[i].disabled = true
  }
}

function onRootClick (e) {
  const btn = e.target.closest && e.target.closest('.agent-md-copy')
  if (!btn) return
  e.preventDefault()
  e.stopPropagation()
  const wrap = btn.closest('.agent-md-code')
  const pre = wrap && wrap.querySelector('pre')
  const text = pre ? pre.textContent : ''
  const icon = btn.querySelector('.codicon')
  const done = function () {
    if (!icon) return
    icon.className = 'codicon codicon-check'
    setTimeout(function () { icon.className = 'codicon codicon-copy' }, 1200)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { done() })
  } else {
    done()
  }
}

function bindRoot (root) {
  if (boundRoots.has(root)) return
  boundRoots.add(root)
  root.addEventListener('click', onRootClick)
}

function render (root, text) {
  bindRoot(root)
  root.classList.add('agent-md')
  const src = String(text || '')
  if (!src) {
    root.textContent = ''
    return
  }
  let html
  try {
    html = marked.parse(src)
  } catch (err) {
    console.warn('markdown parse failed', err)
    root.textContent = src
    return
  }
  root.innerHTML = sanitize(html)
  wrapCodeBlocks(root)
  wrapTables(root)
  markTaskItems(root)
}

module.exports = { render }
