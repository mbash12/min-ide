const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { once } = require('events')
const WebSocket = require('ws')

function engineHarness () {
  let now = 1000
  const bridge = { pluginConnected: false, fileKey: null }
  const context = vm.createContext({
    require,
    __dirname: path.resolve(__dirname, '..'),
    fs,
    path,
    process: {
      platform: process.platform,
      pid: process.pid,
      env: process.env,
      kill: process.kill.bind(process),
      on () {}
    },
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Date: { now: () => now },
    app: { getPath: () => '/tmp/min-figma-test', on () {} },
    ipc: { handle () {} },
    settings: { get: () => ({}) },
    minFigmaBridge: {
      status: () => bridge,
      setFileKey: key => { bridge.fileKey = key },
      setExportDir () {}
    }
  })
  context.global = context
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/figmaEngine.js'), 'utf8'), context)
  context.figmaEngineSleep = async ms => { now += ms }
  context.figmaEngineGetStatus = async () => ({ ok: true, currentFileKey: 'target', runtimeReady: true, loading: false })
  return { context, bridge }
}

test('a cold engine connects without showing, priming, or focusing a window', async () => {
  const { context, bridge } = engineHarness()
  const calls = []
  context.figmaEngineRpc = async method => {
    calls.push(method)
    if (method === 'runPlugin') bridge.pluginConnected = true
    return { ok: true }
  }
  assert.equal((await context.figmaEngineWaitPlugin('target')).ok, true)
  assert.equal(bridge.fileKey, 'target')
  assert.deepEqual(calls, ['ensureRuntime', 'runPlugin'])
})

test('stopping during bridge startup prevents a late engine spawn', async () => {
  const { context } = engineHarness()
  let finishBridgeStart
  let spawnCalls = 0
  context.minFigmaBridge.start = () => new Promise(resolve => { finishBridgeStart = resolve })
  context.figmaEngineResolveLaunch = () => ({ electron: '/electron', entry: '/engine', cwd: '/engine' })
  context.figmaEngineClearStaleEngine = async () => {}
  context.figmaEngineSpawn = async () => { spawnCalls++ }
  context.figmaEngineWaitReady = async () => ({ backgroundRuntime: true, offscreenRendering: true })

  const starting = context.figmaEngineEnsureStarted()
  await new Promise(resolve => setImmediate(resolve))
  context.figmaEngineStopNow()
  finishBridgeStart()
  await assert.rejects(starting, /startup cancelled/)
  assert.equal(spawnCalls, 0)
})

test('an accepted plugin launch is never repeated while waiting for its socket', async () => {
  const { context } = engineHarness()
  const calls = []
  context.figmaEngineRpc = async method => {
    calls.push(method)
    return { ok: true }
  }
  assert.equal((await context.figmaEngineWaitPlugin('target', 12000)).ok, false)
  assert.deepEqual(calls, ['ensureRuntime', 'runPlugin'])
})

test('only rejected plugin dispatches are retried', async () => {
  const { context, bridge } = engineHarness()
  let attempts = 0
  context.figmaEngineRpc = async method => {
    if (method !== 'runPlugin') return { ok: true }
    if (++attempts === 1) return { ok: false, error: 'editor starting' }
    bridge.pluginConnected = true
    bridge.fileKey = 'target'
    return { ok: true }
  }
  assert.equal((await context.figmaEngineWaitPlugin('target')).ok, true)
  assert.equal(attempts, 2)
})

test('background activation failure is returned without revealing the window', async () => {
  const { context } = engineHarness()
  const calls = []
  context.figmaEngineRpc = async method => {
    calls.push(method)
    return { ok: false, error: 'editor starting' }
  }
  const result = await context.figmaEngineWaitPlugin('target')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'editor starting')
  assert.deepEqual(calls, ['ensureRuntime'])
})

test('network load completion alone cannot make a file ready', async () => {
  const { context } = engineHarness()
  let checks = 0
  context.FIGMA_ENGINE_FILE_STABLE_MS = 400
  context.figmaEngineRpc = async (method, params) => {
    assert.equal(method, 'ensureRuntime')
    assert.equal(params.fileKey, 'target')
    return { ok: true }
  }
  context.figmaEngineGetStatus = async () => ({
    ok: true, loading: false, currentFileKey: 'target', runtimeReady: ++checks >= 3
  })
  assert.equal((await context.figmaEngineWaitFile({ fileKey: 'target' }, 3000)).runtimeReady, true)
  assert.equal(checks, 4)
})

test('an existing connection to another file cannot satisfy a connect', async () => {
  const { context, bridge } = engineHarness()
  bridge.pluginConnected = true
  bridge.fileKey = 'other'
  context.figmaEngineRpc = async () => ({ ok: true })
  assert.equal((await context.figmaEngineWaitPlugin('target', 1600)).ok, false)
  assert.equal(bridge.fileKey, 'other')
})

test('missing login directs the user to the Min tab without a show RPC', async () => {
  const { context } = engineHarness()
  context.figmaEngineEnsureStarted = async () => {}
  context.figmaEngineRpc = async method => {
    assert.equal(method, 'hasSession')
    return { ok: true, authed: false }
  }
  const result = await context.figmaEngineConnect({ url: 'https://www.figma.com/design/target/Design' })
  assert.equal(result.needsLogin, true)
  assert.match(result.error, /Min tab/)
})

test('saved URLs connect on demand and keep exports serialized across file switches', async () => {
  const { context, bridge } = engineHarness()
  const calls = []
  let finishFirst
  context.figmaEngineEnsureStarted = async () => {}
  context.figmaEngineRpc = async () => ({ ok: true })
  context.figmaEngineConnectInner = async opts => {
    calls.push('connect:' + opts.url)
    bridge.fileKey = context.figmaParseUrl(opts.url).fileKey
    bridge.pluginConnected = true
    return { ok: true }
  }
  context.minFigmaBridge.command = async (action, params) => {
    calls.push('export:' + params.fileKey + ':' + params.nodeId)
    if (params.fileKey === 'first') await new Promise(resolve => { finishFirst = resolve })
    return { ok: true }
  }
  const first = context.figmaEngineCommand('export', { figmaUrl: 'https://www.figma.com/design/first?node-id=1-2' })
  const second = context.figmaEngineCommand('export', { figmaUrl: 'https://www.figma.com/design/second?node-id=3-4' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['connect:https://www.figma.com/design/first?node-id=1-2', 'export:first:1:2'])
  finishFirst()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.deepEqual(calls.slice(2), ['connect:https://www.figma.com/design/second?node-id=3-4', 'export:second:3:4'])
})

test('a stalled export reloads its renderer once, while invalid nodes are not retried', async () => {
  const { context, bridge } = engineHarness()
  bridge.fileKey = 'target'
  bridge.pluginConnected = true
  const calls = []
  context.figmaEngineEnsureStarted = async () => {}
  context.figmaEngineRpc = async method => { calls.push(method); return { ok: true } }
  context.figmaEngineConnectInner = async () => { calls.push('connect'); return { ok: true } }
  let commands = 0
  context.minFigmaBridge.command = async () => {
    commands++
    return commands === 1 ? { ok: false, error: 'export render timed out after 90s' } : { ok: true }
  }
  assert.equal((await context.figmaEngineCommand('export', { fileKey: 'target' })).ok, true)
  assert.equal(commands, 2)
  assert.deepEqual(calls, ['ensureRuntime', 'ensureRuntime', 'reloadFile', 'connect'])
  calls.length = 0
  context.minFigmaBridge.command = async () => ({ ok: false, error: 'Node 9:9 was not found in this file' })
  const result = await context.figmaEngineCommand('export', { fileKey: 'target', nodeId: '9:9' })
  assert.equal(result.ok, false)
  assert.deepEqual(calls, ['ensureRuntime'])
})

test('ambiguous workspace context cannot silently export another workspace file', async () => {
  const { context } = engineHarness()
  context.figmaEngineContext = { fileKey: 'other', workspaceId: 'other' }
  const result = await context.figmaEngineCommand('export', { workspaceId: 'this' })
  assert.equal(result.ok, false)
  assert.match(result.error, /this workspace/)
  const mismatch = await context.figmaEngineCommand('export', { fileKey: 'a', figmaUrl: 'https://www.figma.com/design/b' })
  assert.match(mismatch.error, /different files/)
})

test('hidden plugin UI executes commands over WebSocket and falls back to HTTP', async () => {
  const messages = []
  const requests = []
  let uiOptions
  const frame = { id: '1:2', name: 'Frame', type: 'FRAME', width: 100, height: 80 }
  const figma = {
    showUI: (html, options) => { uiOptions = options },
    ui: { postMessage: message => messages.push(message) },
    currentPage: { id: '0:1', name: 'Page', selection: [], children: [frame], loadAsync: async () => {} },
    root: { name: 'Design' },
    getNodeByIdAsync: async () => frame,
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    on () {}
  }
  const context = vm.createContext({
    figma,
    __html__: '',
    console: { log () {} },
    setTimeout: () => 1,
    clearTimeout () {},
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({}) }
    }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8'), context)
  assert.equal(uiOptions.visible, false)
  figma.ui.onmessage({ type: 'ws-state', state: 'open' })
  await context.runBridgeCommand({ id: 'ws', action: 'list-frames' }, true)
  const result = messages.find(message => message.type === 'ws-send').payload
  assert.equal(result.ok, true)
  assert.equal(result.payload.frames[0].id, frame.id)
  figma.ui.onmessage({ type: 'ws-state', state: 'closed' })
  await context.runBridgeCommand({ id: 'http', action: 'list-frames' }, true)
  const response = requests.find(request => request.url.endsWith('/command/result'))
  assert.equal(JSON.parse(response.options.body).id, 'http')
  assert.equal(JSON.parse(response.options.body).ok, true)

  frame.exportAsync = async () => Buffer.from('rendered PNG')
  await context.runBridgeCommand({ id: 'export', action: 'export', fileKey: 'target', nodeId: frame.id, format: 'PNG' }, false)
  const upload = requests.find(request => request.url.endsWith('/export'))
  assert.ok(upload, 'export must upload the rendered bytes')
  const body = JSON.parse(upload.options.body)
  assert.equal(body.id, 'export')
  assert.equal(body.fileKey, 'target')
  assert.equal(body.nodeId, frame.id)
  assert.equal(Buffer.from(body.dataBase64, 'base64').toString(), 'rendered PNG')
  assert.equal(body.pngBase64, undefined, 'avoid duplicating large PNG uploads')
  frame.width = 100000
  frame.height = 50000
  let rasterScale
  frame.exportAsync = async options => { rasterScale = options.constraint.value; return Buffer.from('PNG') }
  await context.runBridgeCommand({ id: 'huge', action: 'export', nodeId: frame.id, scale: 2 }, false)
  assert.ok(frame.width * rasterScale <= 16000)
  assert.ok(frame.width * frame.height * rasterScale ** 2 <= 64 * 1024 * 1024 + 1)
  frame.width = 100
  frame.height = 80

  // Messy grouping: an overflowing text layer is nested under an unrelated
  // group. Geometry, visibility, export scale, and clipping decide candidates.
  frame.absoluteBoundingBox = { x: 100, y: 200, width: 100, height: 80 }
  const label = {
    id: 'text',
    name: 'Layer 347',
    type: 'TEXT',
    characters: 'Buy now',
    absoluteBoundingBox: { x: 125, y: 230, width: 40, height: 20 },
    fontName: { family: 'Inter', style: 'Bold' },
    fontSize: 16,
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]
  }
  frame.children = [
    { id: 'group', name: 'Unrelated group', type: 'GROUP', absoluteBoundingBox: { x: 100, y: 200, width: 10, height: 10 }, children: [label] },
    { id: 'hidden', name: 'Hidden', type: 'GROUP', visible: false, children: [Object.assign({}, label, { id: 'hidden-text' })] },
    { id: 'clipped', name: 'Clipped', type: 'FRAME', clipsContent: true, absoluteBoundingBox: { x: 100, y: 200, width: 10, height: 10 }, children: [Object.assign({}, label, { id: 'clipped-text' })] }
  ]
  await context.runBridgeCommand({ id: 'region', action: 'inspect-region', nodeId: frame.id, region: { x: 50, y: 60, width: 80, height: 40 }, referenceScale: 2 }, true)
  const regionResponse = requests.find(request => request.url.endsWith('/command/result') && JSON.parse(request.options.body).id === 'region')
  const region = JSON.parse(regionResponse.options.body)
  assert.equal(region.ok, true)
  assert.equal(region.payload.matches[0].id, label.id)
  assert.deepEqual(region.payload.matches[0].bounds, { x: 25, y: 30, width: 40, height: 20 })
  assert.equal(region.payload.matches[0].characters, 'Buy now')
  assert.equal(region.payload.matches[0].style.fontFamily, 'Inter')
  const manyTexts = Object.assign({}, frame, { children: Array.from({ length: 55 }, (_, i) => Object.assign({}, label, { id: 'text-' + i })) })
  const limitedFonts = context.fontsForNode(manyTexts)
  assert.equal(limitedFonts.texts.length, 50)
  assert.equal(limitedFonts.truncated, true)
  assert.match(context.textForNode(manyTexts), /Text scan truncated/)
  const reads = []
  context.cssForNode = () => { reads.push('css'); return 'color:red' }
  context.fontsForNode = () => { reads.push('fonts'); return [{ family: 'Inter' }] }
  context.textForNode = () => { reads.push('text'); return 'Buy now' }
  await context.runBridgeCommand({ id: 'fonts-only', action: 'node-data', nodeId: frame.id, fields: ['fonts'] }, true)
  const fontsOnly = JSON.parse(requests.find(request => request.url.endsWith('/command/result') && JSON.parse(request.options.body).id === 'fonts-only').options.body).payload
  assert.deepEqual(reads, ['fonts'])
  assert.equal(JSON.parse(fontsOnly.fontJson)[0].family, 'Inter')
  assert.equal(fontsOnly.css, undefined)
  assert.equal(fontsOnly.textExtract, undefined)
  assert.equal(region.payload.matches.some(match => match.id === 'hidden-text' || match.id === 'clipped-text'), false)
  assert.throws(() => context.inspectRegionInNode(frame, { x: 0, y: 0, width: 300, height: 20 }, 2), /outside/)
  assert.throws(() => context.inspectRegionInNode(frame, { x: 0, y: 0, width: 1, height: 1 }, 0), /referenceScale/)
})

async function bridgeHarness (t) {
  const context = vm.createContext({
    require,
    fs,
    path,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    app: { on () {} },
    ipc: { handle () {} }
  })
  context.global = context
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/figmaBridge.js'), 'utf8'), context)
  context.FIGMA_BRIDGE_PORT = 0
  await context.minFigmaBridge.start()
  t.after(() => context.minFigmaBridge.stop())
  const port = context.figmaBridgeServer.address().port
  const connect = fileKey => {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=min-figma-bridge-local&fileKey=' + (fileKey || ''))
    t.after(() => socket.terminate())
    return socket
  }
  return { context, connect, port }
}

test('commands queued during HTTP to WebSocket handoff are delivered once', async t => {
  const { context, connect } = await bridgeHarness(t)
  const result = context.minFigmaBridge.command('list-frames', { fileKey: 'target' })
  const socket = connect('target')
  const [data] = await once(socket, 'message')
  const command = JSON.parse(data)
  assert.equal(command.action, 'list-frames')
  socket.send(JSON.stringify({ type: 'result', id: command.id, ok: true, payload: { frames: [] } }))
  assert.equal((await result).ok, true)
  assert.equal(context.minFigmaBridge.status().queueDepth, 0)
  assert.equal(context.minFigmaBridge.status().pendingCommands, 0)
})

test('a socket for another file does not consume queued commands', async t => {
  const { context, connect } = await bridgeHarness(t)
  const other = connect('other')
  await once(other, 'open')
  const result = context.minFigmaBridge.command('node-data', { fileKey: 'target' })
  const target = connect('target')
  const [data] = await once(target, 'message')
  const command = JSON.parse(data)
  assert.equal(command.fileKey, 'target')
  target.send(JSON.stringify({ type: 'result', id: command.id, ok: true }))
  assert.equal((await result).ok, true)
})

test('commands that timed out cannot run later when a plugin connects', async t => {
  const { context, connect } = await bridgeHarness(t)
  context.FIGMA_BRIDGE_COMMAND_TIMEOUT_MS = 15
  await assert.rejects(context.minFigmaBridge.command('rescan', {}), /timed out/)
  assert.equal(context.minFigmaBridge.status().queueDepth, 0)
  const socket = connect('target')
  await once(socket, 'open')
  assert.equal(context.minFigmaBridge.status().pendingCommands, 0)
  assert.equal(context.minFigmaBridge.status().jobs[0].state, 'error')
})

test('HTTP polling is file-specific and expired uploads cannot create files', async t => {
  const { context, port } = await bridgeHarness(t)
  const headers = { 'x-min-figma-bridge': 'min-figma-bridge-local', 'content-type': 'application/json' }
  const pending = context.minFigmaBridge.command('rescan', { fileKey: 'target' })
  const base = 'http://127.0.0.1:' + port
  const wrong = await fetch(base + '/command/poll?fileKey=other', { headers })
  const wrongBody = await wrong.json()
  assert.equal(wrongBody.command, null)
  assert.equal(context.minFigmaBridge.status().queueDepth, 1)
  const right = await fetch(base + '/command/poll?fileKey=target', { headers })
  const command = (await right.json()).command
  assert.equal(command.fileKey, 'target')
  await fetch(base + '/command/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, ok: true }) })
  assert.equal((await pending).ok, true)
  const late = await fetch(base + '/export', { method: 'POST', headers, body: JSON.stringify({ id: command.id, dataBase64: 'c3RhbGU=' }) })
  assert.equal(late.status, 409)
})

test('switching files discards the old heartbeat and anonymous socket', async t => {
  const { context, connect } = await bridgeHarness(t)
  const old = connect()
  await once(old, 'open')
  context.minFigmaBridge.setFileKey('old')
  assert.equal(context.minFigmaBridge.status().pluginConnected, true)
  context.minFigmaBridge.resetPlugin()
  assert.equal(context.minFigmaBridge.status().pluginConnected, false)
  assert.equal(context.minFigmaBridge.status().fileKey, null)
  assert.equal(context.minFigmaBridge.status().lastSeen, null)
  const result = context.minFigmaBridge.command('node-data', { fileKey: 'next' })
  const next = connect('next')
  const [data] = await once(next, 'message')
  const command = JSON.parse(data)
  next.send(JSON.stringify({ type: 'result', id: command.id, ok: true }))
  assert.equal((await result).ok, true)
})
