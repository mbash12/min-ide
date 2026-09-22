/* Loopback HTTP bridge for the Min Figma plugin. Plugin API calls run inside
figma-linux-next, so export/text/style never touch the rate-limited REST API. */
/* global fs, path, ipc, app, windows, sendIPCToWindow */

var FIGMA_BRIDGE_PORT = 44178
var FIGMA_BRIDGE_TOKEN = 'min-figma-bridge-local'
var FIGMA_BRIDGE_HEADER = 'x-min-figma-bridge'
var FIGMA_BRIDGE_BOOT_HEADER = 'x-min-figma-boot'
var FIGMA_BRIDGE_COMMAND_TIMEOUT_MS = 60000

var figmaBridgeHttp = require('http')

var figmaBridgeServer = null
var figmaBridgeStarting = null
var figmaBridgeLastSeen = 0
var figmaBridgeFileKey = null
var figmaBridgeSelection = null
var figmaBridgeQueue = []
var figmaBridgePending = new Map()
var figmaBridgeReqId = 0
var figmaBridgeExportDir = null
var figmaBridgeBootId = null
var figmaBridgeTransport = null // 'ws' | 'poll' | 'none' — last seen transport
var figmaBridgeWs = null
var figmaBridgeWss = null
var figmaBridgeSockets = new Map() // fileKey ('' when unknown) → ws
var figmaBridgePingTimer = null

function figmaBridgeNow () {
  return Date.now()
}

function figmaBridgePluginConnected () {
  // A live socket counts on its own — the HTTP poll pauses while it is open,
  // so lastSeen would otherwise go stale and flap the indicator.
  return figmaBridgeSockets.size > 0 || figmaBridgeNow() - figmaBridgeLastSeen < 4000
}

function figmaBridgeReadBody (req) {
  return new Promise(function (resolve, reject) {
    var chunks = []
    req.on('data', function (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function figmaBridgeRespond (res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Min-Figma-Bridge, X-Min-Figma-Boot'
  })
  res.end(JSON.stringify(body))
}

function figmaBridgeAuthorized (req) {
  var token = req.headers[FIGMA_BRIDGE_HEADER]
  if (token === FIGMA_BRIDGE_TOKEN) return true
  try {
    var url = new URL(req.url || '/', 'http://127.0.0.1')
    return url.searchParams.get('token') === FIGMA_BRIDGE_TOKEN
  } catch (e) {
    return false
  }
}

function figmaBridgeSafeName (name) {
  return String(name || 'node').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'node'
}

function figmaBridgeWriteExport (payload) {
  // Per-command exportDir wins; otherwise the connected workspace's dir;
  // otherwise the userData fallback.
  var dir = payload.exportDir || figmaBridgeExportDir
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'figma-exports')
  }
  fs.mkdirSync(dir, { recursive: true })
  var format = String(payload.format || 'PNG').toLowerCase()
  var ext = format === 'svg' ? 'svg' : format === 'jpg' ? 'jpg' : 'png'
  var base = figmaBridgeSafeName(payload.fileName || (payload.node && payload.node.name) || payload.nodeId)
  var filePath = path.join(dir, base + '-' + Date.now() + '.' + ext)
  var b64 = payload.dataBase64 || payload.pngBase64
  if (!b64) throw new Error('export payload missing data')
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'))
  return filePath
}

function figmaBridgeFinish (id, result) {
  var pending = figmaBridgePending.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  figmaBridgePending.delete(id)
  pending.resolve(result)
}

function figmaBridgeHandleResult (body) {
  if (!body || body.id == null) return
  figmaBridgeFinish(String(body.id), body)
}

function figmaBridgeRejectAll (reason) {
  // A reloaded plugin will never answer commands queued for its previous
  // incarnation — fail them fast instead of letting callers hang 60s.
  figmaBridgeQueue.length = 0
  figmaBridgePending.forEach(function (pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  })
  figmaBridgePending.clear()
}

function figmaBridgeNoteBoot (boot) {
  if (!boot || boot === figmaBridgeBootId) return
  var hadState = figmaBridgeBootId && (figmaBridgeQueue.length || figmaBridgePending.size)
  figmaBridgeBootId = boot
  if (hadState) figmaBridgeRejectAll('Figma plugin reloaded — command dropped')
}

async function figmaBridgeHandleRequest (req, res) {
  if (req.method === 'OPTIONS') {
    figmaBridgeRespond(res, 204, {})
    return
  }
  if (!figmaBridgeAuthorized(req)) {
    figmaBridgeRespond(res, 401, { ok: false, error: 'Unauthorized' })
    return
  }
  var url = new URL(req.url || '/', 'http://127.0.0.1')
  var pathname = url.pathname
  figmaBridgeNoteBoot(req.headers[FIGMA_BRIDGE_BOOT_HEADER])

  if (pathname === '/ping') {
    figmaBridgeLastSeen = figmaBridgeNow()
    figmaBridgeRespond(res, 200, { ok: true, app: 'min' })
    return
  }

  if (pathname === '/selection' && req.method === 'POST') {
    var selection = JSON.parse(await figmaBridgeReadBody(req) || '{}')
    figmaBridgeLastSeen = figmaBridgeNow()
    if (selection.transport) figmaBridgeTransport = selection.transport
    var reportedFileKey = typeof selection.fileKey === 'string' && selection.fileKey
      ? selection.fileKey
      : null
    if (reportedFileKey) figmaBridgeSetFileKey(reportedFileKey)
    figmaBridgeSelection = Object.assign({}, selection, {
      // Some Figma plugin sandboxes cannot expose figma.fileKey. Keep the
      // engine-pinned key on the selection so the sidebar can scope it.
      fileKey: reportedFileKey || figmaBridgeFileKey
    })
    figmaBridgeRespond(res, 200, { ok: true })
    return
  }

  if (pathname === '/command/poll') {
    figmaBridgeLastSeen = figmaBridgeNow()
    var fileKey = url.searchParams.get('fileKey')
    if (fileKey) figmaBridgeFileKey = fileKey
    var pollTransport = url.searchParams.get('transport')
    if (pollTransport) figmaBridgeTransport = pollTransport
    var command = figmaBridgeQueue.shift() || null
    figmaBridgeRespond(res, 200, { ok: true, command: command })
    return
  }

  if (pathname === '/status' && req.method === 'GET') {
    figmaBridgeRespond(res, 200, figmaBridgeStatus())
    return
  }

  if (pathname === '/command/result' && req.method === 'POST') {
    var resultBody = JSON.parse(await figmaBridgeReadBody(req) || '{}')
    figmaBridgeLastSeen = figmaBridgeNow()
    if (resultBody.transport) figmaBridgeTransport = resultBody.transport
    figmaBridgeHandleResult(resultBody)
    figmaBridgeRespond(res, 200, { ok: true })
    return
  }

  if (pathname === '/export' && req.method === 'POST') {
    var exportBody = JSON.parse(await figmaBridgeReadBody(req) || '{}')
    figmaBridgeLastSeen = figmaBridgeNow()
    if (exportBody.transport) figmaBridgeTransport = exportBody.transport
    try {
      var savedPath = figmaBridgeWriteExport(exportBody)
      if (exportBody.id != null) {
        figmaBridgeFinish(String(exportBody.id), {
          ok: true,
          id: exportBody.id,
          payload: { path: savedPath, node: exportBody.node }
        })
      }
      figmaBridgeRespond(res, 200, { ok: true, message: savedPath, path: savedPath })
    } catch (err) {
      figmaBridgeRespond(res, 400, { ok: false, message: err.message })
    }
    return
  }

  if (pathname === '/auth/open' && req.method === 'POST') {
    var grantBody = JSON.parse(await figmaBridgeReadBody(req) || '{}')
    var grantUrl = String(grantBody.url || '')
    if (!/^https:\/\/([\w.-]+\.)?figma\.com\/app_auth\//i.test(grantUrl)) {
      figmaBridgeRespond(res, 400, { ok: false, error: 'invalid grant url' })
      return
    }
    var win = windows.getCurrent()
    if (!win) {
      figmaBridgeRespond(res, 503, { ok: false, error: 'Min window is not available' })
      return
    }
    sendIPCToWindow(win, 'addTab', { url: grantUrl })
    figmaBridgeRespond(res, 200, { ok: true })
    return
  }

  figmaBridgeRespond(res, 404, { ok: false, error: 'Unknown endpoint' })
}

/* The plugin UI iframe owns a real WebSocket client; this side accepts it on
/ws. An open socket carries commands instantly (no 500ms poll hop) and results
come back over the same socket; HTTP polling stays as the fallback. */
function figmaBridgeWsAttach (server) {
  if (!figmaBridgeWs) {
    try {
      figmaBridgeWs = require('ws')
    } catch (e) {
      figmaBridgeWs = null
      return
    }
  }
  figmaBridgeWss = new figmaBridgeWs.WebSocketServer({ noServer: true })
  figmaBridgeWss.on('connection', function (ws, req) {
    var fileKey = ''
    try {
      fileKey = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('fileKey') || ''
    } catch (e) {}
    ws.isAlive = true
    figmaBridgeSockets.set(fileKey, ws)
    figmaBridgeTransport = 'ws'
    figmaBridgeLastSeen = figmaBridgeNow()
    ws.on('pong', function () {
      ws.isAlive = true
      figmaBridgeLastSeen = figmaBridgeNow()
    })
    ws.on('message', function (data) {
      figmaBridgeLastSeen = figmaBridgeNow()
      var msg
      try {
        msg = JSON.parse(data.toString())
      } catch (e) {
        return
      }
      if (msg && msg.type === 'result' && msg.id != null) figmaBridgeHandleResult(msg)
    })
    ws.on('close', function () {
      if (figmaBridgeSockets.get(fileKey) === ws) figmaBridgeSockets.delete(fileKey)
      if (!figmaBridgeSockets.size) figmaBridgeTransport = null
      // Commands dispatched over this socket will never reply now.
      figmaBridgePending.forEach(function (pending, id) {
        if (pending.ws !== ws) return
        clearTimeout(pending.timer)
        figmaBridgePending.delete(id)
        pending.reject(new Error('Figma socket closed mid-command — reconnect'))
      })
    })
    ws.on('error', function () {
      try { ws.close() } catch (e) {}
    })
  })
  server.on('upgrade', function (req, socket, head) {
    var pathname = ''
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    } catch (e) {}
    if (pathname !== '/ws' || !figmaBridgeAuthorized(req)) {
      socket.destroy()
      return
    }
    figmaBridgeWss.handleUpgrade(req, socket, head, function (ws) {
      figmaBridgeWss.emit('connection', ws, req)
    })
  })
  // Detect half-dead sockets and keep lastSeen fresh while a socket is open —
  // the HTTP poll that normally heartbeats is paused in that state.
  figmaBridgePingTimer = setInterval(function () {
    figmaBridgeSockets.forEach(function (ws) {
      if (!ws.isAlive) {
        try { ws.terminate() } catch (e) {}
        return
      }
      ws.isAlive = false
      try { ws.ping() } catch (e) {}
    })
  }, 3000)
  if (figmaBridgePingTimer.unref) figmaBridgePingTimer.unref()
}

function figmaBridgeWsSend (command) {
  var target = null
  if (command.fileKey && figmaBridgeSockets.get(command.fileKey)) {
    target = figmaBridgeSockets.get(command.fileKey)
  } else if (figmaBridgeSockets.size === 1) {
    target = figmaBridgeSockets.values().next().value
  }
  if (!target || target.readyState !== 1) return null
  try {
    target.send(JSON.stringify(Object.assign({ type: 'command' }, command)))
    figmaBridgeLastSeen = figmaBridgeNow()
    return target
  } catch (e) {
    return null
  }
}

function figmaBridgeStart () {
  if (figmaBridgeServer) return Promise.resolve()
  if (figmaBridgeStarting) return figmaBridgeStarting
  figmaBridgeStarting = new Promise(function (resolve, reject) {
    var server = figmaBridgeHttp.createServer(function (req, res) {
      var host = req.socket.remoteAddress || ''
      if (host !== '127.0.0.1' && host !== '::1' && host !== '::ffff:127.0.0.1') {
        figmaBridgeRespond(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      figmaBridgeHandleRequest(req, res).catch(function (err) {
        figmaBridgeRespond(res, 500, { ok: false, error: err.message || String(err) })
      })
    })
    server.once('error', reject)
    figmaBridgeWsAttach(server)
    server.listen(FIGMA_BRIDGE_PORT, '127.0.0.1', function () {
      figmaBridgeServer = server
      resolve()
    })
  }).finally(function () {
    figmaBridgeStarting = null
  })
  return figmaBridgeStarting
}

function figmaBridgeStop () {
  if (figmaBridgePingTimer) {
    clearInterval(figmaBridgePingTimer)
    figmaBridgePingTimer = null
  }
  figmaBridgeSockets.forEach(function (ws) {
    try { ws.terminate() } catch (e) {}
  })
  figmaBridgeSockets.clear()
  figmaBridgeTransport = null
  if (figmaBridgeWss) {
    try { figmaBridgeWss.close() } catch (e) {}
    figmaBridgeWss = null
  }
  if (!figmaBridgeServer) return
  try { figmaBridgeServer.close() } catch (e) {}
  figmaBridgeServer = null
}

function figmaBridgeSetExportDir (dir) {
  figmaBridgeExportDir = dir || null
}

function figmaBridgeSetFileKey (key) {
  // Used when the plugin sandbox cannot report figma.fileKey itself: the
  // engine confirmed which file is open, so pin the bridge to it.
  var next = key || null
  if (figmaBridgeFileKey !== next) figmaBridgeSelection = null
  figmaBridgeFileKey = next
}

function figmaBridgeStatus () {
  return {
    listening: !!figmaBridgeServer,
    pluginConnected: figmaBridgePluginConnected(),
    fileKey: figmaBridgeFileKey,
    bootId: figmaBridgeBootId,
    lastSeen: figmaBridgeLastSeen || null,
    lastSeenAgoMs: figmaBridgeLastSeen ? figmaBridgeNow() - figmaBridgeLastSeen : null,
    transport: figmaBridgeTransport,
    queueDepth: figmaBridgeQueue.length,
    pendingCommands: figmaBridgePending.size,
    selection: figmaBridgeSelection
      ? Object.assign({}, figmaBridgeSelection, {
        fileKey: figmaBridgeSelection.fileKey || figmaBridgeFileKey
      })
      : null
  }
}

function figmaBridgeCommand (action, params) {
  params = params || {}
  return figmaBridgeStart().then(function () {
    var id = 'min-figma-' + (++figmaBridgeReqId) + '-' + figmaBridgeNow()
    var command = Object.assign({
      id: id,
      action: action,
      protocolVersion: 2,
      jobId: id,
      runId: id,
      projectId: 'min'
    }, params)
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        figmaBridgePending.delete(id)
        // Diagnose which side stalled: commands still in the queue mean the
        // plugin never polled (transport dead); an empty queue means it took
        // the command and never replied (hang inside Figma).
        var ago = figmaBridgeLastSeen ? (figmaBridgeNow() - figmaBridgeLastSeen) + 'ms ago' : 'never'
        reject(new Error(
          'Figma plugin timed out waiting for ' + action +
          ' — queue ' + figmaBridgeQueue.length +
          ', lastSeen ' + ago +
          ', transport ' + (figmaBridgeTransport || 'unknown') +
          (figmaBridgeQueue.length ? ' (plugin is not picking up commands — reconnect)' : '')
        ))
      }, FIGMA_BRIDGE_COMMAND_TIMEOUT_MS)
      var pending = { resolve: resolve, reject: reject, timer: timer, ws: null }
      figmaBridgePending.set(id, pending)
      // A live socket skips the queue entirely — the plugin gets the command
      // on the next frame instead of the next poll tick.
      pending.ws = figmaBridgeWsSend(command)
      if (!pending.ws) figmaBridgeQueue.push(command)
    })
  })
}

ipc.handle('figmaBridge:status', function () {
  return figmaBridgeStatus()
})

ipc.handle('figmaBridge:command', async function (e, action, params) {
  try {
    var result = await figmaBridgeCommand(action, params || {})
    return result
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

app.on('before-quit', function () {
  figmaBridgeStop()
})

var minFigmaBridge = {
  start: figmaBridgeStart,
  stop: figmaBridgeStop,
  status: figmaBridgeStatus,
  command: figmaBridgeCommand,
  setExportDir: figmaBridgeSetExportDir,
  setFileKey: figmaBridgeSetFileKey,
  port: FIGMA_BRIDGE_PORT
}
global.minFigmaBridge = minFigmaBridge
