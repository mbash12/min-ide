/* Design overlay: injects a Figma export into a tab's page DOM so the design
sits on top of the implementation for pixel comparison. The overlay lives
inside the page (absolute-positioned, pointer-events:none) so it scrolls with
the content and shows up in screenshots — including ones the agent takes.

Companion behaviors while an overlay is active:
  - viewport emulation via CDP (Emulation.setDeviceMetricsOverride) so a
    "mobile" variant really lays the page out at 375px
  - scrollbars hidden via insertCSS so gutter width never offsets the compare
  - re-injection on did-finish-load so the overlay survives dev-server reloads

Control changes inside the page are reported back through a magic-prefixed
console message, which keeps main-side state accurate across re-injects. */
/* global ipc, viewMap, fs, path, app */

var designOverlayMap = {} // tabId -> overlay state
var DESIGN_OVERLAY_PREFIX = '__min_design_overlay__'

var DESIGN_OVERLAY_CSS = [
  '#__min-design-overlay{position:absolute;top:0;left:0;z-index:2147483000;pointer-events:none;}',
  '#__min-design-overlay>img{display:block;}',
  '#__min-design-controls{position:fixed;bottom:12px;right:12px;z-index:2147483600;display:flex;align-items:center;gap:4px;',
  'padding:4px 8px;border-radius:8px;background:rgba(20,20,24,.92);border:1px solid rgba(255,255,255,.18);',
  'color:#eee;font:11px/1.4 -apple-system,Segoe UI,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:auto;user-select:none;}',
  '#__min-design-controls .mdo-btn{all:unset;cursor:pointer;padding:2px 6px;border-radius:4px;color:#eee;font:11px/1.4 -apple-system,Segoe UI,sans-serif;}',
  '#__min-design-controls .mdo-btn:hover{background:rgba(255,255,255,.14);}',
  '#__min-design-controls .mdo-btn.mdo-on{background:rgba(80,140,255,.45);}',
  '#__min-design-controls .mdo-label{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85;margin-right:2px;}',
  '#__min-design-controls input[type=range]{width:64px;height:12px;accent-color:#5a8cff;}',
  '#__min-design-controls .mdo-sep{width:1px;height:14px;background:rgba(255,255,255,.2);}'
].join('\n')

var DESIGN_OVERLAY_SCROLLBAR_CSS = [
  '::-webkit-scrollbar{display:none!important;}',
  'html{scrollbar-width:none!important;}'
].join('\n')

// Runs inside the target page. State arrives as a serialized argument.
var designOverlayInjectScript = function (state) {
  var PREFIX = '__min_design_overlay__'
  var sync = function () {
    var s = window.__minDesignOverlayState
    try {
      console.log(PREFIX + JSON.stringify({
        opacity: s.opacity,
        blend: s.blend,
        visible: s.visible,
        offsetX: s.offsetX,
        offsetY: s.offsetY,
        close: s.close
      }))
    } catch (e) {}
  }
  var apply = function () {
    var s = window.__minDesignOverlayState
    var overlay = document.getElementById('__min-design-overlay')
    var img = overlay && overlay.querySelector('img')
    if (!overlay || !img) return
    overlay.style.display = s.visible ? '' : 'none'
    overlay.style.transform = 'translate(' + s.offsetX + 'px,' + s.offsetY + 'px)'
    img.style.opacity = String(s.opacity)
    img.style.mixBlendMode = s.blend ? 'difference' : 'normal'
    if (s.cssWidth) img.setAttribute('width', String(s.cssWidth))
    var c = document.getElementById('__min-design-controls')
    if (c) {
      c.querySelector('[data-mdo=vis]').textContent = s.visible ? '◉' : '○'
      c.querySelector('[data-mdo=blend]').classList.toggle('mdo-on', !!s.blend)
      c.querySelector('[data-mdo=opacity]').value = String(Math.round(s.opacity * 100))
    }
  }
  window.__minDesignOverlayApply = function (patch) {
    Object.assign(window.__minDesignOverlayState, patch)
    apply()
    sync()
  }
  window.__minDesignOverlayState = Object.assign({
    opacity: 0.5, blend: false, visible: true, offsetX: 0, offsetY: 0
  }, state)

  var overlay = document.getElementById('__min-design-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = '__min-design-overlay'
    var img = document.createElement('img')
    img.alt = 'design overlay'
    img.draggable = false
    overlay.appendChild(img)
    document.documentElement.appendChild(overlay)
  }
  overlay.querySelector('img').src = state.imageData

  var controls = document.getElementById('__min-design-controls')
  if (!controls) {
    controls = document.createElement('div')
    controls.id = '__min-design-controls'
    controls.innerHTML =
      '<span class="mdo-label"></span>' +
      '<button class="mdo-btn" data-mdo="vis" title="Show / hide design">◉</button>' +
      '<input type="range" min="10" max="100" data-mdo="opacity" title="Opacity">' +
      '<button class="mdo-btn" data-mdo="blend" title="Difference blend">diff</button>' +
      '<span class="mdo-sep"></span>' +
      '<button class="mdo-btn" data-mdo="left" title="Nudge left">←</button>' +
      '<button class="mdo-btn" data-mdo="right" title="Nudge right">→</button>' +
      '<button class="mdo-btn" data-mdo="up" title="Nudge up">↑</button>' +
      '<button class="mdo-btn" data-mdo="down" title="Nudge down">↓</button>' +
      '<button class="mdo-btn" data-mdo="reset" title="Reset offset">0,0</button>' +
      '<span class="mdo-sep"></span>' +
      '<button class="mdo-btn" data-mdo="close" title="Close overlay">✕</button>'
    document.documentElement.appendChild(controls)
    controls.addEventListener('click', function (e) {
      var k = e.target && e.target.getAttribute && e.target.getAttribute('data-mdo')
      var s = window.__minDesignOverlayState
      if (!k) return
      var step = e.shiftKey ? 10 : 1
      if (k === 'vis') window.__minDesignOverlayApply({ visible: !s.visible })
      else if (k === 'blend') window.__minDesignOverlayApply({ blend: !s.blend })
      else if (k === 'left') window.__minDesignOverlayApply({ offsetX: s.offsetX - step })
      else if (k === 'right') window.__minDesignOverlayApply({ offsetX: s.offsetX + step })
      else if (k === 'up') window.__minDesignOverlayApply({ offsetY: s.offsetY - step })
      else if (k === 'down') window.__minDesignOverlayApply({ offsetY: s.offsetY + step })
      else if (k === 'reset') window.__minDesignOverlayApply({ offsetX: 0, offsetY: 0 })
      else if (k === 'close') window.__minDesignOverlayApply({ close: true })
    })
    controls.addEventListener('input', function (e) {
      if (e.target && e.target.getAttribute('data-mdo') === 'opacity') {
        window.__minDesignOverlayApply({ opacity: Math.min(1, Math.max(0.1, Number(e.target.value) / 100)) })
      }
    })
  }
  controls.querySelector('.mdo-label').textContent = state.label || ''
  apply()
  sync()
  return true
}

var designOverlayRemoveScript = function () {
  var overlay = document.getElementById('__min-design-overlay')
  if (overlay) overlay.remove()
  var controls = document.getElementById('__min-design-controls')
  if (controls) controls.remove()
  delete window.__minDesignOverlayState
  delete window.__minDesignOverlayApply
  return true
}

function designOverlayView (tabId) {
  var view = viewMap[tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) return null
  return view
}

function designOverlayEnsureHooks (tabId, wc) {
  var state = designOverlayMap[tabId]
  if (!state || state.hooksAttached) return
  state.hooksAttached = true
  wc.on('did-finish-load', function () {
    var current = designOverlayMap[tabId]
    if (current && !wc.isDestroyed()) {
      designOverlayInject(tabId).catch(function () {})
    }
  })
  wc.on('console-message', function (e, level, message) {
    // Electron <=36 emits (event, level, message, line, sourceId); newer
    // versions emit (event, details). Accept both shapes.
    if (typeof level === 'object' && level !== null) message = level.message
    if (typeof message !== 'string' || message.indexOf(DESIGN_OVERLAY_PREFIX) !== 0) return
    var patch
    try { patch = JSON.parse(message.slice(DESIGN_OVERLAY_PREFIX.length)) } catch (err) { return }
    var current = designOverlayMap[tabId]
    if (!current || !patch || typeof patch !== 'object') return
    if (patch.close) {
      designOverlayClear(tabId).catch(function () {})
      return
    }
    Object.assign(current, {
      opacity: patch.opacity,
      blend: patch.blend,
      visible: patch.visible,
      offsetX: patch.offsetX,
      offsetY: patch.offsetY
    })
  })
  wc.once('destroyed', function () {
    delete designOverlayMap[tabId]
  })
}

async function designOverlayEmulate (wc, state) {
  var dbg = wc.debugger
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      state.debuggerAttached = true
    }
    if (state.viewport) {
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: state.viewport.w,
        height: state.viewport.h,
        deviceScaleFactor: state.viewport.dpr || 0,
        mobile: !!state.viewport.mobile
      })
    } else {
      await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
    }
    return true
  } catch (e) {
    return false
  }
}

async function designOverlayDeEmulate (wc, state) {
  try {
    if (wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(function () {})
      if (state.debuggerAttached) {
        wc.debugger.detach()
        state.debuggerAttached = false
      }
    }
  } catch (e) {}
}

async function designOverlayInject (tabId) {
  var state = designOverlayMap[tabId]
  var view = designOverlayView(tabId)
  if (!state || !view) return false
  var wc = view.webContents
  try {
    var stat = fs.statSync(state.image)
    if (stat.size > 30 * 1024 * 1024) return false
    var buf = fs.readFileSync(state.image)
    var dataUrl = 'data:image/' + (state.image.slice(-4) === '.svg' ? 'svg+xml' : 'png') + ';base64,' + buf.toString('base64')
    var cssWidth = state.cssWidth || (state.viewport ? state.viewport.w : null)
    await wc.executeJavaScript(
      '(' + designOverlayInjectScript.toString() + ')(' + JSON.stringify({
        imageData: dataUrl,
        label: state.label,
        cssWidth: cssWidth,
        opacity: state.opacity,
        blend: state.blend,
        visible: state.visible,
        offsetX: state.offsetX,
        offsetY: state.offsetY
      }) + ')',
      true
    )
    return true
  } catch (e) {
    return false
  }
}

async function designOverlaySet (tabId, opts) {
  var view = designOverlayView(tabId)
  if (!view) return { ok: false, error: 'Tab not found' }
  if (!opts || !opts.image) return { ok: false, error: 'image is required' }
  var existing = designOverlayMap[tabId]
  if (existing) await designOverlayClear(tabId)
  var state = designOverlayMap[tabId] = {
    image: opts.image,
    label: opts.label || '',
    cssWidth: opts.cssWidth || null,
    viewport: opts.viewport || null,
    entryId: opts.entryId || null,
    variantId: opts.variantId || null,
    opacity: 0.5,
    blend: false,
    visible: true,
    offsetX: 0,
    offsetY: 0,
    debuggerAttached: false,
    hooksAttached: false
  }
  var wc = view.webContents
  designOverlayEnsureHooks(tabId, wc)
  state.cssKey = await wc.insertCSS(DESIGN_OVERLAY_CSS).catch(function () { return null })
  state.scrollCssKey = await wc.insertCSS(DESIGN_OVERLAY_SCROLLBAR_CSS).catch(function () { return null })
  await designOverlayEmulate(wc, state)
  await designOverlayInject(tabId)
  return { ok: true, tabId: tabId }
}

async function designOverlayClear (tabId) {
  var state = designOverlayMap[tabId]
  var view = designOverlayView(tabId)
  delete designOverlayMap[tabId]
  if (!view) return { ok: true }
  var wc = view.webContents
  if (state) {
    if (state.cssKey) wc.removeInsertedCSS(state.cssKey).catch(function () {})
    if (state.scrollCssKey) wc.removeInsertedCSS(state.scrollCssKey).catch(function () {})
    await designOverlayDeEmulate(wc, state)
  }
  await wc.executeJavaScript('(' + designOverlayRemoveScript.toString() + ')()', true).catch(function () {})
  return { ok: true }
}

function designOverlayGet (tabId) {
  var state = designOverlayMap[tabId]
  if (!state) return { ok: true, active: false }
  return {
    ok: true,
    active: true,
    tabId: tabId,
    entryId: state.entryId,
    variantId: state.variantId,
    label: state.label,
    viewport: state.viewport,
    opacity: state.opacity,
    blend: state.blend,
    offsetX: state.offsetX,
    offsetY: state.offsetY
  }
}

async function designOverlayCapture (tabId, name, dir) {
  var view = designOverlayView(tabId)
  if (!view) return { ok: false, error: 'Tab not found' }
  if (!dir) dir = path.join(app.getPath('userData'), 'figma-exports')
  try {
    fs.mkdirSync(dir, { recursive: true })
    var image = await view.webContents.capturePage()
    var base = String(name || 'shot').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'shot'
    var filePath = path.join(dir, base + '-' + Date.now() + '.png')
    fs.writeFileSync(filePath, image.toPNG())
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

ipc.handle('designOverlay:set', function (e, opts) {
  return designOverlaySet(opts && opts.tabId, opts || {})
})
ipc.handle('designOverlay:clear', function (e, opts) {
  return designOverlayClear(opts && opts.tabId)
})
ipc.handle('designOverlay:get', function (e, opts) {
  return designOverlayGet(opts && opts.tabId)
})
ipc.handle('designOverlay:capture', function (e, opts) {
  return designOverlayCapture(opts && opts.tabId, opts && opts.name, opts && opts.dir)
})

// The sidebar runs on the min:// origin where file:// subresources are
// blocked, so variant thumbnails are served as data URLs through IPC.
ipc.handle('designOverlay:imageData', function (e, opts) {
  try {
    var p = String((opts && opts.path) || '')
    if (!/\.(png|jpe?g|svg)$/i.test(p)) return null
    var stat = fs.statSync(p)
    if (stat.size > 20 * 1024 * 1024) return null
    var mime = p.slice(-4).toLowerCase() === '.svg' ? 'image/svg+xml'
      : /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png'
    return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64')
  } catch (err) {
    return null
  }
})

var minDesignOverlay = {
  set: designOverlaySet,
  clear: designOverlayClear,
  get: designOverlayGet,
  capture: designOverlayCapture
}
global.minDesignOverlay = minDesignOverlay
