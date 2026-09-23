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
    process,
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
  return { context, connect }
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
