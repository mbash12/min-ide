/* global viewMap, windows, ipc, loadURLInView, sendIPCToWindow, getWindowWebContents, location, KeyboardEvent, MouseEvent, PointerEvent, DragEvent, DataTransfer, document, window, fs, path, app, minDownloadBeginCapture, minDownloadCancelCapture, browserVisualRun, browserVisualWithDebugger, browserVisualEvaluate, browserTestingRun, browserTestingLocate, browserTestingObserve, browserTestingHasLocator, browserCommandValidate */
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
  if (typeof browserTestingObserve === 'function') browserTestingObserve(view.webContents)
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
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
    const style = view.getComputedStyle(el)
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 && r.height < 1) return false
    try { if (view.frameElement && !visible(view.frameElement)) return false } catch (e) {}
    return true
  }

  function isLive (el) {
    return !!(el && el.nodeType === 1 && el.isConnected && visible(el))
  }

  function accessibleName (el) {
    if (!el) return ''
    let label = ''
    if (el.getAttribute('aria-labelledby')) {
      label = el.getAttribute('aria-labelledby').split(/\s+/).map(function (id) {
        const target = el.ownerDocument.getElementById(id)
        return target ? target.textContent : ''
      }).join(' ')
    }
    if (!label) {
      if (el.getAttribute('aria-label')) label = el.getAttribute('aria-label')
      else if (el.labels && el.labels[0]) label = el.labels[0].innerText
      else if (el.getAttribute('placeholder')) label = el.getAttribute('placeholder')
      else if (el.getAttribute('alt')) label = el.getAttribute('alt')
      else if (el.getAttribute('title')) label = el.getAttribute('title')
      else if (el.getAttribute('name')) label = el.getAttribute('name')
      else label = el.innerText || (el.type !== 'password' && el.value) || ''
    }
    return String(label).replace(/\s+/g, ' ').trim().slice(0, 500)
  }

  function roleOf (el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
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
    const r = visualRect(el).rect
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height }
  }

  function visualRect (el, bounds) {
    const r = bounds || el.getBoundingClientRect()
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
    let win = el.ownerDocument.defaultView
    let approximate = false
    while (win && win !== window && win.frameElement) {
      const frame = win.frameElement
      const fr = frame.getBoundingClientRect()
      const sx = frame.offsetWidth ? fr.width / frame.offsetWidth : 1
      const sy = frame.offsetHeight ? fr.height / frame.offsetHeight : 1
      const transform = win.parent.getComputedStyle(frame).transform
      if (transform !== 'none' && !/^matrix\([^,]+, 0, 0, [^,]+, [^,]+, [^,]+\)$/.test(transform)) approximate = true
      rect.x = fr.left + (frame.clientLeft + rect.x) * sx
      rect.y = fr.top + (frame.clientTop + rect.y) * sy
      rect.width *= sx
      rect.height *= sy
      win = win.parent
    }
    return { rect: rect, approximate: approximate }
  }

  function visualElementAt (root, x, y) {
    let el = root.elementFromPoint(x, y)
    if (!el) return null
    if (el.shadowRoot && el.shadowRoot.elementFromPoint) {
      const inner = el.shadowRoot.elementFromPoint(x, y)
      if (inner && inner !== el) el = visualElementAt(el.shadowRoot, x, y) || inner
    }
    if (el.tagName === 'IFRAME') {
      try {
        const doc = el.contentDocument
        const r = el.getBoundingClientRect()
        if (doc && r.width && r.height) {
          return visualElementAt(doc, (x - r.left) * el.offsetWidth / r.width - el.clientLeft, (y - r.top) * el.offsetHeight / r.height - el.clientTop) || el
        }
      } catch (e) {}
    }
    return el
  }

  function visualDescription (el) {
    const view = el.ownerDocument.defaultView
    const style = view.getComputedStyle(el)
    const properties = [
      'display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-color', 'border-style', 'border-radius',
      'gap', 'row-gap', 'column-gap', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content',
      'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
      'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration', 'white-space',
      'color', 'background-color', 'background-image', 'box-shadow', 'opacity', 'overflow-x', 'overflow-y', 'transform', 'z-index'
    ]
    const styles = {}
    properties.forEach(function (key) { styles[key] = style.getPropertyValue(key) })
    const geometry = visualRect(el)
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      selector: cssSelector(el),
      name: accessibleName(el),
      rect: geometry.rect,
      geometryApproximate: geometry.approximate,
      styles: styles
    }
  }

  if (opts.op === 'inspect') {
    const located = opts.ref || opts.selector || opts.role || opts.text
    if (!located && (!Number.isFinite(opts.x) || !Number.isFinite(opts.y))) return { ok: false, error: 'inspect needs a locator or x/y in viewport CSS pixels' }
    const pending = located ? waitLive(opts, opts.timeout || 4000) : Promise.resolve(visualElementAt(document, opts.x, opts.y))
    return pending.then(function (el) {
      if (!el) return { ok: false, error: 'Element not found at this locator or point' }
      const result = Object.assign({ ok: true, coordinates: 'viewport CSS pixels' }, visualDescription(el))
      if (opts.properties) {
        const style = el.ownerDocument.defaultView.getComputedStyle(el)
        result.styles = {}
        opts.properties.split(',').map(function (key) { return key.trim() }).filter(Boolean).forEach(function (key) { result.styles[key] = style.getPropertyValue(key) })
      }
      result.documentRect = Object.assign({}, result.rect, { x: result.rect.x + window.scrollX, y: result.rect.y + window.scrollY })
      if (opts.geometryOnly) return result
      window.__minAgentInspectEl = el
      result.text = String(el.innerText || el.textContent || '').slice(0, 2000)
      result.fontsReady = el.ownerDocument.fonts.status === 'loaded'
      result.viewport = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY }
      let parent = el.parentElement || (el.getRootNode().host) || el.ownerDocument.defaultView.frameElement
      result.ancestors = []
      while (parent && result.ancestors.length < 3) {
        result.ancestors.push(visualDescription(parent))
        parent = parent.parentElement || parent.getRootNode().host
      }
      const limit = Math.max(0, Math.min(30, opts.limit == null ? 10 : opts.limit))
      result.children = Array.from(el.children).filter(visible).slice(0, limit).map(visualDescription)
      result.childrenTruncated = el.children.length > result.children.length
      result.textRects = []
      const walker = el.ownerDocument.createTreeWalker(el, 4)
      let node
      let visited = 0
      while ((node = walker.nextNode()) && visited++ < 100 && result.textRects.length < 30) {
        if (!String(node.textContent).trim()) continue
        const range = el.ownerDocument.createRange()
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
          if (result.textRects.length >= 30) break
          result.textRects.push(visualRect(el, rect).rect)
        }
      }
      return result
    })
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
    if (!needle && !role) return null
    const nodes = collectInteractive()
    const matches = []
    let i
    for (i = 0; i < nodes.length; i++) {
      if (!isLive(nodes[i])) continue
      if (role && roleOf(nodes[i]) !== role) continue
      const label = accessibleName(nodes[i]).toLowerCase()
      if (!needle) matches.push(nodes[i])
      else if (contains) {
        if (label.indexOf(needle) !== -1) matches.push(nodes[i])
      } else if (label === needle) {
        matches.push(nodes[i])
      }
    }
    if (!matches.length) return null
    const index = typeof nth === 'number' ? nth : 0
    return matches[index] || null
  }

  function matchesForTest (spec) {
    const out = []
    const hasFilter = spec.selector || spec.testId || spec.label || spec.placeholder || spec.name || spec.role || spec.text
    if (spec.ref) {
      const entry = window.__minAgentRefs && window.__minAgentRefs[spec.ref]
      if (entry && entry.el && entry.el.isConnected) return [entry.el]
      if (entry) {
        const locator = entry.locator || { selector: entry.selector, nth: entry.nth }
        const candidates = matchesForTest(locator).filter(function (el) { return locator.includeHidden || visible(el) })
        return candidates[locator.nth || 0] ? [candidates[locator.nth || 0]] : []
      }
      return []
    }
    if (!hasFilter) return out
    if (spec.selector) document.createElement('div').matches(spec.selector) // validate syntax once
    function match (actual, expected) {
      const a = String(actual || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const b = String(expected).replace(/\s+/g, ' ').trim().toLowerCase()
      return spec.exact === false ? a.indexOf(b) !== -1 : a === b
    }
    forEachDeep(document, function (el) {
      if (spec.selector && !el.matches(spec.selector)) return
      if (spec.testId && el.getAttribute('data-testid') !== spec.testId) return
      if (spec.role && roleOf(el) !== spec.role) return
      if (spec.placeholder && !match(el.getAttribute('placeholder'), spec.placeholder)) return
      if (spec.label) {
        const labels = Array.from(el.labels || []).map(function (label) { return label.textContent }).join(' ')
        if (!match(el.hasAttribute('aria-labelledby') ? accessibleName(el) : labels || el.getAttribute('aria-label'), spec.label)) return
      }
      const text = spec.name == null ? spec.text : spec.name
      if (text != null && !match(accessibleName(el), text)) return
      out.push(el)
    })
    return out
  }

  function testElement (el, spec) {
    const refs = window.__minAgentRefs || (window.__minAgentRefs = {})
    window.__minAgentFindId = (window.__minAgentFindId || 0) + 1
    const ref = 'f' + window.__minAgentFindId
    refs[ref] = { el: el, selector: cssSelector(el), role: roleOf(el), name: accessibleName(el), locator: spec }
    // Bound retained DOM references between snapshots.
    const keys = Object.keys(refs)
    if (keys.length > 1000) keys.slice(0, keys.length - 1000).forEach(function (key) { delete refs[key] })
    return {
      ref: ref,
      selector: cssSelector(el),
      testId: el.getAttribute('data-testid'),
      role: roleOf(el),
      name: accessibleName(el),
      visible: visible(el),
      enabled: !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true',
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      value: el.type === 'password' ? '[redacted]' : typeof el.value === 'string' ? el.value.slice(0, 500) : null,
      rect: visualRect(el).rect
    }
  }

  if (opts.op === 'find') {
    const all = matchesForTest(opts).filter(function (el) { return opts.includeHidden || visible(el) })
    const limit = Math.max(1, Math.min(100, opts.limit || 10))
    const offset = opts.offset || 0
    const previous = opts.ref && window.__minAgentRefs && window.__minAgentRefs[opts.ref]
    const spec = previous ? Object.assign({}, previous.locator || { selector: previous.selector, nth: previous.nth }) : {}
    ;['selector', 'testId', 'label', 'placeholder', 'name', 'role', 'text', 'exact', 'includeHidden'].forEach(function (key) {
      if (opts[key] != null) spec[key] = opts[key]
    })
    return { ok: true, count: all.length, offset: offset, nextOffset: offset + limit < all.length ? offset + limit : null, truncated: offset + limit < all.length, matches: all.slice(offset, offset + limit).map(function (el, index) { return testElement(el, Object.assign({}, spec, { nth: previous ? spec.nth || 0 : offset + index })) }) }
  }

  if (opts.op === 'assert') {
    const condition = opts.condition
    const pageCondition = condition === 'url' || condition === 'title'
    const all = pageCondition ? [] : matchesForTest(opts)
    const matches = typeof opts.nth === 'number' ? (all[opts.nth] ? [all[opts.nth]] : []) : all
    const selected = matches[0]
    const plural = ['count', 'hidden', 'detached', 'attached'].indexOf(condition) !== -1
    if (!pageCondition && !plural && opts.nth == null && opts.strict !== false && matches.length > 1) {
      return { ok: false, retryable: false, error: 'Locator matches ' + matches.length + ' elements; refine it or set nth', matched: matches.length }
    }
    let actual
    let expected = opts.expected
    if (condition === 'url') actual = location.href
    else if (condition === 'title') actual = document.title
    else if (condition === 'count') actual = matches.length
    else if (condition === 'attached' || condition === 'detached') { actual = matches.length > 0; expected = condition === 'attached' } else if (condition === 'hidden' || condition === 'visible') {
      actual = condition === 'hidden' ? matches.some(visible) : !!selected && visible(selected)
      expected = condition === 'visible'
    } else if (condition === 'enabled' || condition === 'disabled') {
      actual = selected ? !selected.matches(':disabled') && selected.getAttribute('aria-disabled') !== 'true' : null
      expected = condition === 'enabled'
    } else if (condition === 'checked') {
      actual = selected ? (typeof selected.checked === 'boolean' ? selected.checked : selected.getAttribute('aria-checked') === 'true') : null
      if (expected == null) expected = true
    } else if (condition === 'text') actual = selected ? String(selected.innerText || selected.textContent || '').replace(/\s+/g, ' ').trim() : null
    else if (condition === 'value') actual = selected && 'value' in selected ? selected.value : null
    else if (condition === 'attribute') actual = selected ? selected.getAttribute(opts.attribute) : null
    else if (condition === 'css') actual = selected ? selected.ownerDocument.defaultView.getComputedStyle(selected).getPropertyValue(opts.property) : null
    else return { ok: false, retryable: false, error: 'Unknown assertion condition: ' + condition }
    if (condition === 'text' && typeof expected === 'string') expected = expected.replace(/\s+/g, ' ').trim()
    let passed = opts.contains && typeof actual === 'string' && typeof expected === 'string' ? actual.indexOf(expected) !== -1 : actual === expected
    if (opts.not) passed = !passed
    if (!pageCondition && !plural && !selected) passed = false
    const privateValue = selected && selected.type === 'password' && condition === 'value'
    return { ok: passed, condition: condition, expected: privateValue ? '[redacted]' : expected, actual: privateValue ? '[redacted]' : actual, matched: matches.length, not: !!opts.not, contains: !!opts.contains }
  }

  function resolveOnce (spec) {
    spec = spec || {}
    if (spec.ref && window.__minAgentRefs) {
      const entry = window.__minAgentRefs[spec.ref]
      const live = liveEl(entry)
      if (live) return live
      if (entry && entry.nodeType !== 1) {
        if (entry.locator) {
          const matches = matchesForTest(entry.locator).filter(visible)
          return matches[entry.locator.nth || 0] || null
        }
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
        const el = typeof spec.nth === 'number' ? matchesForTest(spec).filter(visible)[spec.nth] : queryDeep(spec.selector)
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
          if (timeout === 0) { resolve(el); return }
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
    const owner = el.ownerDocument.defaultView
    const proto = tag === 'TEXTAREA' ? owner.HTMLTextAreaElement.prototype : owner.HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  if (opts.op === 'snapshot') {
    const refs = window.__minAgentRefs || {}
    window.__minAgentSnapshotId = (window.__minAgentSnapshotId || 0) + 1
    const prefix = 's' + window.__minAgentSnapshotId + '_'
    const seen = {}
    const lines = []
    const nodes = []
    const root = opts.selector ? queryDeep(opts.selector) : document
    if (!root) return { ok: false, error: 'Snapshot scope not found' }
    const consider = function (el) {
      if (!el || !el.tagName || !visible(el)) return
      if (/^H[1-6]$/.test(el.tagName) || el.matches(INTERACTIVE)) nodes.push(el)
    }
    consider(root)
    forEachDeep(root, consider)
    const offset = opts.offset || 0
    const limit = Math.max(1, Math.min(250, opts.limit || 80))
    for (let i = 0; i < nodes.length && i < offset + limit; i++) {
      const el = nodes[i]
      const name = accessibleName(el)
      const role = roleOf(el)
      const seenKey = role + '\0' + name.toLowerCase()
      const nth = seen[seenKey] || 0
      seen[seenKey] = nth + 1
      if (i < offset) continue
      const ref = prefix + (i + 1)
      const selector = cssSelector(el)
      refs[ref] = { el: el, role: role, name: name, selector: selector, nth: nth }
      let extra = ''
      if (el.getAttribute('data-testid')) extra += ' testId=' + JSON.stringify(el.getAttribute('data-testid'))
      if (opts.detail === 'full' && selector) extra += ' selector=' + selector
      if (opts.detail === 'full' && el.href) extra += ' href=' + el.href
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) extra += ' value=' + JSON.stringify(el.type === 'password' ? '[redacted]' : String(el.value).slice(0, 60))
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') extra += ' disabled'
      if (el.checked) extra += ' checked'
      if (el.getAttribute('draggable') === 'true') extra += ' draggable'
      if (el.type === 'file') extra += ' file'
      lines.push(role + ' ' + JSON.stringify(name) + ' [' + ref + ']' + extra)
    }
    const keys = Object.keys(refs)
    if (keys.length > 1000) keys.slice(0, keys.length - 1000).forEach(function (key) { delete refs[key] })
    window.__minAgentRefs = refs
    return { ok: true, url: location.href, title: document.title || '', snapshot: lines.join('\n'), refs: lines.length, total: nodes.length, offset: offset, nextOffset: offset + limit < nodes.length ? offset + limit : null, truncated: offset + limit < nodes.length }
  }

  if (opts.op === 'read') {
    const limit = Math.min(Math.max(opts.limit || 6000, 1), 60000)
    const offset = opts.offset || 0
    const body = opts.selector ? queryDeep(opts.selector) : document.body
    if (!body) return { ok: false, error: 'Read scope not found' }
    const text = String(body.innerText || body.textContent || '')
    const cleaned = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return { ok: true, url: location.href, title: document.title || '', text: cleaned.slice(offset, offset + limit), offset: offset, nextOffset: offset + limit < cleaned.length ? offset + limit : null, truncated: offset + limit < cleaned.length, length: cleaned.length }
  }

  if (opts.op === 'locate' || opts.op === 'markEl') {
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000
    const spec = { ref: opts.ref, selector: opts.selector, text: opts.text, role: opts.role, nth: opts.nth }
    if (opts.x != null && opts.y != null && !opts.ref && !opts.selector && !opts.text && !opts.role) {
      const at = visualElementAt(document, opts.x, opts.y)
      if (!at) return { ok: false, error: 'No element at coordinates' }
      if (opts.hitTest && (at.matches(':disabled') || at.getAttribute('aria-disabled') === 'true')) return { ok: false, error: 'Element is disabled' }
      const p = { x: opts.x, y: opts.y, width: at.getBoundingClientRect().width, height: at.getBoundingClientRect().height }
      if (opts.op === 'markEl') window.__minAgentMarkEl = at
      return { ok: true, x: p.x, y: p.y, width: p.width, height: p.height, tag: at.tagName.toLowerCase(), name: accessibleName(at) }
    }
    return waitLive(spec, timeout).then(function (el) {
      if (!el) return { ok: false, error: 'Element not found (detached or rerendered)' }
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch (e) {}
      const p = viewportPoint(el)
      if (opts.hitTest) {
        const at = visualElementAt(document, p.x, p.y)
        if (!at || (at !== el && !el.contains(at) && !(el.shadowRoot && el.shadowRoot.contains(at)))) return { ok: false, error: 'Element is covered or outside the viewport; inspect or wait for the covering element to disappear' }
        if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'Element is disabled' }
      }
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
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch (e) {}
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'Element is disabled' }
    if (opts.op === 'focus') {
      el.focus()
      return { ok: el.ownerDocument.activeElement === el, name: accessibleName(el) }
    }
    if (opts.op === 'check') {
      if (el.tagName !== 'INPUT' || ['checkbox', 'radio'].indexOf(el.type) === -1) return { ok: false, error: 'check requires a checkbox or radio input' }
      const wanted = opts.checked !== false
      if (!wanted && el.type === 'radio') return { ok: false, error: 'Select a different radio option to uncheck this one' }
      const changed = el.checked !== wanted
      if (opts.prepare) return { ok: true, checked: el.checked, changed: changed }
      if (changed) el.click()
      return { ok: el.checked === wanted, checked: el.checked, changed: changed, error: el.checked === wanted ? undefined : 'Page did not accept the checked state' }
    }
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
      if (el.readOnly) return { ok: false, error: 'Element is read-only' }
      if (!el.isContentEditable && !['INPUT', 'TEXTAREA'].includes(el.tagName)) return { ok: false, error: 'fill/type requires an input, textarea, or contenteditable element' }
      try { el.focus() } catch (e) {}
      const text = opts.text == null ? '' : String(opts.text)
      if (el.isContentEditable) {
        const doc = el.ownerDocument
        const range = doc.createRange()
        range.selectNodeContents(el)
        const selection = doc.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        if (!doc.execCommand('insertText', false, text)) { el.textContent = text; el.dispatchEvent(new Event('input', { bubbles: true })) }
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
      try { fromEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch (e) {}
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
    return await browserVisualWithDebugger(view.webContents, function () {
      return browserVisualEvaluate(view.webContents, browserControlPageDom, opts)
    })
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
  let timer
  try {
    let loading
    try {
      loading = loadURLInView(target.id, url, win)
    } catch (err) { loading = target.view.webContents.loadURL(url) }
    await Promise.race([loading, new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(new Error('Timed out waiting for navigation')) }, 30000)
    })])
    const waited = await browserControlWaitIdle(target.view, 30000)
    if (waited.timedOut) throw new Error('Timed out waiting for page load')
    return Object.assign({ ok: true, taskId: taskId || target.taskId, workspaceId: workspaceId || target.workspaceId }, browserControlTabInfo(target.id))
  } catch (err) {
    return { ok: false, error: err.message || String(err), tabId: target.id, url: url }
  } finally {
    clearTimeout(timer)
    browserControlRestoreChromeFocus(target.keepChromeFocus)
  }
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
  const waited = await browserControlWaitIdle(target.view, 20000)
  browserControlRestoreChromeFocus(target.keepChromeFocus)
  if (waited.timedOut) return { ok: false, error: 'Timed out waiting for navigation', tabId: target.id }
  return Object.assign({ ok: true }, browserControlTabInfo(target.id))
}

async function browserControlSnapshot (tabId, taskId, workspaceId, options) {
  const target = await browserControlTargetView(tabId, taskId, workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const result = await browserControlRunInView(target.view, Object.assign({}, options, { op: 'snapshot' }))
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
    selector: params.selector,
    offset: params.offset,
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
  if (typeof params.ms === 'number' && params.ms >= 0) {
    await browserControlSleep(Math.min(params.ms, 60000))
    return { ok: true, waited: params.ms }
  }
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  if (params.load) {
    const waited = await browserControlWaitIdle(target.view, params.timeout || 20000)
    browserControlRestoreChromeFocus(target.keepChromeFocus)
    if (waited.timedOut) return { ok: false, error: 'Timed out waiting for page load', tabId: target.id }
    return Object.assign({ ok: true, workspaceId: params.workspaceId }, browserControlTabInfo(target.id))
  }
  const waited = await browserTestingRun(Object.assign({}, params, { action: 'assert' }))
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
  return browserVisualWithDebugger(wc, function (dbg) {
    return new Promise(function (resolve) {
      const timeout = setTimeout(function () {
        cleanup()
        resolve({ ok: false, error: 'No JavaScript dialog' })
      }, options.timeout || 8000)
      function cleanup () {
        clearTimeout(timeout)
        try { dbg.removeListener('message', onMessage) } catch (e) {}
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
      dbg.on('message', onMessage)
      dbg.sendCommand('Page.enable').catch(function (err) {
        cleanup()
        resolve({ ok: false, error: (err && err.message) || String(err) })
      })
    })
  }).catch(function (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  })
}

async function browserControlPointer (op, params) {
  params = params || {}
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const loc = await browserControlRunInView(target.view, Object.assign({}, params, { op: 'locate', hitTest: op !== 'hover' }))
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
    const bits = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 }
    const flags = modifiers.reduce(function (value, key) { return value | (bits[key.toLowerCase()] || 0) }, 0)
    await browserVisualWithDebugger(wc, async function (dbg) {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, modifiers: flags })
      if (op !== 'hover') {
        const holdMs = typeof params.holdMs === 'number' ? params.holdMs : 0
        for (let n = 1; n <= clickCount; n++) {
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: button, clickCount: n, modifiers: flags })
          try {
            if (holdMs && n === clickCount) await browserControlSleep(Math.min(holdMs, 10000))
          } finally {
            await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: button, clickCount: n, modifiers: flags })
          }
        }
      }
    })
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
  return browserVisualRun(Object.assign({}, params, { action: 'screenshot' }))
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
  try {
    return await browserVisualWithDebugger(wc, async function (dbg) {
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
    })
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
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

async function browserControlBatch (params) {
  const fields = ['action', 'steps', 'tabId', 'taskId', 'workspaceId', 'outputDir', 'detail']
  const unknown = Object.keys(params).find(function (key) { return params[key] !== undefined && !fields.includes(key) })
  if (unknown) return { ok: false, error: 'Unknown batch field: ' + unknown, completed: 0 }
  if (params.detail && !['compact', 'full'].includes(params.detail)) return { ok: false, error: 'detail must be compact or full', completed: 0 }
  if (!Array.isArray(params.steps) || !params.steps.length || params.steps.length > 12) return { ok: false, error: 'batch needs 1–12 steps; use playbook for longer/repeated scenarios' }
  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i]
    const valid = browserCommandValidate(step)
    if (!valid.ok) return Object.assign({}, valid, { validationIndex: i, completed: 0 })
    if (step.taskId || step.workspaceId || step.outputDir || step.continueOnError) return { ok: false, error: 'Batch steps inherit scope and always stop on failure', validationIndex: i, completed: 0 }
  }
  const listed = await browserControlListTabs(params.taskId, params.workspaceId)
  if (!listed.ok) return listed
  const scope = { taskId: listed.taskId, workspaceId: listed.workspaceId, outputDir: params.outputDir }
  let tabId = params.tabId || listed.selected
  if (!listed.tabs.some(function (tab) { return tab.id === tabId })) return { ok: false, error: 'Select a web tab before running a batch', completed: 0 }
  const results = []
  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i]
    let result
    try {
      result = await browserControlRunStep(Object.assign({}, step, scope, { tabId: step.tabId || tabId }))
    } catch (err) { result = { ok: false, error: err.message || String(err) } }
    if (!result) result = { ok: false, error: 'No step result' }
    if (result.ok && result.assertion && result.assertion.passed === false) result = Object.assign({}, result, { ok: false, error: 'Visual assertion failed' })
    results.push(Object.assign({ index: i, action: step.action }, result))
    if (!result.ok) return { ok: false, error: result.error || 'Batch step failed', stoppedAt: i, completed: i, total: params.steps.length, tabId: tabId, results: results, hint: 'Earlier steps already ran. Inspect the failure before resuming; do not blindly replay the batch.' }
    if (step.action === 'tabs') {
      if (step.operation === 'new' || step.operation === 'select' || step.operation === 'switch') tabId = result.id
      if (step.operation === 'close' && (!step.tabId || step.tabId === tabId)) tabId = result.selected
    }
  }
  return { ok: true, completed: results.length, total: params.steps.length, tabId: tabId, results: results }
}

async function browserControlRunStep (step) {
  if (!step || typeof step !== 'object') return { ok: false, error: 'Invalid step' }
  const action = step.action
  if (action === 'batch') return browserControlBatch(step)
  const valid = browserCommandValidate(step)
  if (!valid.ok) return valid
  if (['find', 'assert', 'diagnostics'].includes(action)) return browserTestingRun(step)
  if (['type', 'fill', 'check', 'focus', 'select', 'upload'].includes(action) && !browserTestingHasLocator(step, action === 'type')) return { ok: false, error: action + ' needs an element locator (testId, label, role+name, selector, or ref)' }
  if (['click', 'dblclick', 'rightclick', 'hover', 'drag', 'type', 'fill', 'check', 'focus', 'select', 'press', 'upload', 'inspect', 'screenshot', 'compare', 'scroll'].includes(action) && browserTestingHasLocator(step, action === 'type')) {
    try {
      const located = await browserTestingLocate(step)
      if (!located.ok) return located
      step = Object.assign({}, step, { ref: located.ref, tabId: located.tabId })
    } catch (err) { return { ok: false, error: err.message } }
  }
  if (action === 'navigate') return browserControlNavigate(step.url, step.tabId, step.taskId, step.workspaceId)
  if (action === 'back') return browserControlHistory('back', step.tabId, step.taskId, step.workspaceId)
  if (action === 'forward') return browserControlHistory('forward', step.tabId, step.taskId, step.workspaceId)
  if (action === 'reload') return browserControlHistory('reload', step.tabId, step.taskId, step.workspaceId)
  if (action === 'snapshot') return browserControlSnapshot(step.tabId, step.taskId, step.workspaceId, step)
  if (action === 'read') return browserControlReadPage(step)
  if (action === 'click') return browserControlPointer('click', step)
  if (action === 'dblclick') return browserControlPointer('dblclick', step)
  if (action === 'rightclick') return browserControlPointer('rightclick', step)
  if (action === 'hover') return browserControlPointer('hover', step)
  if (action === 'drag') return browserControlDrag(step)
  if (action === 'type') return browserControlAct('type', step)
  if (action === 'fill') {
    if (typeof step.value !== 'string') return { ok: false, error: 'fill needs value (use an empty string to clear)' }
    return browserControlAct('type', Object.assign({}, step, { text: step.value }))
  }
  if (action === 'check') return global.minBrowserTesting.check(step)
  if (action === 'focus') return browserControlAct(action, step)
  if (action === 'select') return browserControlAct('select', step)
  if (action === 'press') return global.minBrowserTesting.press(step)
  if (action === 'scroll') return browserControlAct('scroll', step)
  if (action === 'screenshot') return browserControlScreenshot(step)
  if (action === 'viewport' || action === 'inspect' || action === 'compare') return browserVisualRun(step)
  if (action === 'upload') return browserControlUpload(step)
  if (action === 'download') return browserControlDownload(step)
  if (action === 'dialog') return browserControlDialog(step)
  if (action === 'wait') return browserControlWait(step)
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
