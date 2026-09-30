const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')

/* main/editorFileIO.js as the main process sees it, over the real filesystem */
function loadEditorIO (filePath, rootPath) {
  const handlers = Object.create(null)
  const context = vm.createContext({
    ipc: { handle (name, fn) { handlers[name] = fn } },
    fs,
    path,
    require,
    getViewIdForContents: () => 'editor-tab',
    getViewResource: () => ({ resource: filePath, rootPath }),
    isPathInside: (parent, candidate) => {
      const relative = path.relative(parent, candidate)
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    }
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'main/editorFileIO.js'), 'utf8'), context, { filename: 'main/editorFileIO.js' })
  const sender = { isDestroyed: () => false }
  return {
    read: () => handlers.editorReadFile({ sender }, filePath),
    stat: () => handlers.editorStatFile({ sender }, filePath),
    write: (content, expectedMtimeMs) => handlers.editorWriteFile({ sender }, filePath, content, expectedMtimeMs)
  }
}

function tempFile (t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-editor-conflict-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'file.js')
  fs.writeFileSync(filePath, content)
  return { dir, filePath }
}

/* an edit made by something other than the editor: new content, and an mtime
that certainly differs even on coarse-grained filesystems */
let externalEdits = 0
function editExternally (filePath, content) {
  fs.writeFileSync(filePath, content)
  const when = new Date(Date.now() + 10000 * ++externalEdits)
  fs.utimesSync(filePath, when, when)
}

test('a write is refused when the file changed since the editor last saw it', async t => {
  const { dir, filePath } = tempFile(t, 'initial')
  const io = loadEditorIO(filePath, dir)
  const { mtimeMs } = await io.read()
  assert.equal(typeof mtimeMs, 'number')

  assert.equal(await io.write('mine', mtimeMs), null)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'mine')

  const seen = (await io.stat()).mtimeMs
  editExternally(filePath, 'agent')
  const result = await io.write('stale edit', seen)
  assert.equal(result.conflict, true)
  assert.equal(result.mtimeMs, fs.statSync(filePath).mtimeMs)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'agent')

  // no expectation (or an explicit null) is the deliberate overwrite
  assert.equal(await io.write('overwrite', null), null)
  assert.equal(await io.write('again', undefined), null)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'again')
})

test('a file deleted under the editor is recreated instead of reported as a conflict', async t => {
  const { dir, filePath } = tempFile(t, 'initial')
  const io = loadEditorIO(filePath, dir)
  const { mtimeMs } = await io.read()
  fs.rmSync(filePath)
  assert.equal(await io.write('kept', mtimeMs), null)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'kept')
})

/* pages/editor/editor.js against the real main-process handlers, with Monaco
and the timers replaced so each step is deterministic */
async function editorPage (t, initial) {
  const { dir, filePath } = tempFile(t, initial)
  const io = loadEditorIO(filePath, dir)
  const location = new URL('min://app/pages/editor/index.html')
  const windowListeners = Object.create(null)
  const documentListeners = Object.create(null)
  const elements = Object.create(null)
  const bodyClasses = new Set()
  const dirtyMessages = []
  let inflight = 0
  let timeoutId = 0
  const timeouts = new Map()
  let pollCallback = null

  function element () {
    return { hidden: false, textContent: '', listeners: {}, addEventListener (name, fn) { this.listeners[name] = fn } }
  }
  ;['editor-loading', 'editor-error', 'editor-error-text', 'editor-container', 'editor-conflict', 'editor-conflict-text',
    'editor-conflict-overwrite', 'editor-conflict-reload'].forEach(id => { elements[id] = element() })
  elements['editor-conflict'].hidden = true

  function deliver (data) {
    ;(windowListeners.message || []).forEach(fn => fn({ origin: 'min://app', data }))
  }

  const window = {
    location,
    minViewResource: { resource: filePath, extra: {} },
    matchMedia: () => ({ matches: true }),
    addEventListener (name, fn) { (windowListeners[name] || (windowListeners[name] = [])).push(fn) },
    postMessage (data) {
      if (data.message === 'editor-dirty') {
        dirtyMessages.push(data.dirty)
        return
      }
      const bridge = {
        'editor-read': () => io.read(),
        'editor-stat': () => io.stat(),
        'editor-write': () => io.write(data.content, data.expectedMtimeMs)
      }[data.message]
      if (!bridge) return
      inflight++
      bridge().then(result => {
        inflight--
        deliver({ message: 'editor-result', requestId: data.requestId, originalMessage: data.message, result })
      })
    }
  }

  // just enough of Monaco: one text model, its change listeners and an undo-less edit API
  let value = ''
  const changeListeners = []
  const fakeEditor = {
    getValue: () => value,
    setValue (text) { value = text; changeListeners.forEach(fn => fn()) },
    getPosition: () => null,
    setPosition () {},
    pushUndoStop () {},
    executeEdits (source, edits) { value = edits[0].text; changeListeners.forEach(fn => fn()) },
    getModel: () => ({ getFullModelRange: () => ({}) }),
    onDidChangeModelContent: fn => changeListeners.push(fn),
    addCommand () {}
  }
  const monaco = {
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    editor: {
      create (container, options) { value = options.value; return fakeEditor },
      setTheme () {}
    }
  }
  const requireFn = (deps, done) => done()
  requireFn.config = () => {}

  const context = vm.createContext({
    window,
    document: {
      title: '',
      body: { classList: { add: name => bodyClasses.add(name), remove: name => bodyClasses.delete(name) } },
      visibilityState: 'visible',
      getElementById: id => elements[id],
      addEventListener (name, fn) { (documentListeners[name] || (documentListeners[name] = [])).push(fn) }
    },
    l: key => key,
    require: requireFn,
    monaco,
    URL,
    URLSearchParams,
    console: { error () {}, warn () {}, log () {} },
    setTimeout: (fn, ms) => { const id = ++timeoutId; timeouts.set(id, { fn, ms }); return id },
    clearTimeout: id => { timeouts.delete(id) },
    setInterval: fn => { pollCallback = fn; return 1 },
    clearInterval () {}
  })
  // monaco is resolved through the AMD loader on the real page
  context.window.monaco = monaco
  vm.runInContext(fs.readFileSync(path.join(root, 'pages/editor/editor.js'), 'utf8'), context, { filename: 'pages/editor/editor.js' })

  async function idle () {
    let calm = 0
    while (calm < 3) {
      await new Promise(resolve => setImmediate(resolve))
      calm = inflight === 0 ? calm + 1 : 0
    }
  }
  await idle()

  const page = {
    dir,
    filePath,
    elements,
    dirtyMessages,
    idle,
    get text () { return value },
    get conflictShown () { return elements['editor-conflict'].hidden === false },
    get barPushesEditor () { return bodyClasses.has('has-conflict') },
    get diskText () { return fs.readFileSync(filePath, 'utf8') },
    /* the user types: replaces the buffer and lets Monaco announce it */
    type (text) { fakeEditor.setValue(text) },
    async autosave () {
      // the newest pending autosave timer is the 700ms one
      const pending = [...timeouts.entries()].filter(([, timer]) => timer.ms === 700)
      timeouts.clear()
      pending.forEach(([, timer]) => timer.fn())
      await idle()
      return pending.length
    },
    async poll () {
      await pollCallback()
      await idle()
    },
    async click (id) {
      elements[id].listeners.click()
      await idle()
    },
    pendingAutosaves: () => [...timeouts.values()].filter(timer => timer.ms === 700).length
  }
  return page
}

test('edits are autosaved normally when nothing else touched the file', async t => {
  const page = await editorPage(t, 'initial')
  assert.equal(page.text, 'initial')
  page.type('typed')
  assert.equal(await page.autosave(), 1)
  assert.equal(page.diskText, 'typed')
  assert.equal(page.conflictShown, false)
  // and again, using the mtime of the save before
  page.type('typed twice')
  await page.autosave()
  assert.equal(page.diskText, 'typed twice')
  assert.equal(page.conflictShown, false)
})

test('autosave never overwrites a change made on disk while the editor had unsaved edits', async t => {
  const page = await editorPage(t, 'initial')
  page.type('my edit')
  editExternally(page.filePath, 'agent rewrote this')
  await page.autosave()
  assert.equal(page.diskText, 'agent rewrote this')
  assert.equal(page.conflictShown, true)
  assert.equal(page.barPushesEditor, true)
  assert.equal(page.text, 'my edit')
  assert.equal(page.dirtyMessages.at(-1), true)

  // further typing must not schedule (or run) another save while unresolved
  page.type('my edit, more')
  assert.equal(page.pendingAutosaves(), 0)
  await page.autosave()
  assert.equal(page.diskText, 'agent rewrote this')
})

test('Overwrite saves the editor text over the disk version and resumes autosave', async t => {
  const page = await editorPage(t, 'initial')
  page.type('my edit')
  editExternally(page.filePath, 'agent')
  await page.autosave()
  assert.equal(page.conflictShown, true)

  await page.click('editor-conflict-overwrite')
  assert.equal(page.diskText, 'my edit')
  assert.equal(page.conflictShown, false)
  assert.equal(page.barPushesEditor, false)
  assert.equal(page.dirtyMessages.at(-1), false)

  page.type('after overwrite')
  await page.autosave()
  assert.equal(page.diskText, 'after overwrite')
  assert.equal(page.conflictShown, false)
})

test('Reload from disk takes the disk text, keeps the file untouched, and resumes autosave', async t => {
  const page = await editorPage(t, 'initial')
  page.type('my edit')
  editExternally(page.filePath, 'agent')
  await page.autosave()

  await page.click('editor-conflict-reload')
  assert.equal(page.text, 'agent')
  assert.equal(page.diskText, 'agent')
  assert.equal(page.conflictShown, false)
  assert.equal(page.dirtyMessages.at(-1), false)
  assert.equal(page.pendingAutosaves(), 0)

  page.type('agent plus me')
  await page.autosave()
  assert.equal(page.diskText, 'agent plus me')
  assert.equal(page.conflictShown, false)
})

test('the poll raises the conflict before autosave gets there, and only when edits are unsaved', async t => {
  const page = await editorPage(t, 'initial')
  page.type('my edit')
  editExternally(page.filePath, 'agent')
  await page.poll()
  assert.equal(page.conflictShown, true)
  assert.equal(page.pendingAutosaves(), 0)
  assert.equal(page.diskText, 'agent')
  assert.equal(page.text, 'my edit')
})

test('an external change without local edits is picked up silently', async t => {
  const page = await editorPage(t, 'initial')
  editExternally(page.filePath, 'changed elsewhere')
  await page.poll()
  assert.equal(page.text, 'changed elsewhere')
  assert.equal(page.conflictShown, false)
  assert.equal(page.dirtyMessages.length, 0)

  // and the next local edit saves cleanly on top of it
  page.type('then mine')
  await page.autosave()
  assert.equal(page.diskText, 'then mine')
  assert.equal(page.conflictShown, false)
})

test('the editor\'s own save is never mistaken for an external change', async t => {
  const page = await editorPage(t, 'initial')
  page.type('saved by the editor')
  await page.autosave()
  await page.poll()
  assert.equal(page.conflictShown, false)
  assert.equal(page.text, 'saved by the editor')
  assert.equal(page.diskText, 'saved by the editor')
})
