/* Spawns a figma-linux-next process and talks to it over loopback.
Min tabs stay the controller; the child runs the local dev plugin. */
/* global fs, path, ipc, app, settings, viewMap, windows, getWindowWebContents, minFigmaBridge */

var childProcess = require('child_process')
var http = require('http')

var FIGMA_ENGINE_CONTROL_PORT = 44179
var FIGMA_ENGINE_PLUGIN_NAME = 'Min Figma Bridge'
var FIGMA_ENGINE_READY_MS = 45000
var FIGMA_ENGINE_PLUGIN_WAIT_MS = 25000
// A first load downloads the editor/WASM assets into the engine's own cache.
var FIGMA_ENGINE_FILE_WAIT_MS = 150000
var FIGMA_ENGINE_FILE_STABLE_MS = 2500

var figmaEngineChild = null
var figmaEngineContext = null
var figmaEngineStarting = null
var figmaEngineStopping = null
var figmaEngineConnecting = null
var figmaEngineControlReady = false
var figmaEngineWindowVisible = false
var figmaEnginePhase = 'stopped'
var figmaEnginePhaseError = null
var figmaEngineSenders = new Set()

function figmaParseUrl (raw) {
  var url = String(raw || '')
  var fileMatch = url.match(/^https:\/\/(?:[\w-]+\.)*figma\.com\/(design|file|proto|board|deck)\/([A-Za-z0-9]+)/i)
  var nodeMatch = url.match(/[?&]node-id=([^&]+)/i)
  var nodeId = null
  if (nodeMatch) {
    try {
      nodeId = decodeURIComponent(nodeMatch[1]).replace(/-/g, ':')
    } catch (e) {
      nodeId = nodeMatch[1].replace(/-/g, ':')
    }
  }
  return {
    url: url,
    fileKey: fileMatch ? fileMatch[2] : null,
    nodeId: nodeId,
    isFigmaFile: !!fileMatch
  }
}

function figmaEngineEmit (data) {
  var payload = Object.assign({
    phase: 'status',
    time: Date.now()
  }, data)
  figmaEngineSenders.forEach(function (sender) {
    if (!sender.isDestroyed()) {
      sender.send('figma-engine-event', payload)
    }
  })
}

function figmaEngineEmitPhase (phase, extra) {
  figmaEnginePhase = phase
  figmaEnginePhaseError = extra && extra.error ? extra.error : null
  figmaEngineEmit(Object.assign({ phase: phase, context: figmaEngineContext }, extra || {}))
}

function figmaEngineUserData () {
  return path.join(app.getPath('userData'), 'figma-engine')
}

function figmaEnginePluginPath () {
  return path.join(__dirname, 'figma-plugin')
}

function figmaEngineVendorRoot () {
  return path.join(__dirname, 'vendor', 'figma-linux-next')
}

function figmaEngineFindElectron (vendorRoot) {
  var candidates = [
    path.join(vendorRoot, 'node_modules', 'electron', 'dist', 'electron'),
    // Min's Electron is a known-good version — prefer it over an arbitrary
    // system electron, which could still be a Chromium-148-era build that
    // rejects Figma's /app_auth/redeem request headers.
    path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron'),
    '/usr/bin/electron',
    '/usr/lib/electron/electron'
  ]
  if (process.platform === 'win32') {
    candidates.unshift(path.join(vendorRoot, 'node_modules', 'electron', 'dist', 'electron.exe'))
  } else if (process.platform === 'darwin') {
    candidates.unshift(path.join(vendorRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  }
  var i
  for (i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i]
  }
  return null
}

function figmaEngineResolveLaunch () {
  var vendorRoot = figmaEngineVendorRoot()
  var entry = path.join(vendorRoot, 'dist', 'main', 'main.js')
  if (!fs.existsSync(entry)) {
    return {
      error: 'figma-linux-next engine is not built. In vendor/figma-linux-next run: bun install && bun run build'
    }
  }
  var electronBin = figmaEngineFindElectron(vendorRoot)
  if (!electronBin) {
    return { error: 'Electron not found. Install electron or bun install in vendor/figma-linux-next.' }
  }
  return { electron: electronBin, entry: entry, cwd: vendorRoot }
}

function figmaEngineRpc (method, params, timeoutMs) {
  var payload = JSON.stringify({ method: method, params: params || {} })
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: '127.0.0.1',
      port: FIGMA_ENGINE_CONTROL_PORT,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs || 8000
    }, function (res) {
      var chunks = []
      res.on('data', function (chunk) { chunks.push(chunk) })
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(JSON.parse(text))
        } catch (e) {
          reject(new Error('engine rpc invalid json'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', function () {
      req.destroy()
      reject(new Error('engine rpc timeout'))
    })
    req.write(payload)
    req.end()
  })
}

function figmaEngineGetStatus (timeoutMs) {
  return new Promise(function (resolve, reject) {
    var req = http.get({
      host: '127.0.0.1',
      port: FIGMA_ENGINE_CONTROL_PORT,
      path: '/status',
      timeout: timeoutMs || 3000
    }, function (res) {
      var chunks = []
      res.on('data', function (chunk) { chunks.push(chunk) })
      res.on('end', function () {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(new Error('engine status invalid json'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', function () {
      req.destroy()
      reject(new Error('engine status timeout'))
    })
  })
}

function figmaEngineSleep (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function figmaEngineKill (child, signal) {
  if (!child || child.exitCode != null || child.signalCode) return
  if (process.platform === 'win32' && child.pid) {
    childProcess.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], function () {})
    return
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      // The engine is spawned in its own process group so Electron's GPU and
      // renderer processes do not survive when Min exits.
      process.kill(-child.pid, signal)
      return
    } catch (e) {}
  }
  try {
    child.kill(signal)
  } catch (e) {}
}

async function figmaEngineWaitReady (timeoutMs) {
  var deadline = Date.now() + (timeoutMs || FIGMA_ENGINE_READY_MS)
  var lastError = null
  while (Date.now() < deadline) {
    try {
      var status = await figmaEngineGetStatus(1500)
      if (status && status.ok) return status
    } catch (err) {
      lastError = err
    }
    await figmaEngineSleep(400)
  }
  throw lastError || new Error('figma engine did not become ready')
}

async function figmaEngineWaitFile (parsed, timeoutMs) {
  // Wait until the engine's tab has finished loading the requested file. The
  // The desktop handler must be installed as well as the document loaded.
  // Keep both stable briefly while the Figma SPA finishes its startup.
  var deadline = Date.now() + (timeoutMs || FIGMA_ENGINE_FILE_WAIT_MS)
  var lastError = null
  var lastStatus = null
  var stableFileKey = null
  var stableSince = 0
  while (Date.now() < deadline) {
    try {
      // The home tab can finish its initial login redirect after openUrl.
      // Keep the requested file active inside the hidden engine while it loads.
      await figmaEngineRpc('ensureRuntime', { fileKey: parsed.fileKey }, 1500)
      var status = await figmaEngineGetStatus(1500)
      lastStatus = status
      if (status && status.ok && !status.loading && status.runtimeReady === true) {
        var currentFileKey = status.currentFileKey || figmaParseUrl(status.currentUrl || '').fileKey || null
        if (currentFileKey === parsed.fileKey) {
          if (stableFileKey !== currentFileKey) {
            stableFileKey = currentFileKey
            stableSince = Date.now()
          }
          if (Date.now() - stableSince >= FIGMA_ENGINE_FILE_STABLE_MS) {
            return status
          }
        } else {
          stableFileKey = null
          stableSince = 0
        }
      } else {
        stableFileKey = null
        stableSince = 0
      }
    } catch (err) {
      lastError = err
      stableFileKey = null
      stableSince = 0
    }
    await figmaEngineSleep(400)
  }
  if (lastError) throw lastError
  var current = lastStatus && lastStatus.currentFileKey
    ? lastStatus.currentFileKey
    : 'unknown'
  var loading = lastStatus && typeof lastStatus.loading === 'boolean'
    ? String(lastStatus.loading)
    : 'unknown'
  throw new Error(
    'figma engine did not finish loading the file' +
    ' (target=' + parsed.fileKey + ', current=' + current + ', loading=' + loading +
    ', runtimeReady=' + !!(lastStatus && lastStatus.runtimeReady) + ')'
  )
}

function figmaEngineCookiesFromTab (tabId) {
  var view = (typeof viewMap !== 'undefined') ? viewMap[tabId] : null
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    return Promise.resolve([])
  }
  // Figma's auth cookies are commonly host-scoped to `.www.figma.com`
  // (including the HttpOnly `figma.session` cookie). A domain filter for
  // `figma.com` can miss those cookies and leave the engine with an older
  // account/session, which Figma then renders as view-only.
  return view.webContents.session.cookies.get({ url: 'https://www.figma.com/' })
}

function figmaEngineSpawn () {
  if (figmaEngineChild && !figmaEngineChild.killed) {
    return Promise.resolve()
  }
  figmaEngineControlReady = false
  var launch = figmaEngineResolveLaunch()
  if (launch.error) return Promise.reject(new Error(launch.error))

  fs.mkdirSync(figmaEngineUserData(), { recursive: true })

  var env = Object.assign({}, process.env, {
    MIN_FIGMA_ENGINE: '1',
    MIN_FIGMA_PLUGIN: figmaEnginePluginPath(),
    MIN_FIGMA_CONTROL_PORT: String(FIGMA_ENGINE_CONTROL_PORT),
    MIN_FIGMA_USER_DATA: figmaEngineUserData(),
    MIN_FIGMA_PARENT_PID: String(process.pid)
  })
  delete env.ELECTRON_RUN_AS_NODE

  var child = childProcess.spawn(launch.electron, [launch.entry], {
    cwd: launch.cwd,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  child.stdout.on('data', function (buf) {
    console.log('[figma-engine]', String(buf).trim())
  })
  child.stderr.on('data', function (buf) {
    console.warn('[figma-engine]', String(buf).trim())
  })
  child.on('exit', function (code, signal) {
    console.warn('[figma-engine] exited', code, signal || '')
    if (figmaEngineChild === child) {
      figmaEngineChild = null
      figmaEngineControlReady = false
      figmaEngineWindowVisible = false
      var duringStart = !!figmaEngineStarting
      // A crashed engine must not leave the panel stuck on "Starting plugin…".
      // The context stays (the tab is still connected in spirit) but is marked
      // not-ready so the UI can offer a reconnect.
      if (figmaEngineContext) {
        figmaEngineContext.ready = false
        figmaEngineContext.syncing = false
        figmaEngineContext.pluginOk = false
        figmaEngineEmitPhase('error', {
          error: 'Figma engine exited (' + (signal || code) + ')'
        })
      } else if (duringStart) {
        // Engine died while being launched — report the failure instead of a
        // confusing "stopped".
        figmaEngineEmitPhase('error', {
          error: 'Figma engine failed to start (exited ' + (signal || code) + ')'
        })
      } else {
        figmaEngineEmitPhase('stopped', {})
      }
    }
  })
  figmaEngineChild = child
  return Promise.resolve()
}

function figmaEngineStopNow () {
  var child = figmaEngineChild
  figmaEngineChild = null
  figmaEngineControlReady = false
  figmaEngineContext = null
  figmaEngineWindowVisible = false
  if (!child || child.exitCode != null || child.signalCode) return
  figmaEngineKill(child, 'SIGKILL')
}

function figmaEngineStop () {
  figmaEngineControlReady = false
  figmaEngineContext = null
  figmaEngineWindowVisible = false
  figmaEngineEmitPhase('stopping', {})
  var child = figmaEngineChild
  figmaEngineChild = null
  if (!child || child.exitCode != null || child.signalCode) {
    figmaEngineEmitPhase('stopped', {})
    return Promise.resolve({ ok: true, running: false })
  }

  figmaEngineStopping = new Promise(function (resolve) {
    var finished = false
    var forceTimer = setTimeout(function () {
      figmaEngineKill(child, 'SIGKILL')
      setTimeout(finish, 250)
    }, 2000)
    function finish () {
      if (finished) return
      finished = true
      clearTimeout(forceTimer)
      if (figmaEngineStopping) figmaEngineStopping = null
      figmaEngineEmitPhase('stopped', {})
      resolve()
    }
    child.once('exit', finish)
    figmaEngineKill(child, 'SIGTERM')
  })
  return figmaEngineStopping
}

async function figmaEngineEnsureStarted () {
  if (figmaEngineChild && !figmaEngineChild.killed && figmaEngineControlReady) return Promise.resolve()
  if (figmaEngineStarting) return figmaEngineStarting
  figmaEngineStarting = (async function () {
    figmaEngineEmitPhase('loading-engine', {})
    if (figmaEngineStopping) await figmaEngineStopping
    await minFigmaBridge.start()
    if (!figmaEngineChild) {
      // A stale engine from a crashed Min session may still hold the control
      // port. A new spawn would die with EADDRINUSE and the panel would see a
      // fake "stopped". Clear the port owner before spawning.
      await figmaEngineClearStaleEngine()
    }
    await figmaEngineSpawn()
    var engine = await figmaEngineWaitReady()
    if (!engine.backgroundRuntime) {
      throw new Error('Rebuild the Figma engine with the background runtime patches (vendor/figma-linux-next: bun run build).')
    }
    figmaEngineControlReady = true
    if (!figmaEngineContext) figmaEngineEmitPhase('engine-ready', {})
  })().catch(function (err) {
    figmaEngineEmitPhase('error', { error: err.message || String(err) })
    throw err
  }).finally(function () {
    figmaEngineStarting = null
  })
  return figmaEngineStarting
}

function figmaEngineClearStaleEngine () {
  return new Promise(function (resolve) {
    var req = http.get({
      host: '127.0.0.1',
      port: FIGMA_ENGINE_CONTROL_PORT,
      path: '/status',
      timeout: 800
    }, function (res) {
      var chunks = []
      res.on('data', function (chunk) { chunks.push(chunk) })
      res.on('end', function () {
        // Only kill the port owner when the response is actually the figma
        // engine — an unrelated service squatting on the port must not be
        // SIGTERM'd. pluginMenuAgeMs is a Min-patch-specific status field.
        var isEngine = false
        try {
          var body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          isEngine = !!(body && body.ok === true && 'pluginMenuAgeMs' in body)
        } catch (e) {}
        if (isEngine) {
          figmaEngineKillPortOwner().then(resolve, resolve)
        } else {
          resolve()
        }
      })
      res.on('error', function () { resolve() })
    })
    req.on('error', function () {
      // Nothing on the port — no stale engine to clear.
      resolve()
    })
    req.on('timeout', function () {
      req.destroy()
      resolve()
    })
  })
}

function figmaEngineKillPortOwner () {
  return new Promise(function (resolve) {
    var cmd, args
    if (process.platform === 'win32') {
      cmd = 'netstat'
      args = ['-ano']
    } else {
      cmd = 'lsof'
      args = ['-ti', 'tcp:' + FIGMA_ENGINE_CONTROL_PORT]
    }
    childProcess.execFile(cmd, args, { timeout: 5000 }, function (err, stdout) {
      if (err || !stdout) {
        // No owner found (or lsof unavailable) — the spawn will fail loudly.
        resolve()
        return
      }
      var pids = String(stdout).trim().split(/\s+/)
      pids.forEach(function (pid) {
        if (!/^\d+$/.test(pid)) return
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch (e) {}
      })
      // Give the port a moment to free before the new engine spawns.
      setTimeout(resolve, 500)
    })
  })
}

async function figmaEngineWaitPlugin (fileKey, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || FIGMA_ENGINE_PLUGIN_WAIT_MS)
  var last = null
  var launched = false
  var engineOnTargetFile = async function () {
    try {
      var status = await figmaEngineGetStatus(1500)
      var currentFileKey = status && (status.currentFileKey || figmaParseUrl(status.currentUrl || '').fileKey)
      return currentFileKey === fileKey
    } catch (e) {
      return false
    }
  }
  var bridgeConnectedForFile = async function () {
    var bridge = minFigmaBridge.status()
    if (!bridge.pluginConnected) return false
    // A connection from a previous file must not satisfy the wait — the
    // plugin must report the target file after it has started.
    if (bridge.fileKey === fileKey) return true
    // Some plugin sandboxes cannot read figma.fileKey and stay anonymous.
    // Trust the engine's own current file, then pin the bridge to it so
    // downstream ready checks (which compare bridge.fileKey) also pass.
    if (bridge.fileKey == null && await engineOnTargetFile()) {
      minFigmaBridge.setFileKey(fileKey)
      return true
    }
    return false
  }
  try {
    var runtime = await figmaEngineRpc('ensureRuntime', { fileKey: fileKey })
    if (!runtime || !runtime.ok) {
      return { ok: false, error: (runtime && runtime.error) || 'Figma background runtime is not ready' }
    }

    // Reuse a live connection, but do not trust the engine's
    // global plugin-menu cache for a different file: it can still describe
    // the previous tab while the new tab is settling.
    if (await bridgeConnectedForFile()) {
      return { ok: true, alreadyConnected: true }
    }

    var attemptLaunch = async function () {
      try {
        last = await figmaEngineRpc('runPlugin', {
          name: FIGMA_ENGINE_PLUGIN_NAME,
          fileKey: fileKey
        })
        // A successful launch must not be retried — Figma allows only one
        // CppVm, and a second runPlugin kills the first with
        // "Cannot create two CppVm objects at the same time". A "menu item
        // not ready" failure keeps launched=false so the loop retries once
        // the file tab's panel has reported its plugin menu.
        launched = !!(last && last.ok)
      } catch (err) {
        last = { ok: false, error: err.message }
      }
    }

    while (Date.now() < deadline) {
      if (await bridgeConnectedForFile()) return { ok: true, alreadyConnected: true }
      // runPlugin acknowledges only after the editor has installed its
      // desktop message handler. Once accepted, wait for the bridge instead
      // of launching a second copy of the plugin.
      if (!launched) await attemptLaunch()
      await figmaEngineSleep(800)
    }
    if (await bridgeConnectedForFile()) return { ok: true, alreadyConnected: true }
    return {
      ok: false,
      error: last && last.error ? last.error : 'plugin did not connect'
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

function figmaEngineConnect (opts) {
  // Serialize connect pipelines: a second Connect click or the auto-resume
  // after login redeem must not race an in-flight connect — both mutate the
  // shared context/phase and would interleave engine RPCs.
  var previous = figmaEngineConnecting || Promise.resolve()
  var run = previous
    .catch(function () {})
    .then(function () { return figmaEngineConnectInner(opts) })
    .finally(function () {
      if (figmaEngineConnecting === run) figmaEngineConnecting = null
    })
  figmaEngineConnecting = run
  return run
}

async function figmaEngineConnectInner (opts) {
  opts = opts || {}
  var parsed = figmaParseUrl(opts.url)
  if (!parsed.isFigmaFile) {
    return { ok: false, error: 'Selected tab is not a Figma file' }
  }

  figmaEngineEmitPhase('starting', { url: parsed.url, fileKey: parsed.fileKey })
  await figmaEngineEnsureStarted()

  var cookies = []
  if (opts.tabId) {
    try {
      cookies = await figmaEngineCookiesFromTab(opts.tabId)
    } catch (e) {
      cookies = []
    }
  }
  if (cookies.length) {
    await figmaEngineRpc('setCookies', {
      cookies: cookies.map(function (cookie) {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite
        }
      })
    })
  }

  var sessionStatus = await figmaEngineRpc('hasSession')
  if (!sessionStatus || !sessionStatus.authed) {
    // Authenticate in the Min tab and copy its session on the next connect.
    figmaEngineContext = {
      tabId: opts.tabId != null ? String(opts.tabId) : null,
      url: parsed.url,
      fileKey: parsed.fileKey,
      nodeId: parsed.nodeId,
      workspaceId: opts.workspaceId || null,
      workspacePath: opts.workspacePath || null,
      needsLogin: true,
      ready: false,
      syncing: false,
      pluginOk: false
    }
    figmaEngineEmitPhase('login-needed', { error: 'Engine needs login' })
    return {
      ok: false,
      needsLogin: true,
      error: 'Sign in to Figma in the Min tab, then Connect again.',
      context: figmaEngineContext
    }
  }

  figmaEngineEmitPhase('opening-tab', { fileKey: parsed.fileKey })
  await figmaEngineRpc('openUrl', { url: parsed.url })
  try {
    var engineStatus = await figmaEngineGetStatus()
    if (engineStatus && typeof engineStatus.windowVisible === 'boolean') {
      figmaEngineWindowVisible = engineStatus.windowVisible
    }
  } catch (e) {}
  figmaEngineContext = {
    tabId: opts.tabId != null ? String(opts.tabId) : null,
    url: parsed.url,
    fileKey: parsed.fileKey,
    nodeId: parsed.nodeId,
    workspaceId: opts.workspaceId || null,
    workspacePath: opts.workspacePath || null,
    needsLogin: false,
    ready: false,
    syncing: true
  }
  figmaEngineEmitPhase('loading-tab', { fileKey: parsed.fileKey })
  await figmaEngineWaitFile(parsed)
  figmaEngineEmitPhase('loading-plugin', { fileKey: parsed.fileKey })
  var plugin = await figmaEngineWaitPlugin(parsed.fileKey)

  if (opts.workspacePath) {
    // A saved export preference for this workspace overrides its default.
    var savedExportDir = figmaEngineGetExportPrefs(opts.workspacePath).saved
    minFigmaBridge.setExportDir(savedExportDir || path.join(opts.workspacePath, '.min', 'design', 'exports'))
  } else {
    minFigmaBridge.setExportDir(null)
  }

  var pluginReady = !!(plugin && plugin.ok && figmaEnginePluginReady(parsed.fileKey))
  figmaEngineContext = Object.assign({}, figmaEngineContext, {
    needsLogin: false,
    ready: pluginReady,
    syncing: false,
    pluginOk: pluginReady
  })
  if (pluginReady) {
    figmaEngineEmitPhase('connected', { fileKey: parsed.fileKey })
  } else {
    figmaEngineEmitPhase('error', { error: plugin && plugin.error ? plugin.error : 'plugin did not connect' })
  }

  return {
    ok: pluginReady,
    pluginStarted: pluginReady,
    pluginConnected: minFigmaBridge.status().pluginConnected,
    error: pluginReady ? undefined : ((plugin && plugin.error) || 'plugin did not connect'),
    context: figmaEngineContext,
    engine: await figmaEngineGetStatus().catch(function () { return null }),
    bridge: minFigmaBridge.status()
  }
}

function figmaEngineDisconnect (opts) {
  opts = opts || {}
  if (opts.tabId != null && figmaEngineContext && String(figmaEngineContext.tabId) !== String(opts.tabId)) {
    return { ok: false, ignored: true }
  }
  figmaEngineContext = null
  minFigmaBridge.setExportDir(null)
  figmaEngineEmitPhase(figmaEngineChild && !figmaEngineChild.killed ? 'engine-ready' : 'stopped', {})
  return { ok: true }
}

function figmaEnginePluginReady (fileKey) {
  var bridge = minFigmaBridge.status()
  return !!(bridge.pluginConnected && bridge.fileKey === fileKey)
}

function figmaEnginePublicStatus () {
  var parsed = figmaEngineContext ? figmaParseUrl(figmaEngineContext.url) : null
  var processRunning = !!(figmaEngineChild && !figmaEngineChild.killed)
  var running = !!(processRunning && figmaEngineControlReady)
  var bridge = minFigmaBridge.status()
  var phase = figmaEnginePhase
  if (phase === 'connected' && figmaEngineContext &&
      !figmaEnginePluginReady(figmaEngineContext.fileKey)) {
    phase = 'plugin-disconnected'
  }
  return {
    running: running,
    processRunning: processRunning,
    ready: running,
    loading: processRunning && !running,
    phase: phase,
    phaseError: figmaEnginePhaseError,
    windowVisible: !!(processRunning && figmaEngineWindowVisible),
    context: figmaEngineContext,
    fileKey: parsed && parsed.fileKey,
    nodeId: figmaEngineContext && figmaEngineContext.nodeId,
    engineLaunch: figmaEngineResolveLaunch().error || null,
    bridge: bridge
  }
}

async function figmaEngineSetVisible (visible) {
  if (!visible) {
    if (!figmaEngineChild) {
      figmaEngineWindowVisible = false
      return Object.assign({ ok: true }, figmaEnginePublicStatus())
    }
    var hidden = await figmaEngineRpc('hide')
    figmaEngineWindowVisible = false
    return Object.assign({ ok: true }, hidden, figmaEnginePublicStatus())
  }
  await figmaEngineEnsureStarted()
  var shown = await figmaEngineRpc('show')
  figmaEngineWindowVisible = true
  return Object.assign({ ok: true }, shown, figmaEnginePublicStatus())
}

function figmaEngineExportPrefsKey (workspacePath) {
  // Preferences are scoped per workspace — the same folder is not forced on
  // every project. Tabs without a workspace share the "default" scope.
  return workspacePath || 'default'
}

function figmaEngineGetExportPrefs (workspacePath) {
  var dirs = settings.get('figmaExportDirs') || {}
  var saved = dirs[figmaEngineExportPrefsKey(workspacePath)] || null
  var workspace = workspacePath
    ? path.join(workspacePath, '.min', 'design', 'exports')
    : null
  return {
    scope: figmaEngineExportPrefsKey(workspacePath),
    saved: saved,
    workspace: workspace,
    effective: saved || workspace || null,
    fallback: path.join(app.getPath('userData'), 'figma-exports')
  }
}

function figmaEngineSetExportDir (workspacePath, dir) {
  var dirs = settings.get('figmaExportDirs') || {}
  var key = figmaEngineExportPrefsKey(workspacePath)
  var target = dir || null
  if (target) {
    dirs[key] = target
    settings.set('figmaExportDirs', dirs)
    minFigmaBridge.setExportDir(target)
  } else {
    delete dirs[key]
    settings.set('figmaExportDirs', dirs)
    minFigmaBridge.setExportDir(figmaEngineContext && figmaEngineContext.workspacePath
      ? path.join(figmaEngineContext.workspacePath, '.min', 'design', 'exports')
      : null)
  }
  return { ok: true, prefs: figmaEngineGetExportPrefs(workspacePath) }
}

function figmaEngineSyncTabUrl (tabId, url) {
  var parsed = figmaParseUrl(url)
  if (!figmaEngineContext || tabId == null) {
    return { ok: false, ignored: true, parsed: parsed }
  }
  if (String(figmaEngineContext.tabId) !== String(tabId)) {
    return { ok: false, ignored: true, parsed: parsed }
  }
  if (!parsed.isFigmaFile) {
    // Navigating away from Figma: keep the old context (the engine still has
    // the last file open) but mark it not-ready so the panel does not claim
    // "Connected" for a tab that is no longer a Figma file.
    figmaEngineContext.syncing = true
    figmaEngineContext.ready = false
    figmaEngineEmitPhase('loading-tab', { fileKey: figmaEngineContext.fileKey })
    return { ok: true, parsed: parsed }
  }
  var prevFile = figmaEngineContext.fileKey
  var newFile = parsed.fileKey && parsed.fileKey !== prevFile
  figmaEngineContext.url = url
  figmaEngineContext.nodeId = parsed.nodeId || figmaEngineContext.nodeId
  if (newFile) {
    figmaEngineContext.fileKey = parsed.fileKey
    figmaEngineContext.syncing = true
    figmaEngineContext.ready = false
    figmaEngineContext.pluginOk = false
    figmaEngineEmitPhase('opening-tab', { fileKey: parsed.fileKey })
    figmaEngineSyncEngineFile(parsed)
  } else {
    if (figmaEnginePluginReady(figmaEngineContext.fileKey)) {
      figmaEngineContext.syncing = false
      figmaEngineContext.ready = true
      figmaEngineContext.pluginOk = true
      figmaEngineEmitPhase('connected', { fileKey: figmaEngineContext.fileKey })
    } else {
      figmaEngineContext.syncing = true
      figmaEngineContext.ready = false
      figmaEngineContext.pluginOk = false
      figmaEngineEmitPhase('loading-plugin', { fileKey: figmaEngineContext.fileKey })
      figmaEngineWaitPlugin(figmaEngineContext.fileKey).then(function (plugin) {
        if (!figmaEngineContext || !figmaEnginePluginReady(figmaEngineContext.fileKey)) return
        figmaEngineContext.syncing = false
        figmaEngineContext.ready = !!(plugin && plugin.ok)
        figmaEngineContext.pluginOk = figmaEngineContext.ready
        if (figmaEngineContext.ready) figmaEngineEmitPhase('connected', { fileKey: figmaEngineContext.fileKey })
      })
    }
  }
  return { ok: true, parsed: parsed }
}

function figmaEngineSyncEngineFile (parsed) {
  var tabId = figmaEngineContext && figmaEngineContext.tabId
  figmaEngineRpc('openUrl', { url: parsed.url }).catch(function () {})
  figmaEngineEmitPhase('loading-tab', { fileKey: parsed.fileKey })
  figmaEngineWaitFile(parsed).then(function () {
    if (!figmaEngineContext ||
        String(figmaEngineContext.tabId) !== String(tabId) ||
        figmaEngineContext.fileKey !== parsed.fileKey ||
        figmaEngineContext.syncing === false) {
      return
    }
    figmaEngineEmitPhase('loading-plugin', { fileKey: parsed.fileKey })
    return figmaEngineWaitPlugin(parsed.fileKey).then(function (plugin) {
      if (!figmaEngineContext ||
          String(figmaEngineContext.tabId) !== String(tabId) ||
          figmaEngineContext.fileKey !== parsed.fileKey ||
          figmaEngineContext.syncing === false) {
        return
      }
      if (plugin && plugin.ok && minFigmaBridge.status().fileKey === parsed.fileKey) {
        figmaEngineContext.syncing = false
        figmaEngineContext.ready = true
        figmaEngineContext.pluginOk = true
        figmaEngineEmitPhase('connected', { fileKey: parsed.fileKey })
      } else {
        figmaEngineContext.syncing = false
        figmaEngineContext.ready = false
        figmaEngineContext.pluginOk = false
        figmaEngineEmitPhase('error', {
          error: plugin && plugin.error ? plugin.error : 'plugin did not connect'
        })
      }
    })
  }).catch(function (err) {
    if (!figmaEngineContext ||
        String(figmaEngineContext.tabId) !== String(tabId) ||
        figmaEngineContext.fileKey !== parsed.fileKey) {
      return
    }
    figmaEngineContext.syncing = false
    figmaEngineContext.ready = false
    figmaEngineContext.pluginOk = false
    figmaEngineEmitPhase('error', {
      error: err && err.message ? err.message : String(err)
    })
  })
}

function figmaEngineViewUrl (tabId) {
  var view = viewMap[tabId]
  if (!view || !view.webContents || view.webContents.isDestroyed()) return ''
  return view.webContents.getURL() || ''
}

function figmaEngineFindFigmaTab () {
  var win = windows.getCurrent()
  var selectedId = win ? (windows.getState(win).selectedView || null) : null
  if (selectedId && typeof selectedId !== 'string') {
    selectedId = Object.keys(viewMap).find(function (id) {
      return viewMap[id] === selectedId
    }) || null
  }
  if (selectedId) {
    var selectedUrl = figmaEngineViewUrl(selectedId)
    if (figmaParseUrl(selectedUrl).isFigmaFile) {
      return { tabId: selectedId, url: selectedUrl }
    }
  }
  var id
  for (id in viewMap) {
    var url = figmaEngineViewUrl(id)
    if (figmaParseUrl(url).isFigmaFile) return { tabId: id, url: url }
  }
  return null
}

async function figmaEngineGetWorkspace () {
  try {
    var win = windows.getCurrent()
    if (!win) return {}
    var result = await getWindowWebContents(win).executeJavaScript('(function () {\n' +
      '  var ws = (typeof tasks !== "undefined" && tasks.getSelected) ? tasks.getSelected() : null\n' +
      '  return { workspaceId: ws && ws.id, workspacePath: ws && ws.path }\n' +
      '})()')
    return result || {}
  } catch (e) {
    return {}
  }
}

async function figmaEngineConnectActive () {
  var found = figmaEngineFindFigmaTab()
  if (!found) {
    return { ok: false, error: 'Open a Figma file in a tab first' }
  }
  var ws = await figmaEngineGetWorkspace()
  return figmaEngineConnect({
    tabId: found.tabId,
    url: found.url,
    workspaceId: ws.workspaceId,
    workspacePath: ws.workspacePath
  })
}

function figmaEngineRedeemAuth (url) {
  return figmaEngineRpc('redeemAuth', { url: url }).then(async function (result) {
    if (!result || !result.ok) return result
    if (!figmaEngineContext) return result
    figmaEngineContext.needsLogin = false
    // Auto-resume the connection for the same tab instead of asking the user
    // to press Connect again. Only resume if the tab is still a Figma file.
    var ctx = figmaEngineContext
    var tab = (typeof viewMap !== 'undefined') ? viewMap[ctx.tabId] : null
    var currentUrl = tab && tab.webContents && !tab.webContents.isDestroyed()
      ? tab.webContents.getURL() || ''
      : ''
    var parsed = figmaParseUrl(currentUrl || ctx.url)
    if (!parsed.isFigmaFile) {
      figmaEngineEmitPhase('login-needed', { error: 'Login complete — open a Figma file to connect' })
      return result
    }
    try {
      var resumed = await figmaEngineConnect({
        tabId: ctx.tabId,
        url: parsed.url,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath
      })
      if (resumed && resumed.ok && resumed.context && resumed.context.ready) {
        figmaEngineEmitPhase('connected', { fileKey: parsed.fileKey })
      }
    } catch (err) {
      figmaEngineEmitPhase('error', { error: err && err.message ? err.message : String(err) })
    }
    return result
  }).catch(function (err) {
    return { ok: false, error: err.message || String(err) }
  })
}

ipc.handle('figmaEngine:status', async function (e) {
  if (e && e.sender && !e.sender.isDestroyed() && !figmaEngineSenders.has(e.sender)) {
    var sender = e.sender
    figmaEngineSenders.add(sender)
    sender.once('destroyed', function () {
      figmaEngineSenders.delete(sender)
    })
  }
  if (figmaEngineChild && !figmaEngineChild.killed) {
    try {
      var engine = await figmaEngineGetStatus(800)
      if (engine && typeof engine.windowVisible === 'boolean') {
        figmaEngineWindowVisible = engine.windowVisible
      }
    } catch (err) {}
  }
  return figmaEnginePublicStatus()
})

ipc.handle('figmaEngine:connect', async function (e, opts) {
  try {
    return await figmaEngineConnect(opts || {})
  } catch (err) {
    var message = err.message || String(err)
    if (figmaEngineContext) {
      figmaEngineContext = Object.assign({}, figmaEngineContext, {
        ready: false,
        syncing: false,
        pluginOk: false
      })
    }
    figmaEngineEmitPhase('error', { error: message })
    return { ok: false, error: message, context: figmaEngineContext }
  }
})

ipc.handle('figmaEngine:connectActive', async function () {
  try {
    return await figmaEngineConnectActive()
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipc.handle('figmaEngine:disconnect', function (e, opts) {
  return figmaEngineDisconnect(opts || {})
})

ipc.handle('figmaEngine:start', async function () {
  try {
    await figmaEngineEnsureStarted()
    return Object.assign({ ok: true }, figmaEnginePublicStatus())
  } catch (err) {
    return Object.assign({ ok: false, error: err.message || String(err) }, figmaEnginePublicStatus())
  }
})

ipc.handle('figmaEngine:stop', async function () {
  await figmaEngineStop()
  return Object.assign({ ok: true }, figmaEnginePublicStatus())
})

ipc.handle('figmaEngine:setVisible', async function (e, opts) {
  try {
    return await figmaEngineSetVisible(!!(opts && opts.visible))
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipc.handle('figmaEngine:revealLogin', async function () {
  try {
    return await figmaEngineSetVisible(true)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipc.handle('figmaEngine:hide', async function () {
  try {
    return await figmaEngineSetVisible(false)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipc.handle('figmaEngine:syncUrl', function (e, payload) {
  var tabId = payload && typeof payload === 'object' ? payload.tabId : null
  var url = payload && typeof payload === 'object' ? payload.url : payload
  return figmaEngineSyncTabUrl(tabId, url)
})

ipc.handle('figmaEngine:parseUrl', function (e, url) {
  return figmaParseUrl(url)
})

ipc.handle('figmaEngine:getExportPrefs', function (e, opts) {
  return figmaEngineGetExportPrefs(opts && opts.workspacePath)
})

ipc.handle('figmaEngine:setExportDir', function (e, opts) {
  return figmaEngineSetExportDir(opts && opts.workspacePath, opts && opts.dir)
})

app.on('before-quit', function () {
  figmaEngineStopNow()
})
app.on('will-quit', function () {
  figmaEngineStopNow()
})
process.on('exit', function () {
  figmaEngineStopNow()
})

var minFigmaEngine = {
  parseUrl: figmaParseUrl,
  status: figmaEnginePublicStatus,
  connect: figmaEngineConnect,
  disconnect: figmaEngineDisconnect,
  redeemAuth: figmaEngineRedeemAuth,
  context: function () { return figmaEngineContext },
  getExportPrefs: figmaEngineGetExportPrefs,
  setExportDir: figmaEngineSetExportDir
}
global.minFigmaEngine = minFigmaEngine
