const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const createRequestGate = require('../js/sidebar/lifecycle/requestGate.js')
const createCoalescedTask = require('../js/sidebar/lifecycle/coalescedTask.js')
const createDebouncedWriter = require('../js/sidebar/lifecycle/debouncedWriter.js')

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function element () {
  return {
    children: [],
    dataset: {},
    style: {},
    appendChild (child) { this.children.push(child); child.parentNode = this; return child },
    replaceChild (child, oldChild) {
      const index = this.children.indexOf(oldChild)
      if (index >= 0) this.children[index] = child
      child.parentNode = this
      oldChild.parentNode = null
      return oldChild
    },
    setAttribute () {},
    removeAttribute () {},
    addEventListener () {},
    focus () {},
    select () {}
  }
}

test('Docs panel ignores an older list response after a workspace switch and initializes once', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/sidebar/docsPanel.js'), 'utf8')
  const panel = element()
  const handlers = {}
  const listRequests = []
  let selected = { id: 'workspace-a' }
  let changedListener
  let workspaceSubscriptions = 0
  let ipcSubscriptions = 0
  const customDataStore = {
    listDocuments (workspaceId) {
      return new Promise(resolve => listRequests.push({ workspaceId, resolve }))
    }
  }
  const docsView = {
    initialize () {},
    onChanged (listener) { changedListener = listener; return function () { changedListener = null } },
    open () {},
    updateTitle () {},
    close () {}
  }
  const context = vm.createContext({
    module: { exports: {} },
    document: { getElementById: () => panel, createElement: () => element() },
    workspaces: {
      getSelected: () => selected,
      on (name, listener) { workspaceSubscriptions++; handlers[name] = listener }
    },
    ipc: { on () { ipcSubscriptions++ } },
    customDataStore,
    docsView,
    promptModal: { prompt: async () => null, confirm: async () => false },
    sidebarUI: { createPanelHeader: () => element(), createEmptyState: () => element() },
    l: key => key,
    empty: target => { target.children = [] },
    require (name) {
      if (name === 'util/customDataStore.js') return customDataStore
      if (name === 'docsView.js') return docsView
      if (name === 'promptModal.js') return context.promptModal
      if (name === 'sidebar/ui.js') return context.sidebarUI
      if (name === 'sidebar/lifecycle/requestGate.js') return createRequestGate
      if (name === 'sidebar/lifecycle/coalescedTask.js') return createCoalescedTask
      throw new Error('Unexpected module: ' + name)
    }
  })
  vm.runInContext(source, context)
  const docsPanel = context.module.exports
  docsPanel.initialize()
  docsPanel.initialize()
  assert.equal(listRequests.length, 1)
  assert.equal(workspaceSubscriptions, 1)
  assert.equal(ipcSubscriptions, 2)
  assert.equal(typeof changedListener, 'function')

  selected = { id: 'workspace-b' }
  handlers['workspace-selected']('workspace-b')
  assert.equal(listRequests.length, 2)

  listRequests[1].resolve({ documents: [{ id: 'b-doc', title: 'B document' }] })
  await wait(0)
  assert.equal(docsPanel.getWorkspaceId(), 'workspace-b')
  assert.equal(docsPanel.getDocuments()[0].id, 'b-doc')

  listRequests[0].resolve({ documents: [{ id: 'a-doc', title: 'A document' }] })
  await wait(0)
  assert.equal(docsPanel.getWorkspaceId(), 'workspace-b')
  assert.equal(docsPanel.getDocuments()[0].id, 'b-doc')
})

test('a completed workspace request cannot commit after the scope changes', async () => {
  const gate = createRequestGate()
  let selectedScope = 'workspace-a'
  let visibleResult = null

  function request (scope, promise) {
    const token = gate.begin(scope)
    return promise.then(result => {
      if (!gate.isCurrent(token, selectedScope)) return false
      visibleResult = result
      return true
    })
  }

  let resolveA
  let resolveB
  const responseA = new Promise(resolve => { resolveA = resolve })
  const responseB = new Promise(resolve => { resolveB = resolve })
  const first = request('workspace-a', responseA)

  selectedScope = 'workspace-b'
  gate.setScope(selectedScope)
  const second = request('workspace-b', responseB)

  resolveA('stale A')
  assert.equal(await first, false)
  assert.equal(visibleResult, null)

  resolveB('current B')
  assert.equal(await second, true)
  assert.equal(visibleResult, 'current B')
})

test('refresh notifications coalesce and an explicit refresh releases the pending timer', async () => {
  const values = []
  const queue = createCoalescedTask(value => values.push(value), 10)

  queue.schedule('first')
  queue.schedule('latest')
  await wait(20)
  assert.deepEqual(values, ['latest'])

  queue.schedule('superseded')
  queue.invalidate()
  await wait(20)
  assert.deepEqual(values, ['latest'])
})

test('tree state writes keep only the latest burst and serialize per workspace', async () => {
  const writes = []
  let releaseFirst
  const firstWrite = new Promise(resolve => { releaseFirst = resolve })
  const writer = createDebouncedWriter(async (key, value) => {
    writes.push([key, value])
    if (writes.length === 1) await firstWrite
  }, 5)

  writer.schedule('tree:a', { expandedPaths: ['one'] })
  writer.schedule('tree:a', { expandedPaths: ['one', 'two'] })
  writer.schedule('tree:a', { expandedPaths: ['one', 'two', 'three'] })
  await wait(15)
  assert.deepEqual(writes, [['tree:a', { expandedPaths: ['one', 'two', 'three'] }]])

  writer.schedule('tree:a', { expandedPaths: ['latest'] })
  await wait(15)
  assert.equal(writes.length, 1)
  releaseFirst()
  await wait(15)
  assert.deepEqual(writes, [
    ['tree:a', { expandedPaths: ['one', 'two', 'three'] }],
    ['tree:a', { expandedPaths: ['latest'] }]
  ])

  writer.schedule('tree:b', { expandedPaths: ['disposed'] })
  writer.dispose()
  await wait(15)
  assert.equal(writes.length, 2)
})

test('a deleted workspace cancels a tree-state write that has not started', async () => {
  const writes = []
  const writer = createDebouncedWriter(async (key, value) => writes.push([key, value]), 10)
  writer.schedule('tree:deleted', { expandedPaths: ['/repo/src'] })
  writer.cancel('tree:deleted')
  await wait(20)
  assert.deepEqual(writes, [])
  writer.schedule('tree:kept', { expandedPaths: ['/repo/docs'] })
  await wait(20)
  assert.deepEqual(writes, [['tree:kept', { expandedPaths: ['/repo/docs'] }]])
})

test('file tree render reads the workspace root directory', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/sidebar/fileTree.js'), 'utf8')
  const handlers = {}
  const readPaths = []
  const ws = { id: 'workspace-a', path: '/repo' }

  function treeElement () {
    return {
      children: [],
      dataset: {},
      style: { setProperty () {} },
      classList: { add () {}, remove () {} },
      appendChild (child) { this.children.push(child); child.parentNode = this; return child },
      replaceChild (child, oldChild) {
        const index = this.children.indexOf(oldChild)
        if (index >= 0) this.children[index] = child
        child.parentNode = this
        oldChild.parentNode = null
        return oldChild
      },
      addEventListener () {},
      querySelector (selector) {
        if (selector === '.file-tree-chevron') {
          const pending = this.children.slice()
          while (pending.length) {
            const child = pending.shift()
            if (child.className && child.className.split(/\s+/).includes('file-tree-chevron')) return child
            pending.push(...child.children || [])
          }
        }
        return null
      }
    }
  }

  const panel = treeElement()
  const uiStateDB = {
    getFileTreeState: async () => null,
    setFileTreeState: async () => {}
  }
  const context = vm.createContext({
    module: { exports: {} },
    document: {
      getElementById: () => panel,
      createElement: () => treeElement()
    },
    workspaces: {
      getSelected: () => ws,
      on (name, listener) { handlers[name] = listener }
    },
    tasks: { on () {} },
    window: { tasks: { getSelected: () => null } },
    tabs: { getSelected: () => null },
    CSS: { escape: value => value },
    ipc: {
      invoke (name, targetPath) {
        if (name === 'readDirectory') {
          readPaths.push(targetPath)
          return Promise.resolve([])
        }
        throw new Error('Unexpected IPC: ' + name)
      }
    },
    l: key => key,
    empty (target) { target.children = [] },
    require (name) {
      if (name === 'remoteMenuRenderer.js') return { open () {} }
      if (name === 'sidebar/fileIcons.js') return { pathPrefix: '', getIcon: () => '' }
      if (name === 'util/uiStateDB.js') return uiStateDB
      if (name === 'sidebar/ui.js') return { createPanelHeader: () => treeElement() }
      if (name === 'sidebar/lifecycle/debouncedWriter.js') return createDebouncedWriter
      if (name === 'editorView.js') return { getFilePath: () => null }
      throw new Error('Unexpected module: ' + name)
    }
  })

  vm.runInContext(source, context)
  context.module.exports.initialize()
  await wait(0)
  await wait(0)

  assert.deepEqual(readPaths, ['/repo'])
})
