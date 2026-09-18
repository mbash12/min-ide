/* global viewMap, windows, ipc, loadURLInView, sendIPCToWindow, getWindowWebContents, location, KeyboardEvent, MouseEvent, PointerEvent, DragEvent, DataTransfer, document, window, fs, path, app, minDownloadBeginCapture, minDownloadCancelCapture */
/* Browser automation used by the AI agent tools and playbook runner.
Runs in the main process against Electron WebContentsViews. Tab create /
close / select is delegated to the renderer, where Min's tab state lives. */

var browserControlPending = new Map()
var browserControlReqId = 0

function browserControlSelectedId () {
  const win = windows.getCurrent()
  if (!win) return null
  const state = windows.getState(win)
  return (state && state.selectedView) || null
}

function browserControlTabInfo (id) {
  const view = viewMap[id]
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { id: id, url: '', title: '', selected: false, loading: false }
  }
  return {
    id: id,
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    selected: browserControlSelectedId() === id,
    loading: view.webContents.isLoading()
  }
}

function browserControlAskRenderer (action, payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const win = windows.getCurrent()
    if (!win) {
      reject(new Error('No browser window'))
      return
    }
    const id = ++browserControlReqId
    const timer = setTimeout(function () {
      browserControlPending.delete(id)
      reject(new Error('Timed out waiting for ' + action))
    }, timeoutMs || 8000)
    browserControlPending.set(id, { resolve: resolve, reject: reject, timer: timer })
    sendIPCToWindow(win, 'browser-control', {
      id: id,
      action: action,
      payload: payload || {}
    })
  })
}

ipc.on('browser-control-result', function (e, data) {
  if (!data || data.id == null) return
  const pending = browserControlPending.get(data.id)
  if (!pending) return
  clearTimeout(pending.timer)
  browserControlPending.delete(data.id)
  if (data.error) {
    pending.reject(new Error(data.error))
  } else {
    pending.resolve(data.result)
  }
  if ((data.result && data.result.restoreChromeFocus) || data.restoreChromeFocus) {
    browserControlRestoreChromeFocus(true)
  }
})

function browserControlRestoreChromeFocus (keep) {
  if (!keep) return
  const win = windows.getCurrent()
  if (!win) return
  try {
    getWindowWebContents(win).focus()
  } catch (e) {}
  try {
    sendIPCToWindow(win, 'browser-control-restore-focus')
  } catch (e2) {}
}

function browserControlSleep (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

async function browserControlWaitForView (id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000)
  while (Date.now() < deadline) {
    const view = viewMap[id]
    if (view && view.webContents && !view.webContents.isDestroyed()) {
      return view
    }
    await browserControlSleep(50)
  }
  return null
}

function browserControlIsRestrictedUrl (url) {
  if (!url || typeof url !== 'string') return false
  const parsed = url.trim().toLowerCase()
  return parsed.indexOf('min://settings') === 0 ||
    parsed.indexOf('min://prosettings') === 0 ||
    parsed.indexOf('min://profiles') === 0 ||
    parsed.indexOf('min://app/pages/settings') === 0 ||
    parsed.indexOf('min://app/pages/prosettings') === 0 ||
    parsed.indexOf('min://app/pages/profiles') === 0 ||
    parsed.indexOf('/pages/settings/') !== -1 ||
    parsed.indexOf('/pages/prosettings/') !== -1 ||
    parsed.indexOf('/pages/profiles/') !== -1
}

function browserControlRestrictedError () {
  return { ok: false, error: 'Browser tools cannot control settings or profile pages' }
}

async function browserControlTargetView (tabId, taskId, workspaceId, options) {
  options = options || {}
  if (!taskId && !workspaceId) {
    return { error: 'taskId is required; browser tools are scoped to one task' }
  }
  let resolved
  try {
    resolved = await browserControlAskRenderer('resolveTab', {
      tabId: tabId || null,
      taskId: taskId || null,
      workspaceId: workspaceId || null,
      ensureView: options.ensureView !== false,
      focus: false
    }, 8000)
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
  if (!resolved || resolved.ok === false) {
    return { error: (resolved && resolved.error) || 'Tab not found in this task' }
  }
  const id = resolved.tabId
  let view = viewMap[id]
  if (!view) {
    view = await browserControlWaitForView(id, 4000)
  }
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { error: 'Tab not found: ' + id }
  }
  const url = view.webContents.getURL() || resolved.url || ''
  if (options.allowRestricted !== true && browserControlIsRestrictedUrl(url)) {
    return { error: 'Browser tools cannot control settings or profile pages' }
  }
  return { id: id, view: view, taskId: taskId || (resolved && resolved.taskId), workspaceId: workspaceId || (resolved && resolved.workspaceId), url: url, keepChromeFocus: !!(resolved && resolved.keepChromeFocus) }
}

function browserControlWaitIdle (view, timeoutMs) {
  return new Promise(function (resolve) {
    const wc = view.webContents
    if (!wc || wc.isDestroyed() || !wc.isLoading()) {
      resolve({ ok: true, timedOut: false })
      return
    }
    const timeout = setTimeout(function () {
      cleanup()
      resolve({ ok: true, timedOut: true })
    }, timeoutMs || 30000)
    function done () {
      cleanup()
      resolve({ ok: true, timedOut: false })
    }
    function cleanup () {
      clearTimeout(timeout)
      try { wc.removeListener('did-stop-loading', done) } catch (e) {}
      try { wc.removeListener('did-finish-load', done) } catch (e) {}
    }
    wc.once('did-stop-loading', done)
    wc.once('did-finish-load', done)
  })
}

/* Serialized into the page. Must stay self-contained (no closures). */
function browserControlPageDom (opts) {
  opts = opts || {}
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, option, [draggable="true"], [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [role="tab"], [role="switch"], [role="slider"], [role="option"], [contenteditable="true"]'

  function visible (el) {
    if (!el || el.nodeType !== 1) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
    const style = view.getComputedStyle(el)
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 && r.height < 1) return false
    return true
  }

  function isLive (el) {
    return !!(el && el.nodeType === 1 && el.isConnected && visible(el))
  }

  function accessibleName (el) {
    if (!el) return ''
    let label = ''
    if (el.getAttribute('aria-label')) label = el.getAttribute('aria-label')
    else if (el.labels && el.labels[0]) label = el.labels[0].innerText
    else if (el.getAttribute('placeholder')) label = el.getAttribute('placeholder')
    else if (el.getAttribute('alt')) label = el.getAttribute('alt')
    else if (el.getAttribute('title')) label = el.getAttribute('title')
    else if (el.getAttribute('name')) label = el.getAttribute('name')
    else label = el.innerText || el.value || ''
    return String(label).replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  function roleOf (el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'file') return 'button'
      return 'textbox'
    }
    return tag
  }

  function cssEscape (value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value))
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch
    })
  }

  function uniqueSelector (sel) {
    try { return document.querySelectorAll(sel).length === 1 } catch (e) { return false }
  }

  function cssSelector (el) {
    const attrs = ['data-testid', 'data-test-id', 'data-cy', 'data-qa']
    let i
    for (i = 0; i < attrs.length; i++) {
      const a = el.getAttribute(attrs[i])
      if (a) {
        const sel = '[' + attrs[i] + '="' + cssEscape(a) + '"]'
        if (uniqueSelector(sel)) return sel
      }
    }
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const sel = '#' + cssEscape(el.id)
      if (uniqueSelector(sel)) return sel
    }
    const tag = el.tagName.toLowerCase()
    const name = el.getAttribute('name')
    if (name) {
      const sel = tag + '[name="' + cssEscape(name) + '"]'
      if (uniqueSelector(sel)) return sel
    }
    const aria = el.getAttribute('aria-label')
    if (aria) {
      const sel = '[aria-label="' + cssEscape(aria) + '"]'
      if (uniqueSelector(sel)) return sel
    }
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) {
      const sel = tag + '[placeholder="' + cssEscape(placeholder) + '"]'
      if (uniqueSelector(sel)) return sel
    }
    const parts = []
    let node = el
    let depth = 0
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
      const t = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (!parent) break
      let index = 1
      let count = 0
      let j
      for (j = 0; j < parent.children.length; j++) {
        if (parent.children[j].tagName === node.tagName) {
          count++
          if (parent.children[j] === node) index = count
        }
      }
      parts.unshift(count > 1 ? t + ':nth-of-type(' + index + ')' : t)
      node = parent
      depth++
    }
    return parts.join(' > ')
  }

  function liveEl (entry) {
    if (!entry) return null
    if (entry.nodeType === 1) return isLive(entry) ? entry : null
    return isLive(entry.el) ? entry.el : null
  }

  function forEachDeep (root, fn) {
    if (!root) return
    let list
    try { list = root.querySelectorAll('*') } catch (e) { return }
    let i
    for (i = 0; i < list.length; i++) {
      fn(list[i])
      if (list[i].shadowRoot) forEachDeep(list[i].shadowRoot, fn)
      if (list[i].tagName === 'IFRAME') {
        try {
          const doc = list[i].contentDocument
          if (doc) forEachDeep(doc, fn)
        } catch (e2) {}
      }
    }
  }

  function queryDeep (selector, root) {
    root = root || document
    try {
      const hit = root.querySelector(selector)
      if (hit) return hit
    } catch (e) {}
    let list
    try { list = root.querySelectorAll('*') } catch (e2) { return null }
    let i
    for (i = 0; i < list.length; i++) {
      if (list[i].shadowRoot) {
        const found = queryDeep(selector, list[i].shadowRoot)
        if (found) return found
      }
      if (list[i].tagName === 'IFRAME') {
        try {
          const doc = list[i].contentDocument
          if (doc) {
            const found = queryDeep(selector, doc)
            if (found) return found
          }
        } catch (e3) {}
      }
    }
    return null
  }

  function viewportPoint (el) {
    const r = el.getBoundingClientRect()
    let x = r.left + r.width / 2
    let y = r.top + r.height / 2
    let win = el.ownerDocument && el.ownerDocument.defaultView
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect()
      x += fr.left
      y += fr.top
      win = win.parent
    }
    return { x: x, y: y, width: r.width, height: r.height }
  }

  function collectInteractive () {
    const out = []
    const seen = []
    function consider (el) {
      if (!el || el.nodeType !== 1 || seen.indexOf(el) !== -1) return
      try {
        if (el.matches && el.matches(INTERACTIVE)) {
          seen.push(el)
          out.push(el)
        }
      } catch (e) {}
    }
    consider(document.documentElement)
    forEachDeep(document, consider)
    return out
  }

  function findByRoleName (role, name, nth, contains) {
    const needle = String(name || '').trim().toLowerCase()
    if (!needle) return null
    const nodes = collectInteractive()
    const matches = []
    let i
    for (i = 0; i < nodes.length; i++) {
      if (!isLive(nodes[i])) continue
      if (role && roleOf(nodes[i]) !== role) continue
      const label = accessibleName(nodes[i]).toLowerCase()
      if (contains) {
        if (label.indexOf(needle) !== -1) matches.push(nodes[i])
      } else if (label === needle) {
        matches.push(nodes[i])
      }
    }
    if (!matches.length) return null
    const index = typeof nth === 'number' ? nth : 0
    return matches[Math.max(0, Math.min(index, matches.length - 1))] || null
  }

  function resolveOnce (spec) {
    spec = spec || {}
    if (spec.ref && window.__minAgentRefs) {
      const entry = window.__minAgentRefs[spec.ref]
      const live = liveEl(entry)
      if (live) return live
      if (entry && entry.nodeType !== 1) {
        if (entry.selector) {
          try {
            const bySel = document.querySelector(entry.selector)
            if (isLive(bySel)) return bySel
          } catch (e) {}
        }
        if (entry.role || entry.name) {
          const found = findByRoleName(entry.role, entry.name, entry.nth, false) ||
            findByRoleName(entry.role, entry.name, entry.nth, true)
          if (found) return found
        }
      }
    }
    if (spec.selector) {
      try {
        const el = queryDeep(spec.selector)
        if (isLive(el)) return el
      } catch (e) {}
    }
    if (spec.role || spec.text) {
      const found = findByRoleName(spec.role, spec.text, spec.nth, false) ||
        findByRoleName(spec.role, spec.text, spec.nth, true)
      if (found) return found
    }
    return null
  }

  function waitLive (spec, timeoutMs) {
    spec = spec || {}
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : 4000
    return new Promise(function (resolve) {
      const start = Date.now()
      let lastBox = ''
      let stableAt = 0
      function tick () {
        const el = resolveOnce(spec)
        if (el) {
          const r = el.getBoundingClientRect()
          const box = r.x + ',' + r.y + ',' + r.width + ',' + r.height
          if (box === lastBox) {
            if (Date.now() - stableAt >= 60) {
              resolve(el)
              return
            }
          } else {
            lastBox = box
            stableAt = Date.now()
          }
        }
        if (Date.now() - start >= timeout) {
          resolve(null)
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  function pointOf (el, spec) {
    if (spec && spec.x != null && spec.y != null) {
      return { x: spec.x, y: spec.y }
    }
    return viewportPoint(el)
  }

  function fireAt (type, x, y, extra) {
    extra = extra || {}
    const target = extra.target || document.elementFromPoint(x, y) || document.body
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      buttons: extra.buttons || 0,
      button: extra.button || 0,
      view: window,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    }
    if (type.indexOf('pointer') === 0) {
      target.dispatchEvent(new PointerEvent(type, base))
    } else if (type.indexOf('drag') === 0 || type === 'drop') {
      target.dispatchEvent(new DragEvent(type, Object.assign({}, base, {
        dataTransfer: extra.dataTransfer || null
      })))
    } else {
      target.dispatchEvent(new MouseEvent(type, base))
    }
    return target
  }

  function performClick (el, spec) {
    spec = spec || {}
    const p = pointOf(el, spec)
    const buttonName = spec.button || opts.button || 'left'
    const clickCount = spec.clickCount || opts.clickCount || 1
    const which = buttonName === 'right' ? 2 : (buttonName === 'middle' ? 1 : 0)
    const extra = { target: el, button: which, buttons: which === 0 ? 1 : 0 }
    fireAt('pointerover', p.x, p.y, extra)
    fireAt('mouseover', p.x, p.y, extra)
    let n
    for (n = 1; n <= clickCount; n++) {
      fireAt('pointerdown', p.x, p.y, extra)
      fireAt('mousedown', p.x, p.y, extra)
      try { if (!opts.keepChromeFocus) el.focus() } catch (e) {}
      fireAt('pointerup', p.x, p.y, extra)
      fireAt('mouseup', p.x, p.y, extra)
      if (buttonName === 'right') {
        fireAt('contextmenu', p.x, p.y, extra)
      } else {
        fireAt('click', p.x, p.y, extra)
        if (clickCount >= 2 && n === clickCount) fireAt('dblclick', p.x, p.y, extra)
      }
    }
  }

  function performHover (el, spec) {
    const p = pointOf(el, spec)
    fireAt('pointerover', p.x, p.y, { target: el })
    fireAt('pointerenter', p.x, p.y, { target: el })
    fireAt('mouseover', p.x, p.y, { target: el })
    fireAt('mouseenter', p.x, p.y, { target: el })
    fireAt('pointermove', p.x, p.y, { target: el })
    fireAt('mousemove', p.x, p.y, { target: el })
  }

  function performDrag (fromEl, toEl, spec) {
    const start = pointOf(fromEl, { x: spec.x, y: spec.y })
    const end = pointOf(toEl, { x: spec.targetX, y: spec.targetY })
    const moves = Math.max(2, Math.min(40, typeof spec.moves === 'number' ? spec.moves : 12))
    let dt = null
    try { dt = new DataTransfer() } catch (e) { dt = null }
    if (dt && dt.setData) {
      try { dt.setData('text/plain', accessibleName(fromEl) || 'drag') } catch (e) {}
    }
    fireAt('pointerover', start.x, start.y, { target: fromEl })
    fireAt('pointerdown', start.x, start.y, { buttons: 1, target: fromEl })
    fireAt('mousedown', start.x, start.y, { buttons: 1, target: fromEl })
    fireAt('dragstart', start.x, start.y, { target: fromEl, dataTransfer: dt, buttons: 1 })
    let i
    for (i = 1; i <= moves; i++) {
      const t = i / moves
      const x = start.x + (end.x - start.x) * t
      const y = start.y + (end.y - start.y) * t
      const over = document.elementFromPoint(x, y) || toEl
      fireAt('pointermove', x, y, { buttons: 1, target: over })
      fireAt('mousemove', x, y, { buttons: 1, target: over })
      fireAt('dragover', x, y, { target: over, dataTransfer: dt, buttons: 1 })
    }
    fireAt('dragenter', end.x, end.y, { target: toEl, dataTransfer: dt, buttons: 1 })
    fireAt('dragover', end.x, end.y, { target: toEl, dataTransfer: dt, buttons: 1 })
    fireAt('drop', end.x, end.y, { target: toEl, dataTransfer: dt, buttons: 1 })
    fireAt('pointerup', end.x, end.y, { target: toEl })
    fireAt('mouseup', end.x, end.y, { target: toEl })
    fireAt('dragend', end.x, end.y, { target: fromEl, dataTransfer: dt })
  }

  function nativeSetValue (el, value) {
    const tag = el.tagName
    const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  if (opts.op === 'snapshot') {
    const refs = {}
    const seen = {}
    let n = 0
    const lines = []
    lines.push('- document: ' + (document.title || '') + ' url=' + location.href)
    const nodes = []
    forEachDeep(document, function (el) {
      if (!el || !el.tagName) return
      const tag = el.tagName.toLowerCase()
      if (/^h[1-6]$/.test(tag) || (el.matches && el.matches(INTERACTIVE))) nodes.push(el)
    })
    let i
    for (i = 0; i < nodes.length && n < 250; i++) {
      const el = nodes[i]
      if (!visible(el)) continue
      const tag = el.tagName.toLowerCase()
      const name = accessibleName(el)
      if (/^h[1-6]$/.test(tag)) {
        if (name) lines.push('  - heading "' + name.replace(/"/g, '\\"') + '"')
        continue
      }
      n += 1
      const ref = 'e' + n
      const role = roleOf(el)
      const selector = cssSelector(el)
      const seenKey = role + '\0' + name.toLowerCase()
      const nth = seen[seenKey] || 0
      seen[seenKey] = nth + 1
      refs[ref] = { el: el, role: role, name: name, selector: selector, nth: nth }
      let extra = ''
      if (selector) extra += ' selector=' + selector
      if (el.href) extra += ' href=' + el.href
      if ((tag === 'input' || tag === 'textarea') && el.value) {
        extra += ' value="' + String(el.value).slice(0, 60).replace(/"/g, '\\"') + '"'
      }
      if (el.disabled) extra += ' disabled'
      if (el.checked) extra += ' checked'
      if (el.getAttribute('draggable') === 'true') extra += ' draggable'
      if (el.type === 'file') extra += ' file'
      if (el.shadowRoot) extra += ' shadow'
      lines.push('  - ' + role + ' "' + name.replace(/"/g, '\\"') + '" [ref=' + ref + ']' + extra)
    }
    window.__minAgentRefs = refs
    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      snapshot: lines.join('\n'),
      refs: n
    }
  }

  if (opts.op === 'read') {
    const limit = Math.min(Math.max(opts.limit || 12000, 200), 60000)
    const body = document.body
    // innerText is what the page actually renders, so hidden menus and
    // display:none blocks stay out of the result
    const text = body ? String(body.innerText || body.textContent || '') : ''
    const cleaned = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      text: cleaned.length > limit ? cleaned.slice(0, limit) : cleaned,
      truncated: cleaned.length > limit,
      length: cleaned.length
    }
  }

  if (opts.op === 'locate' || opts.op === 'markEl') {
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000
    const spec = { ref: opts.ref, selector: opts.selector, text: opts.text, role: opts.role, nth: opts.nth }
    if (opts.x != null && opts.y != null && !opts.ref && !opts.selector && !opts.text && !opts.role) {
      const at = document.elementFromPoint(opts.x, opts.y)
      if (!at) return { ok: false, error: 'No element at coordinates' }
      const p = viewportPoint(at)
      if (opts.op === 'markEl') window.__minAgentMarkEl = at
      return { ok: true, x: p.x, y: p.y, width: p.width, height: p.height, tag: at.tagName.toLowerCase(), name: accessibleName(at) }
    }
    return waitLive(spec, timeout).then(function (el) {
      if (!el) return { ok: false, error: 'Element not found (detached or rerendered)' }
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) {}
      const p = viewportPoint(el)
      if (opts.op === 'markEl') window.__minAgentMarkEl = el
      return {
        ok: true,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        tag: el.tagName.toLowerCase(),
        name: accessibleName(el),
        selector: cssSelector(el)
      }
    })
  }

  if (opts.op === 'wait') {
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 10000
    const start = Date.now()
    const needle = opts.text ? String(opts.text).toLowerCase() : ''
    return new Promise(function (resolve, reject) {
      if (!opts.selector && !opts.ref && !opts.role && !needle) {
        reject(new Error('wait needs selector, ref, role, or text'))
        return
      }
      function check () {
        const el = resolveOnce(opts)
        if (el) {
          resolve({ ok: true, found: true, name: accessibleName(el) })
          return
        }
        if (needle && !(opts.selector || opts.ref || opts.role)) {
          const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : ''
          if (bodyText.indexOf(needle) !== -1) {
            resolve({ ok: true, found: true })
            return
          }
        }
        if (Date.now() - start >= timeout) {
          resolve({ ok: false, error: 'Timed out waiting' })
          return
        }
        setTimeout(check, 150)
      }
      check()
    })
  }

  if (opts.op === 'scroll') {
    const amount = typeof opts.amount === 'number' ? opts.amount : 600
    const dir = opts.direction || 'down'
    let target = window
    if (opts.selector || opts.ref || opts.role || opts.text) {
      const el = resolveOnce(opts)
      if (el) target = el
    }
    let dx = 0
    let dy = 0
    if (dir === 'down') dy = amount
    else if (dir === 'up') dy = -amount
    else if (dir === 'right') dx = amount
    else if (dir === 'left') dx = -amount
    else if (dir === 'top') {
      if (target === window) window.scrollTo(0, 0)
      else target.scrollTop = 0
    } else if (dir === 'bottom') {
      if (target === window) window.scrollTo(0, document.body.scrollHeight)
      else target.scrollTop = target.scrollHeight
    }
    if (dir !== 'top' && dir !== 'bottom') {
      if (target === window) window.scrollBy(dx, dy)
      else {
        target.scrollLeft += dx
        target.scrollTop += dy
      }
    }
    return { ok: true, direction: dir }
  }

  function pressKey (target, raw) {
    const parts = String(raw || '').split('+')
    const mainKey = parts.pop() || ''
    const init = {
      key: mainKey,
      code: mainKey.length === 1 ? 'Key' + mainKey.toUpperCase() : mainKey,
      bubbles: true,
      cancelable: true,
      ctrlKey: parts.indexOf('Control') !== -1 || parts.indexOf('Ctrl') !== -1,
      altKey: parts.indexOf('Alt') !== -1,
      shiftKey: parts.indexOf('Shift') !== -1,
      metaKey: parts.indexOf('Meta') !== -1 || parts.indexOf('Command') !== -1
    }
    target.dispatchEvent(new KeyboardEvent('keydown', init))
    target.dispatchEvent(new KeyboardEvent('keyup', init))
    if (mainKey === 'Enter' && target.form && target.form.requestSubmit) {
      target.form.requestSubmit()
    }
    return { ok: true, key: raw }
  }

  function actOn (el) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) {}
    if (opts.op === 'click' || opts.op === 'dblclick' || opts.op === 'rightclick') {
      const spec = Object.assign({}, opts)
      if (opts.op === 'dblclick') spec.clickCount = 2
      if (opts.op === 'rightclick') spec.button = 'right'
      performClick(el, spec)
      return { ok: true, tag: el.tagName.toLowerCase(), name: accessibleName(el), selector: cssSelector(el) }
    }
    if (opts.op === 'hover') {
      performHover(el, opts)
      return { ok: true, name: accessibleName(el) }
    }
    if (opts.op === 'type') {
      try { if (!opts.keepChromeFocus) el.focus() } catch (e) {}
      const text = opts.text == null ? '' : String(opts.text)
      if (el.isContentEditable) {
        try { document.execCommand('selectAll', false, null) } catch (e) {}
        try { document.execCommand('insertText', false, text) } catch (e2) {
          el.textContent = text
        }
      } else {
        nativeSetValue(el, text)
      }
      if (opts.submit) {
        const form = el.form || el.closest('form')
        if (form && form.requestSubmit) form.requestSubmit()
        else pressKey(el, 'Enter')
      }
      return { ok: true, name: accessibleName(el), selector: cssSelector(el) }
    }
    if (opts.op === 'select') {
      const value = opts.value == null ? '' : String(opts.value)
      if (el.tagName === 'SELECT') {
        const options = Array.prototype.slice.call(el.options || [])
        let match = options.find(function (o) { return o.value === value })
        if (!match) {
          match = options.find(function (o) {
            return (o.textContent || '').trim().toLowerCase() === value.toLowerCase()
          })
        }
        if (!match) return { ok: false, error: 'Option not found: ' + value }
        el.value = match.value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, value: el.value }
      }
      nativeSetValue(el, value)
      return { ok: true, value: value }
    }
    if (opts.op === 'press') {
      try { if (!opts.keepChromeFocus) el.focus() } catch (e) {}
      return pressKey(el, opts.key)
    }
    return { ok: false, error: 'Unknown page operation: ' + opts.op }
  }

  if (opts.op === 'press' && !opts.ref && !opts.selector && !opts.text && !opts.role) {
    return pressKey(document.activeElement || document.body, opts.key)
  }

  if ((opts.op === 'click' || opts.op === 'dblclick' || opts.op === 'rightclick') && opts.x != null && opts.y != null && !opts.ref && !opts.selector && !opts.text && !opts.role) {
    const at = document.elementFromPoint(opts.x, opts.y)
    if (!at) return { ok: false, error: 'No element at coordinates' }
    const spec = Object.assign({}, opts)
    if (opts.op === 'dblclick') spec.clickCount = 2
    if (opts.op === 'rightclick') spec.button = 'right'
    performClick(at, spec)
    return { ok: true, tag: at.tagName.toLowerCase(), name: accessibleName(at) }
  }

  if (opts.op === 'drag') {
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000
    const fromSpec = { ref: opts.ref, selector: opts.selector, text: opts.text, role: opts.role, nth: opts.nth }
    const toSpec = {
      ref: opts.targetRef,
      selector: opts.targetSelector,
      text: opts.targetText,
      role: opts.targetRole,
      nth: opts.targetNth
    }
    const hasFromPoint = opts.x != null && opts.y != null
    const hasToPoint = opts.targetX != null && opts.targetY != null
    return Promise.all([
      (opts.ref || opts.selector || opts.text || opts.role) ? waitLive(fromSpec, timeout) : Promise.resolve(null),
      (opts.targetRef || opts.targetSelector || opts.targetText || opts.targetRole) ? waitLive(toSpec, timeout) : Promise.resolve(null)
    ]).then(function (pair) {
      let fromEl = pair[0]
      let toEl = pair[1]
      if (!fromEl && hasFromPoint) fromEl = document.elementFromPoint(opts.x, opts.y)
      if (!toEl && hasToPoint) toEl = document.elementFromPoint(opts.targetX, opts.targetY)
      if (!fromEl) return { ok: false, error: 'Drag source not found' }
      if (!toEl) return { ok: false, error: 'Drag target not found' }
      try { fromEl.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) {}
      performDrag(fromEl, toEl, opts)
      return {
        ok: true,
        from: accessibleName(fromEl),
        to: accessibleName(toEl)
      }
    })
  }

  const locate = {
    ref: opts.ref,
    selector: opts.selector,
    role: opts.role,
    nth: opts.nth,
    text: opts.op === 'type' ? undefined : opts.text
  }
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000
  return waitLive(locate, timeout).then(function (el) {
    if (!el) return { ok: false, error: 'Element not found (detached or rerendered)' }
    return actOn(el)
  })
}

async function browserControlRunInView (view, opts) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return { ok: false, error: 'Tab has no page' }
  }
  try {
    return await view.webContents.executeJavaScript(
      '(' + browserControlPageDom.toString() + ')(' + JSON.stringify(opts) + ')',
      true
    )
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

async function browserControlAfterPossibleNavigation (view) {
  await browserControlSleep(120)
  if (view.webContents && !view.webContents.isDestroyed() && view.webContents.isLoading()) {
    await browserControlWaitIdle(view, 20000)
  }
}

async function browserControlListTabs (taskId, workspaceId) {
  if (!taskId && !workspaceId) {
    return { ok: false, error: 'taskId is required; browser tools are scoped to one task' }
  }
  try {
    const listed = await browserControlAskRenderer('listTabs', { taskId: taskId || null, workspaceId: workspaceId || null }, 4000)
    if (listed && listed.ok === false) return listed
    if (listed && Array.isArray(listed.tabs)) {
      return {
        ok: true,
        taskId: listed.taskId || taskId,
        workspaceId: listed.workspaceId || workspaceId,
        workspaceName: listed.workspaceName || null,
        tabs: listed.tabs,
        selected: listed.selected || null
      }
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  return { ok: false, error: 'Could not list tabs for this task' }
}

async function browserControlNavigate (url, tabId, taskId, workspaceId) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'url is required' }
  if (browserControlIsRestrictedUrl(url)) return browserControlRestrictedError()
  const target = await browserControlTargetView(tabId, taskId, workspaceId, { allowRestricted: true })
  if (target.error) return { ok: false, error: target.error }
  const win = windows.getCurrent()
  try {
    loadURLInView(target.id, url, win)
  } catch (err) {
    try {
      await target.view.webContents.loadURL(url)
    } catch (err2) {
      return { ok: false, error: (err2 && err2.message) || String(err2) }
    }
  }
  await browserControlWaitIdle(target.view, 30000)
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  return Object.assign({ ok: true, taskId: taskId || target.taskId, workspaceId: workspaceId || target.workspaceId }, browserControlTabInfo(target.id))
}

async function browserControlHistory (method, tabId, taskId, workspaceId) {
  const target = await browserControlTargetView(tabId, taskId, workspaceId)
  if (target.error) return { ok: false, error: target.error }
  try {
    if (method === 'back') target.view.webContents.goBack()
    else if (method === 'forward') target.view.webContents.goForward()
    else if (method === 'reload') target.view.webContents.reload()
    else return { ok: false, error: 'Unknown history action' }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  await browserControlWaitIdle(target.view, 20000)
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  return Object.assign({ ok: true }, browserControlTabInfo(target.id))
}

async function browserControlSnapshot (tabId, taskId, workspaceId) {
  const target = await browserControlTargetView(tabId, taskId, workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const result = await browserControlRunInView(target.view, { op: 'snapshot' })
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  if (!result || result.ok === false) return result || { ok: false, error: 'Snapshot failed' }
  result.tabId = target.id
  result.taskId = taskId || target.taskId
  result.workspaceId = workspaceId || target.workspaceId
  result.selected = true
  return result
}

/* the readable text of the page, for summarising or checking content that the
snapshot does not cover (prose, tables, error messages) */
async function browserControlReadPage (params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const result = await browserControlRunInView(target.view, {
    op: 'read',
    limit: params.limit
  })
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  if (!result || result.ok === false) return result || { ok: false, error: 'Could not read the page' }
  result.tabId = target.id
  result.taskId = params.taskId || target.taskId
  result.workspaceId = params.workspaceId || target.workspaceId
  return result
}

async function browserControlAct (op, params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const result = await browserControlRunInView(target.view, Object.assign({}, params, {
    op: op,
    keepChromeFocus: !!target.keepChromeFocus
  }))
  if (op === 'click' || op === 'drag' || op === 'submit' || params.submit) {
    await browserControlAfterPossibleNavigation(target.view)
  }
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  if (!result) return { ok: false, error: 'Page action failed' }
  result.tabId = target.id
  result.url = browserControlTabInfo(target.id).url
  return result
}

async function browserControlWait (params) {
  params = params || {}
  if (typeof params.ms === 'number' && params.ms > 0) {
    await browserControlSleep(Math.min(params.ms, 60000))
    return { ok: true, waited: params.ms }
  }
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  if (params.load) {
    await browserControlWaitIdle(target.view, params.timeout || 20000)
    browserControlRestoreChromeFocus(target.keepChromeFocus)
    return Object.assign({ ok: true, workspaceId: params.workspaceId }, browserControlTabInfo(target.id))
  }
  const waited = await browserControlRunInView(target.view, {
    op: 'wait',
    selector: params.selector,
    text: params.text,
    timeout: params.timeout
  })
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  return waited
}

async function browserControlTabs (operation, params) {
  params = params || {}
  const taskId = params.taskId
  const workspaceId = params.workspaceId
  if (!taskId && !workspaceId) {
    return { ok: false, error: 'taskId is required; browser tools are scoped to one task' }
  }
  const scope = { taskId: taskId || null, workspaceId: workspaceId || null }
  if (operation === 'list' || !operation) {
    return browserControlListTabs(taskId, workspaceId)
  }
  if (operation === 'new') {
    if (browserControlIsRestrictedUrl(params.url)) return browserControlRestrictedError()
    try {
      const created = await browserControlAskRenderer('newTab', Object.assign({
        url: params.url || ''
      }, scope), 8000)
      if (created && created.ok === false) return created
      if (created && created.id) {
        await browserControlWaitForView(created.id, 8000)
        if (params.url) await browserControlWaitIdle(viewMap[created.id], 30000)
        browserControlRestoreChromeFocus(created.keepChromeFocus)
        return Object.assign({ ok: true }, created, browserControlTabInfo(created.id))
      }
      return created || { ok: false, error: 'Could not create tab' }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }
  if (operation === 'close') {
    try {
      const closed = await browserControlAskRenderer('closeTab', Object.assign({
        tabId: params.tabId || null
      }, scope), 8000)
      return closed || Object.assign({ ok: true }, scope)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }
  if (operation === 'select' || operation === 'switch') {
    const tabId = params.tabId
    if (!tabId) return { ok: false, error: 'tabId is required' }
    try {
      const selected = await browserControlAskRenderer('selectTab', Object.assign({
        tabId: tabId
      }, scope), 8000)
      return selected || Object.assign({ ok: true, id: tabId }, scope)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }
  return { ok: false, error: 'Unknown tabs operation: ' + operation }
}

function browserControlParseModifiers (raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return String(raw).split('+').map(function (part) { return part.trim() }).filter(Boolean)
}

function browserControlResolveLocalPath (p) {
  if (!p || typeof p !== 'string' || p.indexOf('\0') !== -1) return null
  if (p.indexOf('min://app/') === 0) {
    const rel = p.slice('min://app/'.length)
    const abs = path.join(__dirname, rel)
    const relToRoot = path.relative(__dirname, abs)
    if (!relToRoot || relToRoot === '..' || relToRoot.indexOf('..' + path.sep) === 0 || path.isAbsolute(relToRoot)) {
      return null
    }
    return abs
  }
  return path.resolve(p)
}

function browserControlParseFiles (params) {
  const raw = params.path || params.files || params.file
  if (!raw) return []
  let list
  if (Array.isArray(raw)) {
    list = raw
  } else {
    try {
      const parsed = JSON.parse(raw)
      list = Array.isArray(parsed) ? parsed : [String(raw)]
    } catch (e) {
      list = String(raw).split(',').map(function (s) { return s.trim() }).filter(Boolean)
    }
  }
  return list.map(browserControlResolveLocalPath).filter(function (filePath) {
    return filePath && fs.existsSync(filePath)
  })
}

function browserControlArmDialog (wc, options) {
  options = options || {}
  return new Promise(function (resolve) {
    const dbg = wc.debugger
    let attached = false
    const timeout = setTimeout(function () {
      cleanup()
      resolve({ ok: false, error: 'No JavaScript dialog' })
    }, options.timeout || 8000)
    function cleanup () {
      clearTimeout(timeout)
      try { dbg.removeListener('message', onMessage) } catch (e) {}
      if (attached) {
        try { dbg.detach() } catch (e2) {}
      }
    }
    function onMessage (event, method, params) {
      if (method !== 'Page.javascriptDialogOpening') return
      dbg.sendCommand('Page.handleJavaScriptDialog', {
        accept: options.accept !== false,
        promptText: options.promptText || ''
      }).then(function () {
        cleanup()
        resolve({ ok: true, type: params.type, message: params.message })
      }).catch(function (err) {
        cleanup()
        resolve({ ok: false, error: (err && err.message) || String(err) })
      })
    }
    Promise.resolve().then(function () {
      if (!dbg.isAttached()) {
        attached = true
        return dbg.attach('1.3')
      }
    }).then(function () {
      dbg.on('message', onMessage)
      return dbg.sendCommand('Page.enable')
    }).catch(function (err) {
      cleanup()
      resolve({ ok: false, error: (err && err.message) || String(err) })
    })
  })
}

async function browserControlPointer (op, params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const loc = await browserControlRunInView(target.view, Object.assign({}, params, { op: 'locate' }))
  if (!loc || loc.ok === false) return loc || { ok: false, error: 'Element not found' }
  const button = op === 'rightclick' ? 'right' : (params.button || 'left')
  const clickCount = op === 'dblclick' ? 2 : (params.clickCount || 1)
  const modifiers = browserControlParseModifiers(params.modifiers)
  let dialogWait = null
  let dialog = null
  if (params.acceptDialog) {
    dialogWait = browserControlArmDialog(target.view.webContents, {
      accept: params.accept !== false,
      promptText: params.promptText || params.text,
      timeout: params.timeout || 8000
    })
  }
  try { target.view.webContents.focus() } catch (e) {}
  await browserControlSleep(40)
  let inputError = null
  try {
    const wc = target.view.webContents
    const x = Math.round(loc.x)
    const y = Math.round(loc.y)
    wc.sendInputEvent({ type: 'mouseMove', x: x, y: y, modifiers: modifiers })
    if (op !== 'hover') {
      const holdMs = typeof params.holdMs === 'number' ? params.holdMs : 0
      let n
      for (n = 1; n <= clickCount; n++) {
        wc.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: button, clickCount: n, modifiers: modifiers })
        if (holdMs && n === clickCount) await browserControlSleep(Math.min(holdMs, 10000))
        wc.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: button, clickCount: n, modifiers: modifiers })
      }
    }
  } catch (e) {
    inputError = (e && e.message) || String(e)
  }
  if (params.acceptDialog) {
    dialog = await dialogWait
  }
  if (inputError) {
    browserControlRestoreChromeFocus(target.keepChromeFocus)
    return { ok: false, error: inputError, dialog: dialog }
  }
  if (op === 'click' || op === 'dblclick' || op === 'rightclick') {
    await browserControlAfterPossibleNavigation(target.view)
  }
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  const out = { ok: true, x: loc.x, y: loc.y, name: loc.name, selector: loc.selector }
  if (dialog) out.dialog = dialog
  return out
}

async function browserControlDrag (params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const from = await browserControlRunInView(target.view, Object.assign({}, params, { op: 'locate' }))
  if (!from || from.ok === false) return from || { ok: false, error: 'Drag source not found' }
  const to = await browserControlRunInView(target.view, {
    op: 'locate',
    tabId: params.tabId,
    selector: params.targetSelector,
    ref: params.targetRef,
    text: params.targetText,
    role: params.targetRole,
    nth: params.targetNth,
    x: params.targetX,
    y: params.targetY,
    timeout: params.timeout
  })
  if (!to || to.ok === false) return to || { ok: false, error: 'Drag target not found' }
  try { target.view.webContents.focus() } catch (e) {}
  await browserControlSleep(40)
  let inputError = null
  try {
    const wc = target.view.webContents
    const moves = Math.max(2, Math.min(40, typeof params.moves === 'number' ? params.moves : 12))
    const x0 = Math.round(from.x)
    const y0 = Math.round(from.y)
    const x1 = Math.round(to.x)
    const y1 = Math.round(to.y)
    wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 })
    wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 })
    let i
    for (i = 1; i <= moves; i++) {
      const t = i / moves
      wc.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(x0 + (x1 - x0) * t),
        y: Math.round(y0 + (y1 - y0) * t)
      })
      await browserControlSleep(8)
    }
    wc.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 })
  } catch (e) {
    inputError = (e && e.message) || String(e)
  }
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  if (inputError) return { ok: false, error: inputError }
  return { ok: true, from: from.name, to: to.name }
}

async function browserControlScreenshot (params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  try {
    const image = await target.view.webContents.capturePage()
    const dir = path.join(app.getPath('userData'), 'playbook-captures')
    fs.mkdirSync(dir, { recursive: true })
    let dest
    if (params.path) {
      dest = browserControlResolveLocalPath(params.path) || path.join(dir, path.basename(String(params.path)))
    } else {
      dest = path.join(dir, 'shot-' + Date.now() + '.png')
    }
    fs.writeFileSync(dest, image.toPNG())
    const size = image.getSize()
    browserControlRestoreChromeFocus(target.keepChromeFocus)
    return { ok: true, path: dest, width: size.width, height: size.height }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

async function browserControlUpload (params) {
  params = params || {}
  const files = browserControlParseFiles(params)
  if (!files.length) return { ok: false, error: 'upload needs an existing file path' }
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const marked = await browserControlRunInView(target.view, Object.assign({}, params, { op: 'markEl' }))
  if (!marked || marked.ok === false) return marked || { ok: false, error: 'File input not found' }
  const wc = target.view.webContents
  const dbg = wc.debugger
  let attached = false
  try {
    if (!dbg.isAttached()) {
      await dbg.attach('1.3')
      attached = true
    }
    await dbg.sendCommand('DOM.enable')
    const evaluated = await dbg.sendCommand('Runtime.evaluate', {
      expression: 'window.__minAgentMarkEl',
      returnByValue: false
    })
    if (!evaluated || !evaluated.result || !evaluated.result.objectId) {
      return { ok: false, error: 'Could not bind file input' }
    }
    const node = await dbg.sendCommand('DOM.requestNode', { objectId: evaluated.result.objectId })
    if (!node || !node.nodeId) return { ok: false, error: 'Could not resolve file input node' }
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files: files })
    browserControlRestoreChromeFocus(target.keepChromeFocus)
    return { ok: true, files: files, name: marked.name }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  } finally {
    if (attached) {
      try { dbg.detach() } catch (e) {}
    }
  }
}

async function browserControlDownload (params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const dir = path.join(app.getPath('userData'), 'playbook-downloads')
  fs.mkdirSync(dir, { recursive: true })
  const waitP = minDownloadBeginCapture(dir, params.timeout || 25000)
  if (params.url) {
    try {
      target.view.webContents.downloadURL(params.url)
    } catch (err) {
      minDownloadCancelCapture()
      return { ok: false, error: (err && err.message) || String(err) }
    }
  } else if (params.selector || params.ref || params.text || params.role) {
    const clicked = await browserControlPointer('click', params)
    if (!clicked || clicked.ok === false) {
      minDownloadCancelCapture()
      return clicked || { ok: false, error: 'Download link not found' }
    }
  }
  const done = await waitP
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  return done
}

async function browserControlDialog (params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const result = await browserControlArmDialog(target.view.webContents, {
    accept: params.accept !== false,
    promptText: params.promptText || params.text,
    timeout: params.timeout || 8000
  })
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  return result
}

async function browserControlRunStep (step) {
  if (!step || typeof step !== 'object') return { ok: false, error: 'Invalid step' }
  const action = step.action
  if (action === 'navigate') return browserControlNavigate(step.url, step.tabId, step.taskId, step.workspaceId)
  if (action === 'back') return browserControlHistory('back', step.tabId, step.taskId, step.workspaceId)
  if (action === 'forward') return browserControlHistory('forward', step.tabId, step.taskId, step.workspaceId)
  if (action === 'reload') return browserControlHistory('reload', step.tabId, step.taskId, step.workspaceId)
  if (action === 'snapshot') return browserControlSnapshot(step.tabId, step.taskId, step.workspaceId)
  if (action === 'read') return browserControlReadPage(step)
  if (action === 'click') return browserControlPointer('click', step)
  if (action === 'dblclick') return browserControlPointer('dblclick', step)
  if (action === 'rightclick') return browserControlPointer('rightclick', step)
  if (action === 'hover') return browserControlPointer('hover', step)
  if (action === 'drag') return browserControlDrag(step)
  if (action === 'type') return browserControlAct('type', step)
  if (action === 'select') return browserControlAct('select', step)
  if (action === 'press') return browserControlAct('press', step)
  if (action === 'scroll') return browserControlAct('scroll', step)
  if (action === 'screenshot') return browserControlScreenshot(step)
  if (action === 'upload') return browserControlUpload(step)
  if (action === 'download') return browserControlDownload(step)
  if (action === 'dialog') return browserControlDialog(step)
  if (action === 'wait') return browserControlWait(step)
  if (action === 'assert') {
    const result = await browserControlWait({
      tabId: step.tabId,
      workspaceId: step.workspaceId,
      selector: step.selector,
      text: step.text,
      timeout: step.timeout || 2000
    })
    if (!result || !result.ok) {
      return { ok: false, error: result && result.error ? result.error : 'Assertion failed' }
    }
    return { ok: true, asserted: true }
  }
  if (action === 'tabs') return browserControlTabs(step.operation || 'list', step)
  return { ok: false, error: 'Unknown action: ' + action }
}

/* used by playbook.js and agentTools.js in the concatenated main bundle */
var minBrowser = {
  tabs: browserControlTabs,
  navigate: browserControlNavigate,
  history: browserControlHistory,
  snapshot: browserControlSnapshot,
  readPage: browserControlReadPage,
  act: browserControlAct,
  wait: browserControlWait,
  runStep: browserControlRunStep
}
global.minBrowser = minBrowser
