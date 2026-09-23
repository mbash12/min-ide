/* Visual tools run against Min's existing WebContentsViews. No browser process,
remote debugging port, or external automation runtime is created. */
/* global app, fs, path, browserControlTargetView, browserControlRestoreChromeFocus, browserControlPageDom, browserControlResolveLocalPath, browserControlWaitIdle, document, window */

var browserVisualNativeImage = require('electron').nativeImage
var browserVisualStates = new WeakMap()
var BROWSER_VISUAL_MAX_PIXELS = 16 * 1024 * 1024

function browserVisualState (wc) {
  let state = browserVisualStates.get(wc)
  if (!state) {
    state = { browser: null, overlay: null, owned: false, users: 0, queue: Promise.resolve() }
    browserVisualStates.set(wc, state)
    wc.debugger.on('detach', function () { state.owned = false })
  }
  return state
}

function browserVisualQueue (wc, fn) {
  const state = browserVisualState(wc)
  const next = state.queue.then(fn, fn)
  state.queue = next.catch(function () {})
  return next
}

async function browserVisualWithDebugger (wc, fn) {
  const state = browserVisualState(wc)
  const dbg = wc.debugger
  state.users++
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      state.owned = true
      const viewport = state.browser || state.overlay
      if (viewport) await dbg.sendCommand('Emulation.setDeviceMetricsOverride', viewport)
    }
    return await fn(dbg)
  } finally {
    state.users--
    if (!state.users && !state.browser && !state.overlay && state.owned) {
      try { dbg.detach() } catch (e) {}
      state.owned = false
    }
  }
}

function browserVisualViewportOptions (value) {
  const width = value.width == null ? value.w : value.width
  const height = value.height == null ? value.h : value.height
  const dpr = value.dpr == null ? 1 : value.dpr
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('viewport needs integer width and height between 1 and 8192 CSS pixels')
  }
  if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 4 || width * height * dpr * dpr > BROWSER_VISUAL_MAX_PIXELS) {
    throw new Error('viewport dpr must be 0.5–4, with at most 16 megapixels')
  }
  return { width: width, height: height, deviceScaleFactor: dpr, mobile: !!value.mobile }
}

// Independent layers: an explicit browser viewport wins over the overlay's
// suggested size. Removing either layer restores the remaining one.
async function browserVisualSetViewport (wc, source, value) {
  const viewport = value ? browserVisualViewportOptions(value) : null
  return browserVisualQueue(wc, async function () {
    const state = browserVisualState(wc)
    const previous = state[source]
    return browserVisualWithDebugger(wc, async function (dbg) {
      state[source] = viewport
      try {
        const effective = state.browser || state.overlay
        await dbg.sendCommand(effective ? 'Emulation.setDeviceMetricsOverride' : 'Emulation.clearDeviceMetricsOverride', effective || {})
      } catch (err) {
        state[source] = previous
        throw err
      }
    })
  })
}

function browserVisualMetricsScript (opts) {
  const viewport = window.visualViewport
  return {
    // Mobile innerWidth can include overflowing content beyond the screen.
    // Desktop innerWidth includes the native scrollbar gutter, as captures do.
    width: opts.mobile && viewport ? Math.round(viewport.width * 100) / 100 : window.innerWidth,
    height: opts.mobile && viewport ? Math.round(viewport.height * 100) / 100 : window.innerHeight,
    layoutWidth: document.documentElement.clientWidth,
    layoutHeight: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    pageScale: viewport ? viewport.scale : 1,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight
  }
}

function browserVisualMetrics (wc) {
  const state = browserVisualState(wc)
  const viewport = state.browser || state.overlay
  return browserVisualEvaluate(wc, browserVisualMetricsScript, { mobile: !!(viewport && viewport.mobile) })
}

async function browserVisualEvaluate (wc, fn, params) {
  // executeJavaScript waits for did-stop-loading. Runtime.evaluate also works
  // while a slow image/font is holding the load event open.
  const result = await wc.debugger.sendCommand('Runtime.evaluate', {
    expression: '(' + fn.toString() + ')(' + JSON.stringify(params || {}) + ')',
    awaitPromise: true,
    returnByValue: true,
    timeout: Math.max(5000, Math.min(20000, ((params && params.timeout) || 4000) + 2000))
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text)
  return result.result.value
}

// Bound readiness waits: stalled fonts/images or an occluded tab cannot hang a
// tool. Report unfinished resources so the model can choose to wait and retry.
async function browserVisualReadyScript (opts) {
  const docs = [document]
  for (let i = 0; i < docs.length && i < 20; i++) {
    for (const frame of docs[i].querySelectorAll('iframe')) {
      try { if (frame.contentDocument && docs.length < 20) docs.push(frame.contentDocument) } catch (e) {}
    }
  }
  const images = docs.reduce(function (all, doc) { return all.concat(Array.from(doc.images)) }, []).filter(function (img) {
    const rect = img.getBoundingClientRect()
    const view = img.ownerDocument.defaultView
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth
  })
  const jobs = docs.map(function (doc) { return doc.fonts.ready })
  images.forEach(function (img) {
    jobs.push(img.decode().catch(function () {}))
  })
  let timer
  let timedOut = false
  await Promise.race([
    Promise.all(jobs),
    new Promise(function (resolve) { timer = setTimeout(function () { timedOut = true; resolve() }, opts.timeout) })
  ])
  clearTimeout(timer)
  await new Promise(function (resolve) {
    const fallback = setTimeout(resolve, 100)
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { clearTimeout(fallback); resolve() })
    })
  })
  return {
    timedOut: timedOut,
    fontsReady: docs.every(function (doc) { return doc.fonts.status === 'loaded' }),
    pendingImages: images.filter(function (img) { return !img.complete }).length,
    brokenImages: images.filter(function (img) { return img.complete && !img.naturalWidth }).length
  }
}

async function browserVisualPrepared (wc, params, fn) {
  const timeout = Math.max(100, Math.min(15000, params.timeout || 4000))
  const throttling = wc.getBackgroundThrottling()
  const css = []
  if (params.includeOverlay !== true) css.push('#__min-design-overlay,#__min-design-controls{display:none!important;}')
  if (params.hideScrollbars !== false) css.push('::-webkit-scrollbar{display:none!important;}html{scrollbar-width:none!important;}')
  if (params.freezeAnimations !== false) css.push('*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important;}')
  let key
  try {
    wc.setBackgroundThrottling(false)
    const loading = await browserControlWaitIdle({ webContents: wc }, timeout)
    // Electron 43 can leave user-origin sheets behind after removeInsertedCSS.
    // Author-origin sheets remain removable on both success and error paths.
    if (css.length) key = await wc.insertCSS(css.join('\n'))
    const ready = await browserVisualEvaluate(wc, browserVisualReadyScript, { timeout: timeout })
    ready.loadTimedOut = loading.timedOut
    ready.overlayIncluded = params.includeOverlay === true
    ready.scrollbarsHidden = params.hideScrollbars !== false
    ready.animationsPaused = params.freezeAnimations !== false
    return await fn(ready)
  } finally {
    if (!wc.isDestroyed()) {
      if (key) await wc.removeInsertedCSS(key).catch(function () {})
      wc.setBackgroundThrottling(throttling)
    }
  }
}

function browserVisualRect (value, name) {
  if (!value || !['x', 'y', 'width', 'height'].every(function (key) { return Number.isFinite(value[key]) }) || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0) {
    throw new Error(name + ' needs finite x/y >= 0 and width/height > 0 in CSS pixels')
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function browserVisualCheckImage (image) {
  const size = image.getSize()
  if (image.isEmpty() || !size.width || !size.height) throw new Error('Could not decode PNG/JPEG image')
  if (size.width * size.height > BROWSER_VISUAL_MAX_PIXELS) throw new Error('Image exceeds the 16 megapixel limit; export a smaller frame or area')
  return size
}

function browserVisualLoadImage (filePath) {
  const resolved = browserVisualLocalPath(filePath)
  if (!resolved) throw new Error('An absolute local PNG/JPEG path or min://app/ path is required')
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error('Reference image must be a file below 40 MB')
  // Buffer decoding avoids nativeImage's automatic @2x filename interpretation.
  const buffer = fs.readFileSync(resolved)
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
  if (!png && !jpeg) throw new Error('Use a PNG or JPEG reference image')
  if (png && buffer.length >= 24 && buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > BROWSER_VISUAL_MAX_PIXELS) {
    throw new Error('Reference exceeds 16 megapixels; export a smaller frame or area')
  }
  const image = browserVisualNativeImage.createFromBuffer(buffer)
  browserVisualCheckImage(image)
  return image
}

function browserVisualLocalPath (filePath) {
  if (typeof filePath !== 'string' || (!path.isAbsolute(filePath) && filePath.indexOf('min://app/') !== 0)) return null
  return browserControlResolveLocalPath(filePath)
}

function browserVisualDestination (params, label) {
  if (params.path && label === 'actual') {
    const resolved = browserVisualLocalPath(params.path)
    if (!resolved) throw new Error('Screenshot path must be absolute or min://app/...')
    return resolved
  }
  const dir = params.outputDir || path.join(app.getPath('userData'), 'playbook-captures')
  return path.join(dir, label + '-' + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.png')
}

function browserVisualSave (image, params, label, rect) {
  const dest = browserVisualDestination(params, label)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, image.toPNG())
  return Object.assign({ label: label, path: dest, cssRect: rect }, image.getSize())
}

async function browserVisualCapture (target, params, dbg, ready) {
  const wc = target.view.webContents
  let rect = params.clip ? browserVisualRect(params.clip, 'clip') : null
  const hasLocator = params.selector || params.ref || params.role || params.text
  if (rect && hasLocator) throw new Error('Use either clip or an element locator for screenshot/compare')
  if (hasLocator) {
    const element = await browserVisualEvaluate(wc, browserControlPageDom, Object.assign({}, params, { op: 'inspect', geometryOnly: true }))
    if (!element || !element.ok) throw new Error((element && element.error) || 'Element not found')
    if (element.geometryApproximate) throw new Error('Screenshot of an element inside a rotated/skewed iframe needs an explicit clip')
    rect = browserVisualRect(element.rect, 'Element bounds (scroll the element into view first)')
  }
  const metrics = await browserVisualMetrics(wc)
  if (Math.abs(metrics.pageScale - 1) > 0.001) throw new Error('Page scale is ' + metrics.pageScale.toFixed(3) + '. Reset pinch zoom or correct the mobile viewport meta tag/horizontal overflow before capture.')
  if (!rect) rect = { x: 0, y: 0, width: metrics.width, height: metrics.height }
  if (rect.x + rect.width > metrics.width + 0.01 || rect.y + rect.height > metrics.height + 0.01) {
    throw new Error('Capture bounds extend outside the viewport; scroll, set a larger viewport, or use a smaller clip')
  }
  if (metrics.width * metrics.height * metrics.dpr * metrics.dpr > BROWSER_VISUAL_MAX_PIXELS) throw new Error('Viewport capture exceeds 16 megapixels')
  const documentRect = Object.assign({}, rect, { x: rect.x + metrics.scrollX, y: rect.y + metrics.scrollY })
  // Capture a stable full viewport, then crop locally so fixed/sticky elements
  // keep the same geometry for full-page and detail comparisons.
  let timer
  let result
  try {
    result = await Promise.race([
      dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: metrics.scrollX, y: metrics.scrollY, width: metrics.width, height: metrics.height, scale: 1 }
      }),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error('Tab compositor did not produce a frame. Select the tab in Min or restore the Min window, then retry.'))
          // A compositor may stop producing frames when its native surface is
          // occluded. Cancel our own session so it cannot strand later actions.
          const state = browserVisualState(wc)
          if (state.owned && state.users === 1) {
            try { dbg.detach() } catch (e) {}
          }
        }, Math.max(1000, Math.min(15000, params.timeout || 8000)))
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  let image = browserVisualNativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
  const fullSize = browserVisualCheckImage(image)
  const sx = fullSize.width / metrics.width
  const sy = fullSize.height / metrics.height
  const x = Math.round(rect.x * sx)
  const y = Math.round(rect.y * sy)
  const width = Math.round((rect.x + rect.width) * sx) - x
  const height = Math.round((rect.y + rect.height) * sy) - y
  if (!width || !height) throw new Error('Capture area is smaller than one image pixel')
  if (x || y || width !== fullSize.width || height !== fullSize.height) image = image.crop({ x: x, y: y, width: width, height: height })
  const size = browserVisualCheckImage(image)
  return { image: image, rect: rect, documentRect: documentRect, viewport: metrics, ready: ready, pixelScale: { x: size.width / rect.width, y: size.height / rect.height } }
}

function browserVisualReference (params, capture) {
  if (!params.referencePath) throw new Error('compare needs referencePath (local PNG/JPEG)')
  const reference = browserVisualLoadImage(params.referencePath)
  const size = reference.getSize()
  const scale = params.referenceScale == null ? 1 : params.referenceScale
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) throw new Error('referenceScale must be > 0 and <= 8 (export pixels per CSS pixel)')
  if (!params.referenceClip && Math.abs(size.width / scale - capture.viewport.width) > 0.5) {
    throw new Error('Reference CSS width (' + size.width / scale + ') differs from viewport (' + capture.viewport.width + '). Set viewport/referenceScale, or supply an explicit referenceClip for a cropped reference. Images are not stretched to fit.')
  }
  const rect = params.referenceClip ? browserVisualRect(params.referenceClip, 'referenceClip') : capture.documentRect
  if (Math.abs(rect.width - capture.rect.width) > 0.01 || Math.abs(rect.height - capture.rect.height) > 0.01) {
    throw new Error('referenceClip must have the same CSS width/height as the captured area')
  }
  const x = Math.round(rect.x * scale)
  const y = Math.round(rect.y * scale)
  const right = Math.round((rect.x + rect.width) * scale)
  const bottom = Math.round((rect.y + rect.height) * scale)
  if (right > size.width || bottom > size.height || right <= x || bottom <= y) throw new Error('Reference image does not contain the requested area at referenceScale')
  let image = reference.crop({ x: x, y: y, width: right - x, height: bottom - y })
  const actualSize = capture.image.getSize()
  if (image.getSize().width !== actualSize.width || image.getSize().height !== actualSize.height) {
    image = image.resize({ width: actualSize.width, height: actualSize.height, quality: 'best' })
  }
  return { image: image, rect: rect, originalSize: size, scale: scale }
}

// Native bitmaps on Electron's supported little-endian platforms are BGRA,
// premultiplied. Compare each color on white; magenta is RGB/BGR invariant.
async function browserVisualDiff (actual, reference, threshold, rect) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be between 0 and 1')
  const size = actual.getSize()
  const a = actual.toBitmap()
  const b = reference.toBitmap()
  const output = Buffer.alloc(a.length)
  if (a.length !== b.length || a.length !== size.width * size.height * 4) throw new Error('Bitmap dimensions do not match')
  const tiles = new Map()
  const tileSize = Math.max(1, Math.round(64 * size.width / rect.width))
  let changed = 0
  let error = 0
  let minX = size.width
  let minY = size.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4
      let delta = 0
      let shade = 0
      for (let c = 0; c < 3; c++) {
        const ac = Math.min(255, a[i + c] + 255 - a[i + 3])
        const bc = Math.min(255, b[i + c] + 255 - b[i + 3])
        const difference = Math.abs(ac - bc)
        delta = Math.max(delta, difference)
        error += difference
        shade += ac
      }
      const differs = delta > threshold * 255
      const tx = Math.floor(x / tileSize) * tileSize
      const ty = Math.floor(y / tileSize) * tileSize
      const key = tx + ':' + ty
      let tile = tiles.get(key)
      if (!tile) {
        tile = { x: tx, y: ty, width: Math.min(tileSize, size.width - tx), height: Math.min(tileSize, size.height - ty), changed: 0 }
        tiles.set(key, tile)
      }
      if (differs) {
        changed++
        tile.changed++
        minX = Math.min(minX, x); minY = Math.min(minY, y)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
      const gray = Math.round(210 + shade / 3 * 45 / 255)
      output[i] = differs ? 255 : gray
      output[i + 1] = differs ? 0 : gray
      output[i + 2] = differs ? 255 : gray
      output[i + 3] = 255
    }
    if (y % 128 === 127) await new Promise(function (resolve) { setImmediate(resolve) })
  }
  function cssRect (r) {
    return { x: rect.x + r.x * rect.width / size.width, y: rect.y + r.y * rect.height / size.height, width: r.width * rect.width / size.width, height: r.height * rect.height / size.height }
  }
  const regions = Array.from(tiles.values()).filter(function (t) { return t.changed > 0 }).sort(function (a, b) {
    return b.changed - a.changed
  }).slice(0, 12).map(function (tile) {
    return { rect: cssRect(tile), changedPixels: tile.changed, mismatchRatio: tile.changed / (tile.width * tile.height) }
  })
  return {
    image: browserVisualNativeImage.createFromBitmap(output, size),
    metrics: {
      changedPixels: changed,
      totalPixels: size.width * size.height,
      mismatchRatio: changed / (size.width * size.height),
      meanAbsoluteError: error / (size.width * size.height * 3 * 255),
      threshold: threshold,
      regions: regions,
      bounds: changed ? cssRect({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }) : null,
      method: 'Max RGB channel difference on white; magenta marks changed pixels. Includes antialiasing differences; this is not a semantic similarity score.',
      coordinates: 'viewport CSS pixels'
    }
  }
}

async function browserVisualInspect (target, params, dbg, ready) {
  const result = await browserVisualEvaluate(target.view.webContents, browserControlPageDom, Object.assign({}, params, { op: 'inspect' }))
  if (!result || !result.ok) return result
  result.ready = ready
  result.viewport = await browserVisualMetrics(target.view.webContents)
  let objectId
  try {
    await dbg.sendCommand('DOM.enable')
    await dbg.sendCommand('CSS.enable')
    await dbg.sendCommand('DOM.getDocument', { depth: 0 })
    const evaluated = await dbg.sendCommand('Runtime.evaluate', { expression: 'window.__minAgentInspectEl' })
    objectId = evaluated.result && evaluated.result.objectId
    if (objectId) {
      const node = await dbg.sendCommand('DOM.requestNode', { objectId: objectId })
      const fonts = await dbg.sendCommand('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })
      result.renderedFonts = fonts.fonts
    }
  } catch (err) {
    result.renderedFontsUnavailable = err.message
  } finally {
    if (objectId) await dbg.sendCommand('Runtime.releaseObject', { objectId: objectId }).catch(function () {})
    await dbg.sendCommand('Runtime.evaluate', { expression: 'delete window.__minAgentInspectEl' }).catch(function () {})
  }
  return result
}

async function browserVisualRun (params) {
  params = params || {}
  if (params.action === 'compare') params = Object.assign({}, params, { includeOverlay: false })
  const target = await browserControlTargetView(params.tabId, params.taskId, params.workspaceId)
  if (target.error) return { ok: false, error: target.error }
  const wc = target.view.webContents
  try {
    if (params.maxMismatchRatio != null && (!Number.isFinite(params.maxMismatchRatio) || params.maxMismatchRatio < 0 || params.maxMismatchRatio > 1)) throw new Error('maxMismatchRatio must be between 0 and 1')
    if (params.action === 'compare' && params.path && params.referencePath) {
      const output = browserVisualLocalPath(params.path)
      const reference = browserVisualLocalPath(params.referencePath)
      if (output && reference && (output === reference || (fs.existsSync(output) && fs.existsSync(reference) && fs.realpathSync(output) === fs.realpathSync(reference)))) {
        throw new Error('The capture destination must not overwrite the reference image')
      }
    }
    if (params.action === 'viewport') {
      const operation = params.operation || (params.width != null || params.height != null ? 'set' : 'get')
      if (operation === 'set' || operation === 'reset') await browserVisualSetViewport(wc, 'browser', operation === 'reset' ? null : params)
      else if (operation !== 'get') throw new Error('viewport operation must be get, set, or reset')
      return await browserVisualQueue(wc, function () {
        return browserVisualWithDebugger(wc, async function () {
          const state = browserVisualState(wc)
          return { ok: true, tabId: target.id, source: state.browser ? 'browser' : state.overlay ? 'overlay' : 'window', configured: state.browser || state.overlay, viewport: await browserVisualMetrics(wc) }
        })
      })
    }
    return await browserVisualQueue(wc, function () {
      return browserVisualWithDebugger(wc, function (dbg) {
        return browserVisualPrepared(wc, params, async function (ready) {
          if (params.action === 'inspect') return browserVisualInspect(target, params, dbg, ready)
          const capture = await browserVisualCapture(target, params, dbg, ready)
          const images = []
          const result = { ok: true, tabId: target.id, viewport: capture.viewport, rect: capture.rect, documentRect: capture.documentRect, pixelScale: capture.pixelScale, ready: ready, images: images }
          if (params.action === 'compare') {
            const reference = browserVisualReference(params, capture)
            const diff = await browserVisualDiff(capture.image, reference.image, params.threshold == null ? 0.1 : params.threshold, capture.rect)
            images.push(browserVisualSave(reference.image, params, 'reference', reference.rect))
            images.push(browserVisualSave(capture.image, params, 'actual', capture.rect))
            images.push(browserVisualSave(diff.image, params, 'diff', capture.rect))
            result.reference = { path: params.referencePath, originalSize: reference.originalSize, scale: reference.scale, rect: reference.rect }
            result.diff = diff.metrics
            if (params.maxMismatchRatio != null) {
              result.assertion = { passed: diff.metrics.mismatchRatio <= params.maxMismatchRatio && !ready.timedOut, expected: params.maxMismatchRatio, actual: diff.metrics.mismatchRatio, condition: 'maxMismatchRatio', ready: !ready.timedOut }
            }
          } else {
            images.push(browserVisualSave(capture.image, params, 'actual', capture.rect))
          }
          const actual = images.find(function (i) { return i.label === 'actual' })
          return Object.assign(result, { path: actual.path, width: actual.width, height: actual.height })
        })
      })
    })
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  } finally {
    browserControlRestoreChromeFocus(target.keepChromeFocus)
  }
}

// Keep model payloads bounded. Saved artifacts retain their full resolution;
// metadata explicitly maps preview pixels back to CSS coordinates.
function browserVisualPreview (descriptor) {
  let image = browserVisualLoadImage(descriptor.path)
  const original = image.getSize()
  const ratio = Math.min(1, 1600 / Math.max(original.width, original.height))
  if (ratio < 1) image = image.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)), quality: 'best' })
  let buffer = image.toPNG()
  let mimeType = 'image/png'
  if (buffer.length > 3 * 1024 * 1024) { buffer = image.toJPEG(85); mimeType = 'image/jpeg' }
  const size = image.getSize()
  const rect = descriptor.cssRect
  return {
    content: { type: 'image', data: buffer.toString('base64'), mimeType: mimeType },
    info: Object.assign({}, descriptor, { originalSize: original, previewSize: size, previewToCSS: rect ? { offsetX: rect.x, offsetY: rect.y, scaleX: rect.width / size.width, scaleY: rect.height / size.height } : null })
  }
}

global.minBrowserVisual = { run: browserVisualRun, preview: browserVisualPreview }
