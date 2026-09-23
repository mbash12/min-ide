/* Assertions and diagnostics share Min's existing tab/DOM/debugger machinery. */
/* global browserControlTargetView, browserControlRestoreChromeFocus, browserControlRunInView, browserControlIsRestrictedUrl, browserControlSleep, browserVisualWithDebugger, browserControlAfterPossibleNavigation, browserControlAct, browserControlPointer */

var browserTestingLogs = new WeakMap()
var BROWSER_ASSERTIONS = ['visible', 'hidden', 'attached', 'detached', 'text', 'value', 'checked', 'enabled', 'disabled', 'count', 'attribute', 'css', 'url', 'title', 'no-errors']

function browserTestingObserve (wc) {
  let state = browserTestingLogs.get(wc)
  if (state) return state
  state = { entries: [], dropped: 0, nextId: 0, since: Date.now() }
  browserTestingLogs.set(wc, state)
  function add (entry) {
    state.entries.push(Object.assign({ id: ++state.nextId, time: Date.now() }, entry))
    if (state.entries.length > 200) { state.entries.shift(); state.dropped++ }
  }
  wc.on('console-message', function (event) {
    const level = event.level == null ? arguments[1] : event.level
    const message = event.message == null ? arguments[2] : event.message
    if (typeof message !== 'string' || message.indexOf('__min_design_overlay__') === 0) return
    add({ type: 'console', level: typeof level === 'number' ? ['debug', 'info', 'warning', 'error'][level] || 'info' : level, message: message.slice(0, 2000) })
  })
  wc.on('did-fail-load', function (event, code, description, url, mainFrame) {
    if (code === -3) return // a replaced/cancelled navigation
    add({ type: 'navigation', level: 'error', code: code, message: String(description).slice(0, 1000), url: String(url).slice(0, 2000), mainFrame: mainFrame })
  })
  wc.on('render-process-gone', function (event, details) {
    add({ type: 'renderer', level: 'error', message: details.reason })
  })
  return state
}

function browserTestingDiagnostics (wc, clear) {
  const state = browserTestingObserve(wc)
  if (clear) { state.entries = []; state.dropped = 0; state.since = Date.now() }
  return { ok: true, since: state.since, entries: state.entries.slice(), dropped: state.dropped, scope: 'Console and navigation errors observed since the last clear; excludes request bodies/headers.' }
}

function browserTestingHasLocator (params, excludeText) {
  return !!(params.ref || params.selector || params.testId || params.label || params.placeholder || params.name || params.role || (!excludeText && params.text))
}

function browserTestingTimeout (params) {
  const value = params.timeout == null ? 4000 : params.timeout
  if (!Number.isFinite(value) || value < 0 || value > 15000) throw new Error('timeout must be 0–15000 ms')
  return value
}

async function browserTestingRun (params) {
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const wc = target.view.webContents
  const throttling = wc.getBackgroundThrottling()
  try {
    if (params.action === 'diagnostics') {
      if (params.operation && !['get', 'clear'].includes(params.operation)) throw new Error('diagnostics operation must be get or clear')
      return Object.assign({ tabId: target.id }, browserTestingDiagnostics(wc, params.operation === 'clear'))
    }
    if (params.action === 'find') {
      if (!browserTestingHasLocator(params)) throw new Error('find needs testId, label, placeholder, name, role, selector, ref, or text')
      return Object.assign({ tabId: target.id }, await browserControlRunInView(target.view, Object.assign({}, params, { op: 'find' })))
    }
    const opts = Object.assign({}, params, { op: 'assert' })
    if (opts.nth != null && (!Number.isInteger(opts.nth) || opts.nth < 0 || opts.nth > 99)) throw new Error('nth must be an integer between 0 and 99')
    if (!opts.condition && opts.text && !browserTestingHasLocator(opts, true)) {
      opts.condition = 'text'; opts.selector = 'body'; opts.expected = opts.text; opts.contains = true; delete opts.text
    }
    opts.condition = opts.condition || 'visible'
    if (!BROWSER_ASSERTIONS.includes(opts.condition)) throw new Error('Unknown assertion condition: ' + opts.condition)
    const pageCondition = ['url', 'title', 'no-errors'].includes(opts.condition)
    if (!pageCondition && !browserTestingHasLocator(opts)) throw new Error('This assertion needs an element locator')
    if (['text', 'value', 'attribute', 'css', 'url', 'title'].includes(opts.condition) && !Object.prototype.hasOwnProperty.call(opts, 'expected')) throw new Error('expected is required for ' + opts.condition)
    if (opts.condition === 'count' && (!Number.isInteger(opts.expected) || opts.expected < 0)) throw new Error('count expects a non-negative integer')
    if (opts.condition === 'attribute' && !opts.attribute) throw new Error('attribute is required')
    if (opts.condition === 'css' && !opts.property) throw new Error('property is required (CSS property such as color or padding-left)')
    if (opts.condition === 'checked' && opts.expected != null && typeof opts.expected !== 'boolean') throw new Error('checked expects true or false')
    if (opts.condition === 'no-errors' && opts.not) throw new Error('no-errors does not support not')
    const timeout = browserTestingTimeout(opts)
    const start = Date.now()
    let attempts = 0
    wc.setBackgroundThrottling(false)
    while (true) {
      if (wc.isDestroyed()) throw new Error('Tab was closed during the assertion')
      if (browserControlIsRestrictedUrl(wc.getURL())) throw new Error('Browser tools cannot inspect settings or profile pages')
      let result
      if (opts.condition === 'no-errors') {
        const logs = browserTestingDiagnostics(wc)
        const errors = logs.entries.filter(function (entry) { return entry.level === 'error' })
        result = { ok: errors.length === 0 && logs.dropped === 0, condition: 'no-errors', expected: 0, actual: errors.length, diagnostics: logs }
      } else result = await browserControlRunInView(target.view, opts)
      attempts++
      if (result.ok || result.retryable === false || result.error || Date.now() - start >= timeout || opts.condition === 'no-errors') {
        const output = Object.assign({}, result, { tabId: target.id, url: wc.getURL(), attempts: attempts, durationMs: Date.now() - start })
        if (!output.ok && !output.error) output.error = 'Assertion ' + opts.condition + ' failed: expected ' + JSON.stringify(output.expected) + ', actual ' + JSON.stringify(output.actual)
        return output
      }
      await browserControlSleep(Math.min(100, Math.max(1, timeout - (Date.now() - start))))
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), tabId: target.id }
  } finally {
    if (!wc.isDestroyed()) wc.setBackgroundThrottling(throttling)
    browserControlRestoreChromeFocus(target.keepChromeFocus)
  }
}

// Resolve a semantic locator once before an action. Actions themselves are never
// retried: retrying a submit/click can create duplicate side effects.
async function browserTestingLocate (params) {
  const query = Object.assign({}, params, { action: 'find', limit: 100, includeHidden: false })
  if (params.action === 'type') delete query.text
  const timeout = browserTestingTimeout(params)
  const start = Date.now()
  while (true) {
    const result = await browserTestingRun(query)
    if (!result.ok) return result
    if (result.count > 1 && params.nth == null && params.strict !== false) {
      return { ok: false, error: 'Locator matches ' + result.count + ' elements; refine the locator or set nth', matches: result.matches.slice(0, 10) }
    }
    const index = params.nth == null ? 0 : params.nth
    if (!Number.isInteger(index) || index < 0 || index >= 100) return { ok: false, error: 'nth must be an integer between 0 and 99' }
    const chosen = result.matches[index]
    const readOnly = ['inspect', 'screenshot', 'compare', 'hover', 'scroll'].includes(params.action)
    if (chosen && (readOnly || chosen.enabled)) return { ok: true, ref: chosen.ref, tabId: result.tabId }
    if (Date.now() - start >= timeout) return { ok: false, error: chosen ? 'Element is disabled' : 'Element not found; use browser.find or snapshot to inspect available targets', matches: result.matches.slice(0, 10) }
    await browserControlSleep(100)
  }
}

// Chromium input events exercise keyboard defaults (Tab, Enter, shortcuts).
// Synthetic DOM KeyboardEvents do not perform those browser actions.
async function browserTestingPress (params) {
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  try {
    const parts = String(params.key || '').split('+')
    let key = parts.pop()
    let modifiers = 0
    const bits = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 }
    parts.forEach(function (part) {
      const bit = bits[part.toLowerCase()]
      if (!bit) throw new Error('Unknown key modifier: ' + part)
      modifiers |= bit
    })
    const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 }
    const keyCode = keys[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
    if (!keyCode) throw new Error('press needs a character, Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, or Space; modifiers use Control+Shift+a')
    if (key === 'Space') key = ' '
    if (browserTestingHasLocator(params)) {
      const focused = await browserControlRunInView(target.view, Object.assign({}, params, { op: 'focus' }))
      if (!focused.ok) return focused
    }
    await browserVisualWithDebugger(target.view.webContents, async function (dbg) {
      const event = { key: key, windowsVirtualKeyCode: keyCode, modifiers: modifiers }
      await dbg.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, event))
      try {
        if (!(modifiers & 7) && (key.length === 1 || key === 'Enter')) {
          await dbg.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: key === 'Enter' ? '\r' : key }, event))
        }
      } finally {
        await dbg.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, event))
      }
    })
    await browserControlAfterPossibleNavigation(target.view)
    return { ok: true, key: params.key, tabId: target.id }
  } catch (err) {
    return { ok: false, error: err.message || String(err), tabId: target.id }
  } finally {
    browserControlRestoreChromeFocus(target.keepChromeFocus)
  }
}

async function browserTestingCheck (params) {
  if (params.checked != null && typeof params.checked !== 'boolean') return { ok: false, error: 'checked must be true or false' }
  const before = await browserControlAct('check', Object.assign({}, params, { prepare: true }))
  if (!before.ok || !before.changed) return before
  const clicked = await browserControlPointer('click', params)
  if (!clicked.ok) return clicked
  return Object.assign(await browserTestingRun(Object.assign({}, params, { action: 'assert', condition: 'checked', expected: params.checked !== false })), { changed: true })
}

global.minBrowserTesting = { run: browserTestingRun, diagnostics: browserTestingDiagnostics, locate: browserTestingLocate, press: browserTestingPress, check: browserTestingCheck }
