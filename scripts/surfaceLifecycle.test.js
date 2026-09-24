const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function deferred () {
  let complete
  const promise = new Promise(resolve => { complete = resolve })
  return { promise, resolve: complete }
}

function makeTerminalHarness (readlink) {
  const source = fs.readFileSync(path.join(__dirname, '../main/terminal.js'), 'utf8')
  const handlers = { on: Object.create(null), handle: Object.create(null) }
  const ptys = []
  let nextPid = 200
  const pty = {
    spawn () {
      const callbacks = { data: null, exit: null }
      const term = {
        pid: ++nextPid,
        killed: false,
        onData (fn) { callbacks.data = fn },
        onExit (fn) { callbacks.exit = fn },
        emitData (output) { callbacks.data(output) },
        emitExit () { callbacks.exit() },
        kill () { this.killed = true },
        write () {},
        resize () {}
      }
      ptys.push(term)
      return term
    }
  }
  const sender = {
    id: 9,
    messages: [],
    destroyed: false,
    isDestroyed () { return this.destroyed },
    send (channel, payload) { this.messages.push([channel, payload]) },
    once (name, fn) { this.destroyedListener = fn }
  }
  const fakeFs = {
    promises: {
      stat: async () => ({ isDirectory: () => true }),
      readlink: readlink || (async () => null)
    }
  }
  const context = vm.createContext({
    require (name) {
      if (name === 'node-pty') return pty
      if (name === 'os') return { homedir: () => '/home/test' }
      if (name === 'child_process') throw new Error('unexpected child_process import')
      throw new Error('unexpected import: ' + name)
    },
    ipc: {
      on (name, fn) { handlers.on[name] = fn },
      handle (name, fn) { handlers.handle[name] = fn }
    },
    fs: fakeFs,
    path: path,
    process: { platform: 'linux', env: { SHELL: '/bin/sh' } },
    settings: { get: () => '' },
    viewMap: { 'terminal-tab': { webContents: sender } },
    getViewIdForContents: () => 'terminal-tab',
    console: { warn () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  })
  vm.runInContext(source, context, { filename: 'main/terminal.js' })
  return { handlers, ptys, sender }
}

async function createTerminal (harness, data) {
  harness.handlers.on['terminal-create']({ sender: harness.sender }, data)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('replaced terminal ptys cannot flush or append output into the new session', async () => {
  const harness = makeTerminalHarness()
  await createTerminal(harness, { cwd: '/workspace', scrollback: 'restored ' })
  const oldTerm = harness.ptys[0]
  oldTerm.emitData('queued-old-output')

  await createTerminal(harness, { cwd: '/workspace', scrollback: 'new-history ' })
  const currentTerm = harness.ptys[1]
  oldTerm.emitData('late-old-output')
  oldTerm.emitExit()
  currentTerm.emitData('current-output')
  await wait(30)

  const state = await harness.handlers.handle['terminal-get-state'](
    { sender: harness.sender }, 'terminal-tab', true
  )
  assert.equal(state.tail, 'new-history current-output')
  assert.deepEqual(harness.sender.messages.filter(([name]) => name === 'terminal-data'), [
    ['terminal-data', 'current-output']
  ])
  assert.equal(harness.sender.messages.some(([name]) => name === 'terminal-exit'), false)
})

test('a cwd lookup from a replaced terminal cannot update the replacement session', async () => {
  const cwdLookups = new Map()
  const harness = makeTerminalHarness(filePath => {
    const pid = Number(path.basename(path.dirname(filePath)))
    const result = deferred()
    cwdLookups.set(pid, result)
    return result.promise
  })
  await createTerminal(harness, { cwd: '/workspace', scrollback: 'old-session' })
  const oldTerm = harness.ptys[0]
  const oldStatePromise = harness.handlers.handle['terminal-get-state'](
    { sender: harness.sender }, 'terminal-tab', true
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cwdLookups.has(oldTerm.pid), true)

  await createTerminal(harness, { cwd: '/workspace', scrollback: 'replacement-session' })
  cwdLookups.get(oldTerm.pid).resolve('/stale/cwd')
  const state = await oldStatePromise

  assert.equal(state.cwd, '/workspace')
  assert.equal(state.tail, 'replacement-session')
})

test('file tree searches in separate renderer senders do not cancel one another', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/fileTree.js'), 'utf8')
  const handlers = Object.create(null)
  const directoryReads = []
  const fakeFs = {
    promises: {
      stat: async () => ({ isDirectory: () => true }),
      readdir: () => {
        const result = deferred()
        directoryReads.push(result)
        return result.promise
      }
    }
  }
  const context = vm.createContext({
    ipc: { handle (name, fn) { handlers[name] = fn } },
    fs: fakeFs,
    path: path
  })
  vm.runInContext(source, context, { filename: 'main/fileTree.js' })
  const senderA = {}
  const senderB = {}
  const searchA = handlers.fileTreeSearch({ sender: senderA }, '/workspace', 'alpha')
  const searchB = handlers.fileTreeSearch({ sender: senderB }, '/workspace', 'beta')

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(directoryReads.length, 2)
  directoryReads[0].resolve([{ name: 'alpha-result.js', isDirectory: () => false }])
  directoryReads[1].resolve([{ name: 'beta-result.js', isDirectory: () => false }])

  const [resultsA, resultsB] = await Promise.all([searchA, searchB])
  assert.equal(resultsA.length, 1)
  assert.equal(path.basename(resultsA[0].path), 'alpha-result.js')
  assert.equal(resultsB.length, 1)
  assert.equal(path.basename(resultsB[0].path), 'beta-result.js')
})

test('editor file writes stay asynchronous and serialize concurrent saves to one path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-editor-io-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const filePath = path.join(root, 'document.js')
  fs.writeFileSync(filePath, 'initial')
  const source = fs.readFileSync(path.join(__dirname, '../main/editorFileIO.js'), 'utf8')
  const handlers = Object.create(null)
  const sender = { isDestroyed: () => false }
  const context = vm.createContext({
    ipc: { handle (name, fn) { handlers[name] = fn } },
    fs: fs,
    path: path,
    require: require,
    getViewIdForContents: () => 'editor-tab',
    getViewResource: () => ({ resource: filePath, rootPath: root }),
    isPathInside: (parent, candidate) => {
      const relative = path.relative(parent, candidate)
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    }
  })
  vm.runInContext(source, context, { filename: 'main/editorFileIO.js' })

  const first = handlers.editorWriteFile({ sender }, filePath, 'older'.repeat(100000))
  const second = handlers.editorWriteFile({ sender }, filePath, 'newest content')
  assert.equal(typeof first.then, 'function')
  assert.equal(typeof second.then, 'function')
  await Promise.all([first, second])
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'newest content')
})

test('an editor save is rejected if its view is repointed during async validation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/editorFileIO.js'), 'utf8')
  const handlers = Object.create(null)
  const directoryCheck = deferred()
  let currentResource = '/workspace/old.js'
  let writeStarted = false
  const context = vm.createContext({
    ipc: { handle (name, fn) { handlers[name] = fn } },
    fs: { promises: { stat: () => directoryCheck.promise } },
    path: path,
    require: () => async () => { writeStarted = true },
    getViewIdForContents: () => 'editor-tab',
    getViewResource: () => ({ resource: currentResource, rootPath: '/workspace' }),
    isPathInside: (parent, candidate) => {
      const relative = path.relative(parent, candidate)
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    }
  })
  vm.runInContext(source, context, { filename: 'main/editorFileIO.js' })

  const save = handlers.editorWriteFile({ sender: { isDestroyed: () => false } }, '/workspace/old.js', 'stale')
  currentResource = '/workspace/new.js'
  directoryCheck.resolve({ isDirectory: () => true })
  assert.equal(await save, 'Invalid path')
  assert.equal(writeStarted, false)
})

test('Docs and Notes tab callbacks resolve ownership through the workspace index', () => {
  for (const kind of ['docs', 'notes']) {
    const tab = kind === 'docs'
      ? { id: 'tab-a', url: 'min://app/pages/docs/index.html?workspace=workspace-a&doc=document-a', title: 'Before' }
      : { id: 'tab-a', kind: 'note', resource: 'note-a' }
    let updatedTitle = null
    const task = {
      id: 'task-a',
      tabs: {
        parentTaskList: { workspace: { id: 'workspace-a' } },
        get: id => id === 'tab-a' ? tab : undefined,
        update (id, changes) { updatedTitle = changes.title }
      }
    }
    const callbacks = Object.create(null)
    const workspaces = {
      findTaskContainingTab: id => id === 'tab-a' ? task : null,
      forEach () { throw new Error('per-event tab lookup should use the index') }
    }
    const webviews = { bindIPC (name, fn) { callbacks[name] = fn } }
    const source = fs.readFileSync(path.join(__dirname, '../js/' + kind + 'View.js'), 'utf8')
    const context = vm.createContext({
      module: { exports: {} },
      workspaces: workspaces,
      require: name => name === 'webviews.js' ? webviews : (() => { throw new Error(name) })(),
      URL: URL
    })
    vm.runInContext(source, context, { filename: 'js/' + kind + 'View.js' })
    const surface = context.module.exports
    surface.initialize()

    if (kind === 'docs') {
      callbacks['docs-title-changed']('tab-a', [{ title: 'After' }])
      assert.equal(updatedTitle, 'After')
    } else {
      let change
      surface.onChanged(value => { change = value })
      callbacks['notes-changed']('tab-a', [{ note: { id: 'note-a' } }])
      assert.equal(change.noteId, 'note-a')
    }
  }
})

test('terminal persistence coalesces a live tab request and ignores a reply after close', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/terminalView.js'), 'utf8')
  const tab = { id: 'terminal-a', kind: 'terminal', resource: '/workspace' }
  const tabAdded = []
  const workspaces = {
    forEach (fn) {
      fn({
        tasks: {
          forEach (taskCallback) {
            taskCallback({ tabs: { get: () => currentTab ? [Object.assign({}, currentTab)] : [] } })
          }
        }
      })
    },
    on (name, callback) { tabAdded[name] = callback }
  }
  const response = deferred()
  const invokes = []
  const sent = []
  const updates = []
  const timers = []
  let currentTab = tab
  const webviews = {
    getTabData: () => currentTab && Object.assign({}, currentTab),
    updateTabState: (id, changes) => updates.push([id, changes])
  }
  const context = vm.createContext({
    module: { exports: {} },
    require: name => name === 'browserUI.js' ? {} : webviews,
    workspaces: workspaces,
    ipc: {
      invoke (channel, tabId, includeScrollback) {
        invokes.push([channel, tabId, includeScrollback])
        return response.promise
      },
      send (...args) { sent.push(args) }
    },
    setInterval (fn, delay) {
      const timer = { fn: fn, delay: delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval (timer) { timer.cleared = true },
    setTimeout: setTimeout
  })
  vm.runInContext(source, context, { filename: 'js/terminalView.js' })
  assert.equal(timers.length, 1)

  timers[0].fn()
  timers[0].fn()
  assert.equal(invokes.length, 1)
  currentTab = null
  tabAdded['tab-destroyed']('terminal-a')
  assert.equal(timers[0].cleared, true)
  response.resolve({ cwd: '/stale', tail: 'old scrollback', shell: '/bin/sh' })
  await wait(0)

  assert.deepEqual(updates, [])
  assert.deepEqual(sent, [['terminal-tab-gone', 'terminal-a']])
})

function makeDocumentPageHarness (kind) {
  const pagePath = kind === 'docs' ? '../pages/docs/docs.js' : '../pages/notes/notes.js'
  const source = fs.readFileSync(path.join(__dirname, pagePath), 'utf8')
  const pageURL = kind === 'docs'
    ? 'min://app/pages/docs/index.html?workspace=workspace-a&doc=document-a'
    : 'min://app/pages/notes/index.html'
  const location = new URL(pageURL)
  const messages = []
  const windowListeners = Object.create(null)
  const documentListeners = Object.create(null)
  const elements = Object.create(null)
  let editorOptions = null
  let editorContent = ''

  function makeElement () {
    return {
      value: '',
      hidden: false,
      disabled: false,
      checked: false,
      textContent: '',
      className: '',
      classList: { toggle () {} },
      addEventListener (name, fn) { this['on' + name] = fn }
    }
  }

  ;(kind === 'docs'
    ? ['docs-title', 'docs-private', 'docs-save-status', 'docs-state', 'docs-editor']
    : ['notes-title', 'notes-save-status', 'notes-state', 'notes-editor']
  ).forEach(id => { elements[id] = makeElement() })

  function Editor (options) {
    editorOptions = options
    editorContent = options.initialValue
    this.getMarkdown = () => editorContent
    this.focus = () => {}
  }

  const window = {
    location: location,
    minViewResource: { resource: 'note-a', extra: {} },
    postMessage (data) { messages.push(data) },
    addEventListener (name, fn) { (windowListeners[name] || (windowListeners[name] = [])).push(fn) },
    matchMedia: () => ({ matches: false })
  }
  const document = {
    title: '',
    getElementById: id => elements[id],
    addEventListener (name, fn) { (documentListeners[name] || (documentListeners[name] = [])).push(fn) }
  }
  const context = vm.createContext({
    window: window,
    document: document,
    URL: URL,
    URLSearchParams: URLSearchParams,
    ToastUIEditor: Editor,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: { error () {}, warn () {} }
  })
  vm.runInContext(source, context, { filename: 'pages/' + kind + '/' + kind + '.js' })

  function takeRequest (action) {
    const index = messages.findIndex(message => message.message === kind + '-invoke' && message.action === action)
    assert.notEqual(index, -1, 'expected ' + action + ' request')
    return messages.splice(index, 1)[0]
  }

  function answer (request, result) {
    const channel = kind + '-result'
    const listener = windowListeners.message[0]
    listener({
      origin: location.origin,
      data: { message: channel, requestId: request.requestId, result: result }
    })
  }

  return {
    kind,
    messages,
    windowListeners,
    documentListeners,
    elements,
    get editorOptions () { return editorOptions },
    get editorContent () { return editorContent },
    set editorContent (value) { editorContent = value },
    takeRequest,
    answer
  }
}

for (const kind of ['docs', 'notes']) {
  test(kind + ' save drains edits made while an older request is pending', async () => {
    const page = makeDocumentPageHarness(kind)
    const initial = page.takeRequest('get')
    page.answer(initial, kind === 'docs'
      ? { ok: true, document: { id: 'document-a', title: 'Doc', markdown: 'initial' } }
      : { ok: true, note: { id: 'note-a', title: 'Note', markdown: 'initial' } })
    await wait(0)

    const events = page.editorOptions.events
    page.editorContent = 'older revision'
    events.change()
    const firstSave = events.blur()
    const oldRequest = page.takeRequest('update')
    assert.equal(oldRequest.payload.markdown, 'older revision')

    page.editorContent = 'newest revision'
    events.change()
    events.blur()
    page.answer(oldRequest, { ok: false, error: 'temporary write failure' })
    await wait(0)

    const newRequest = page.takeRequest('update')
    assert.equal(newRequest.payload.markdown, 'newest revision')
    page.answer(newRequest, kind === 'docs'
      ? { ok: true, document: { id: 'document-a', title: 'Doc' } }
      : { ok: true, note: { id: 'note-a', title: 'Note' } })
    await firstSave
    await wait(0)
    assert.equal(page.elements[kind + '-save-status'].textContent, 'Saved')
    page.windowListeners.pagehide[0]()
  })
}
