const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred () {
  const result = {}
  result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }))
  return result
}

function load (file, globals) {
  const context = vm.createContext(Object.assign({ console, module: { exports: {} }, Map, Set }, globals))
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file })
  return context.module.exports
}
function storage (overrides = {}) {
  const values = new Map()
  const client = Object.assign({
    kvGet: async (scope, key) => values.get(key),
    kvSet: async (scope, key, value) => { values.set(key, value) },
    kvDelete: async (scope, key) => { values.delete(key) }
  }, overrides)
  const db = load('js/util/uiStateDB.js', { require: () => client })
  return { db, values }
}

test('concurrent recent searches retain every entry in recency order', async () => {
  const { db } = storage()
  await Promise.all(['a', 'b', 'c', 'a'].map(file => db.addRecentFileSearch(file)))
  assert.deepEqual(Array.from(await db.getRecentFileSearches()), ['a', 'c', 'b'])
})

test('workspace cleanup waits for its pending writes and writes capture call-time values', async () => {
  const gate = deferred()
  const operations = []
  const { db } = storage({
    kvSet: async (scope, key, value) => { await gate.promise; operations.push(['save', key, value.width]) },
    kvDelete: async (scope, key) => operations.push(['delete', key])
  })
  const state = { width: 200 }
  const save = db.setSidebarState('workspace:a', state)
  state.width = 500
  const cleanup = db.deleteWorkspaceState('a')
  gate.resolve()
  await Promise.all([save, cleanup])
  const related = operations.filter(op => op[1] === 'workspace:a')
  assert.deepEqual(related, [['save', 'workspace:a', 200], ['delete', 'workspace:a']])
})

test('workspace path checks ignore A -> B -> A replies and expire cached status', async () => {
  let now = 0
  const current = { id: 'a', path: '/a' }
  const pending = []
  const status = load('js/workspacePathStatus.js', {
    Date: { now: () => now },
    ipc: { invoke: () => { const result = deferred(); pending.push(result); return result.promise } },
    workspaces: { get: () => current, on () {}, getSelected: () => current },
    window: { addEventListener () {} }
  })
  const a = status.refresh(current)
  current.path = '/b'
  const b = status.refresh(current)
  current.path = '/a'
  const latest = status.refresh(current)
  pending[2].resolve({ ok: true })
  await latest
  pending[0].resolve({ ok: false })
  pending[1].resolve({ ok: false })
  await Promise.all([a, b])
  assert.equal(status.isUsable('a', '/a'), true)
  await status.refresh(current)
  assert.equal(pending.length, 3)
  now = 6000
  const expired = status.refresh(current)
  pending[3].resolve({ ok: false })
  await expired
  assert.equal(status.isUsable('a', '/a'), false)
})

function sidebarHarness () {
  const pending = []
  const writes = []
  let current = null
  const element = { style: {}, classList: { toggle () {}, add () {}, remove () {} }, querySelector: () => element, getBoundingClientRect: () => ({ width: 300 }) }
  const db = {
    getSidebarState: id => { const read = deferred(); pending.push({ id, read }); return read.promise },
    setSidebarState (id, state) { writes.push([id, state]) }
  }
  const pathStatus = { refresh () {}, isUsable () { return undefined } }
  const sidebar = load('js/sidebar.js', {
    require: name => {
      if (name === 'util/uiStateDB.js') return db
      if (name === 'workspacePathStatus.js') return pathStatus
      return { adjustMargin () {} }
    },
    workspaces: { getSelected: () => current },
    document: { getElementById: () => element, querySelectorAll: () => [] }
  })
  return {
    sidebar,
    pending,
    writes,
    select: workspace => {
      current = typeof workspace === 'object' ? workspace : { id: workspace }
      return sidebar.switchToWorkspace(current.id)
    }
  }
}

test('rapid sidebar switches and user edits reject stale restoration without flicker on revisits', async () => {
  const h = sidebarHarness()
  const first = h.select('a')
  const second = h.select('b')
  const last = h.select('a')
  h.pending[2].read.resolve({ activeTab: 'notes', isVisible: true, panelVisible: true, panelWidth: 340 })
  await last
  h.pending[0].read.resolve({ activeTab: 'git', isVisible: false })
  h.pending[1].read.resolve({ activeTab: 'docs', isVisible: false })
  await Promise.all([first, second])
  assert.equal(h.sidebar.activeTab, 'notes')
  const third = h.select('c')
  h.sidebar.show('ai')
  h.pending[3].read.resolve({ activeTab: 'docs' })
  await third
  assert.equal(h.sidebar.activeTab, 'ai')
  const revisit = h.select('a')
  // Restored from memory synchronously, with no transient default panel.
  assert.equal(h.sidebar.activeTab, 'notes')
  await revisit
  assert.equal(h.pending.length, 4)
})

test('path-tab fallback during workspace restore does not cancel the incoming saved layout', async () => {
  const h = sidebarHarness()
  const restoreA = h.select({ id: 'a', path: '/repo-a' })
  h.pending[0].read.resolve({ activeTab: 'files', isVisible: true, panelVisible: true, panelWidth: 350 })
  await restoreA

  const restoreB = h.select({ id: 'b', path: null })
  // The workspace-selected listener calls updatePathTabs immediately after
  // switchToWorkspace starts the async read. Its automatic fallback must not
  // overwrite B's state or invalidate that read.
  assert.equal(h.sidebar.updatePathTabs(), true)
  assert.equal(h.sidebar.activeTab, 'ai')
  assert.deepEqual(h.writes.map(([key]) => key), ['workspace:a'])

  h.pending[1].read.resolve({ activeTab: 'notes', isVisible: false, panelVisible: false, panelWidth: 440 })
  await restoreB
  assert.equal(h.sidebar.activeTab, 'notes')
  assert.equal(h.sidebar.isVisible, false)
  assert.equal(h.sidebar.panelVisible, false)
  assert.equal(h.sidebar.getState().panelWidth, 440)
})
