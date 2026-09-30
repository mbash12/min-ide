/* global document, window, location, KeyboardEvent, MouseEvent, PointerEvent, DragEvent, DataTransfer */
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

module.exports = browserControlPageDom
