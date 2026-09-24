const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function harness () {
  const ipcHandlers = new Map()
  const state = { selectedView: null }
  const changes = { attached: 0, detached: 0 }
  const messages = []
  const children = [{ chrome: true }]
  const content = {
    children,
    addChildView: view => { if (!children.includes(view)) children.push(view); changes.attached++ },
    removeChildView: view => { const index = children.indexOf(view); if (index !== -1) children.splice(index, 1); changes.detached++ }
  }
  const win = { getContentView: () => content }
  const context = vm.createContext({
    console,
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    Function,
    global: {},
    __dirname: path.resolve(__dirname, '..'),
    settings: { get: () => null },
    windows: { windowFromContents: sender => sender ? { win } : null, getState: () => state, getAll: () => [win], getCurrent: () => win },
    getWindowWebContents: () => ({ send: (channel, message) => messages.push({ channel, message }) }),
    filterPopups: () => true,
    ipc: { on: (name, fn) => ipcHandlers.set(name, fn), handle () {} },
    WebContentsView: class {
      constructor () {
        this.webContents = Object.assign(new EventEmitter(), {
          isDestroyed: () => false, setWindowOpenHandler (handler) { this.windowOpenHandler = handler }, loadURL: async () => {}, destroy () {}, getURL: () => 'min://newtab'
        })
      }

      setBounds (bounds) { this.bounds = bounds }
      setBackgroundColor () {}
    }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/viewManager.js'), 'utf8'), context)
  const bounds = { x: 0, y: 0, width: 400, height: 300 }
  function create (id, generation) {
    const view = context.createView(null, id, {}, JSON.stringify(bounds), [], null, null, null, generation)
    context.loadURLInView(id, 'min://newtab')
    return view
  }
  return { context, state, changes, children, create, bounds, ipcHandlers, messages }
}

test('selecting the same native view keeps it attached and ownership lookup is indexed', () => {
  const h = harness()
  const view = h.create('a')
  h.context.setView('a', {})
  h.context.setView('a', {})
  assert.equal(h.changes.attached, 1)
  assert.equal(h.changes.detached, 0)
  assert.equal(h.context.getViewIdForContents(view.webContents), 'a')
  h.context.destroyView('a')
  assert.equal(h.context.getViewIdForContents(view.webContents), null)
  assert.doesNotThrow(() => h.context.setView('a', {}))
})

test('split resizing retains unchanged panes and only detaches removed panes', () => {
  const h = harness()
  h.create('a'); h.create('b'); h.create('c')
  h.context.setSplitView(['a', 'b'], [h.bounds, h.bounds], 'a', {})
  h.context.setSplitView(['a', 'b'], [h.bounds, h.bounds], 'b', {})
  assert.equal(h.changes.attached, 2)
  assert.equal(h.changes.detached, 0)
  h.context.setSplitView(['a', 'c'], [h.bounds, h.bounds], 'c', {})
  assert.equal(h.changes.attached, 3)
  assert.equal(h.changes.detached, 1)
  h.context.unsplitView('b', h.bounds, {})
  assert.ok(h.children.includes(h.context.getView('b')))
})

test('duplicate create and late native operations cannot leak or touch a destroyed view', async () => {
  const h = harness()
  const view = h.create('a')
  assert.equal(h.create('a'), view)
  h.context.destroyView('a')
  assert.doesNotThrow(() => view.webContents.emit('dom-ready'))
  await h.context.loadURLInView('missing', 'min://newtab')
  assert.doesNotThrow(() => h.context.setSplitView([], [], null, null))
})

test('closing a view during page capture discards the obsolete download', async () => {
  const h = harness()
  const capture = h.ipcHandlers.get('saveViewCapture')
  assert.doesNotThrow(() => capture({}, { id: 'missing' }))
  const view = h.create('a')
  let complete
  view.webContents.capturePage = () => new Promise(resolve => { complete = resolve })
  view.webContents.downloadURL = () => assert.fail('closed view must not download')
  capture({}, { id: 'a' })
  h.context.destroyView('a')
  complete({ toDataURL: () => 'data:image/png;base64,' })
  await Promise.resolve()
})

test('popup notifications carry their opener generation and obsolete openers reject new popups', () => {
  const h = harness()
  const view = h.create('opener', 'generation-a')
  const handler = view.webContents.windowOpenHandler
  const result = handler({ url: 'https://example.test', disposition: 'foreground-tab' })
  assert.equal(result.action, 'allow')
  const popup = result.createWindow({ webContents: {} })
  const event = h.messages.find(({ message }) => message.event === 'did-create-popup').message
  assert.equal(event.generation, 'generation-a')
  const adopted = h.context.createView(event.args[0], 'popup', {}, JSON.stringify(h.bounds), [])
  assert.equal(adopted.webContents, popup)
  h.context.destroyView('opener')
  assert.equal(handler({ url: 'https://example.test' }).action, 'deny')
  h.context.destroyView('popup')
})

test('view adoption reports the native generation and async replies cannot target a replacement', async () => {
  const h = harness()
  const replies = []
  const sender = { isDestroyed: () => false, send: (channel, data) => replies.push({ channel, data }) }
  const original = h.create('a', 'native-generation')
  h.ipcHandlers.get('createView')({ sender }, { id: 'a', generation: 'duplicate-request' })
  h.context.setView('a', sender)
  assert.equal(replies[0].data.generation, 'native-generation')
  assert.equal(replies[1].data.generation, 'native-generation')
  let complete
  original.webContents.delayed = () => new Promise(resolve => { complete = resolve })
  h.ipcHandlers.get('callViewMethod')({ sender }, { id: 'a', method: 'delayed', callId: 1, args: [] })
  h.context.destroyView('a')
  h.create('a', 'replacement')
  complete('obsolete result')
  await Promise.resolve()
  const reply = replies.find(item => item.channel === 'async-call-result').data
  assert.equal(reply.result, null)
  assert.match(reply.error.message, /replaced/)
})

test('background tab metadata handlers update their owner, even with another task selected', () => {
  const callbacks = {}
  const records = new Map([['background', { url: 'https://example.test', title: 'old' }]])
  const webviews = {
    bindEvent: (name, fn) => { callbacks[name] = fn },
    bindIPC () {},
    updateTabState: (id, changes) => Object.assign(records.get(id), changes),
    getTabData: id => records.get(id),
    callAsync () {}
  }
  require('../js/webviews/tabEvents.js')({ webviews, urlParser: {}, settings: { listen () {} } })
  callbacks['page-title-updated']('background', 'new')
  callbacks['did-navigate']('background', 'https://example.test/next')
  assert.deepEqual(records.get('background'), { url: 'https://example.test/next', title: 'new', secure: true })
})
