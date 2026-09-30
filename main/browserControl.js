/* global viewMap, windows, ipc, loadURLInView, sendIPCToWindow, getWindowWebContents, location, KeyboardEvent, MouseEvent, PointerEvent, DragEvent, DataTransfer, document, window, fs, path, app, minDownloadBeginCapture, minDownloadCancelCapture, browserVisualRun, browserVisualWithDebugger, browserVisualEvaluate, browserTestingRun, browserTestingLocate, browserTestingObserve, browserTestingHasLocator, browserCommandValidate */
/* Browser automation used by the AI agent tools and playbook runner.
Runs in the main process against Electron WebContentsViews. Tab create /
close / select is delegated to the renderer, where Min's tab state lives. */

const browserRendererRequests = require(require('path').join(__dirname, 'main/lib/browser/rendererRequests.js'))({
  send: function (sender, message) {
    const owner = windows.windowFromContents(sender)
    if (!owner) throw new Error('Browser window closed')
    sendIPCToWindow(owner.win, 'browser-control', message)
  }
})

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
  const win = windows.getCurrent()
  return browserRendererRequests.ask(win && getWindowWebContents(win), action, payload, timeoutMs || 8000)
}

ipc.on('browser-control-result', function (e, data) {
  if (!browserRendererRequests.receive(e.sender, data)) return
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
      try { wc.removeListener('destroyed', done) } catch (e) {}
    }
    wc.once('did-stop-loading', done)
    wc.once('did-finish-load', done)
    wc.once('destroyed', done)
  })
}

const browserControlPageDom = require(require('path').join(__dirname, 'main/lib/browser/pageDom.js'))

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
