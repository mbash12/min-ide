const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')

function harness () {
  const timers = new Map()
  let nextTimer = 0
  const cache = new Map()
  const scope = vm.createContext({ console, windowId: 1, Map, Set, window: {}, setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout: id => timers.delete(id) })
  function load (name) {
    if (cache.has(name)) return cache.get(name).exports
    const module = { exports: {} }
    cache.set(name, module)
    const factory = vm.runInContext('(function(require,module,exports){' + fs.readFileSync(path.join(__dirname, '../js', name), 'utf8') + '\n})', scope, { filename: name })
    factory(load, module, module.exports)
    return module.exports
  }
  function flush () {
    let rounds = 0
    while (timers.size) {
      assert.ok(rounds++ < 100, 'event queue must settle')
      const batch = Array.from(timers.values())
      timers.clear()
      batch.forEach(fn => fn())
    }
  }
  const Store = load('tabState/workspace.js')
  const store = new Store()
  return { store, scope, flush, load }
}

function workspace (h, id, taskId = id + '-task') {
  h.store.add({ id, tasks: [{ id: taskId, tabs: [{ id: id + '-tab', url: '', selected: true }] }] }, undefined, false)
  return h.store.get(id)
}

test('ownership stays current before event delivery, including cross-workspace moves and destruction', () => {
  const h = harness()
  const a = workspace(h, 'a')
  const b = workspace(h, 'b')
  const source = a.tasks.byIndex(0)
  const target = b.tasks.byIndex(0)
  const id = source.tabs.add({ id: 'new' }, { atEnd: true })
  assert.equal(h.store.findTaskContainingTab(id), source)
  const moved = source.tabs.splice(1, 1)[0]
  target.tabs.splice(0, 0, moved)
  assert.equal(h.store.findWorkspaceContainingTab(id), b)
  assert.equal(a.tasks.getTaskContainingTab(id), null)
  assert.equal(b.tasks.getTaskContainingTab(id), target)
  target.tabs.destroy(id)
  assert.equal(h.store.findTaskContainingTab(id), null)
  h.store.destroy('b')
  assert.equal(h.store.findTask('b-task'), null)
  assert.equal(h.store.findTaskContainingTab('b-tab'), null)
  assert.equal(h.store.findTask('a-task'), source)
})

test('task events survive reentrant emissions and unsubscribe cancels deferred listeners', () => {
  const h = harness()
  const ws = workspace(h, 'a')
  const seen = []
  ws.tasks.on('first', () => { seen.push('first'); ws.tasks.emit('second') })
  ws.tasks.on('second', () => seen.push('second'))
  const off = ws.tasks.on('first', () => seen.push('cancelled'))
  ws.tasks.emit('first')
  off()
  h.flush()
  assert.deepEqual(seen, ['first', 'second'])
})

test('destroyed workspaces cancel pending events and repeated destruction is harmless', () => {
  const h = harness()
  const ws = workspace(h, 'a')
  const seen = []
  h.store.on('*', name => seen.push(name))
  ws.tasks.add({ id: 'pending' })
  h.store.destroy(ws.id)
  h.flush()
  assert.equal(seen.includes('task-added'), false)
  assert.equal(h.store.destroy(ws.id), false)
  assert.equal(ws.tasks.destroy('missing'), false)
})

test('remote workspace creation restores tasks and routes background task additions to their owner', () => {
  const h = harness()
  const remote = harness()
  const a = workspace(h, 'a')
  workspace(remote, 'selected')
  remote.store.setSelected('selected', false)
  const events = []
  h.store.on('*', (...event) => events.push(event))
  h.store.add({ id: 'full', tasks: [{ id: 'restored', tabs: [{ id: 'restored-tab' }] }] })
  a.tasks.add({ id: 'background' }, 0)
  h.flush()
  const apply = remote.load('tabState/applyWindowEvent.js')
  workspace(remote, 'a')
  events.forEach(event => apply(remote.store, event, 2, remote.store.get('selected').tasks))
  assert.equal(remote.store.findWorkspaceContainingTab('restored-tab').id, 'full')
  assert.equal(remote.store.findWorkspaceContainingTask('background').id, 'a')
  assert.equal(remote.store.get('a').tasks.byIndex(0).id, 'background')
  // Replayed creation packets cannot duplicate records.
  events.forEach(event => apply(remote.store, event, 2, remote.store.get('selected').tasks))
  assert.equal(remote.store.get('a').tasks.getLength(), 2)
})

test('remote reorders do not echo and stale tab events do not abort later updates', () => {
  const h = harness()
  const ws = workspace(h, 'a')
  ws.tasks.add({ id: 'second' }, undefined, false)
  const events = []
  h.store.on('*', (...event) => events.push(event))
  const apply = h.load('tabState/applyWindowEvent.js')
  for (const event of [
    ['task-moved', 'second', 1, 0],
    ['tab-updated', 'gone', 'title', 'late', 'a-task'],
    ['tab-selected', 'gone', 'a-task'],
    ['task-added', 'orphan', { id: 'orphan' }, 0, 'removed-workspace'],
    ['tab-updated', 'a-tab', 'title', 'current', 'a-task']
  ]) apply(h.store, event, 2, ws.tasks)
  h.flush()
  assert.equal(ws.tasks.byIndex(0).id, 'second')
  assert.equal(ws.tasks.get('a-task').tabs.get('a-tab').title, 'current')
  assert.equal(h.store.findTask('orphan'), null)
  assert.deepEqual(events, [])
})

test('many-workspace ownership and tab updates never scan unrelated tasks or tabs', () => {
  const h = harness()
  for (let w = 0; w < 100; w++) {
    const tasks = Array.from({ length: 10 }, (_, t) => ({ id: w + ':' + t, tabs: Array.from({ length: 20 }, (_, i) => ({ id: w + ':' + t + ':' + i })) }))
    h.store.add({ id: String(w), tasks }, undefined, false)
  }
  h.store.find = () => { throw new Error('linear workspace lookup') }
  h.store.forEach(ws => {
    ws.tasks.find = () => { throw new Error('linear task lookup') }
    ws.tasks.forEach(task => { task.tabs.getIndex = () => { throw new Error('linear tab lookup') } })
  })
  for (let i = 0; i < 2000; i++) {
    const id = (i % 100) + ':9:19'
    const task = h.store.findTaskContainingTab(id)
    task.tabs.update(id, { title: String(i) }, false)
    assert.equal(task.tabs.get(id).title, String(i))
  }
})

test('cancelling workspace close keeps agent sessions and native views alive', () => {
  const h = harness()
  const calls = []
  const ws = workspace(h, 'a')
  h.scope.ipc = { send: (...args) => calls.push(args) }
  const lifecycle = h.load('workspaces/workspaceLifecycle.js')({
    workspaces: h.store,
    splitView: { clearAll: () => calls.push('clear') },
    editorView: { allowDiscard () {} },
    webviews: { destroy: id => calls.push(id) },
    confirmDiscardTabs: () => false,
    switchToWorkspace () {}
  })
  assert.equal(lifecycle.closeWorkspace('a'), false)
  assert.equal(h.store.get('a'), ws)
  assert.deepEqual(calls, [])
})

test('archiving a background workspace leaves the active split layout attached', () => {
  const h = harness()
  const calls = []
  workspace(h, 'active')
  const ws = workspace(h, 'background')
  h.store.setSelected('active', false)
  h.scope.ipc = { send: (...args) => calls.push(args) }
  const lifecycle = h.load('workspaces/workspaceLifecycle.js')({
    workspaces: h.store,
    splitView: { clearAll: () => calls.push('clear') },
    editorView: { allowDiscard () {} },
    webviews: { destroy: id => calls.push(id) },
    confirmDiscardTabs: () => true,
    switchToWorkspace: () => calls.push('switch')
  })
  assert.equal(lifecycle.archiveWorkspace(ws.id), true)
  assert.equal(ws.archived, true)
  assert.equal(calls.includes('clear'), false)
  assert.equal(calls.includes('switch'), false)
})

test('session snapshots exclude private tabs without mutating the live session', () => {
  const h = harness()
  const ws = workspace(h, 'a')
  const task = ws.tasks.byIndex(0)
  task.tabs.add({ id: 'private', private: true }, { atEnd: true }, false)
  const snapshot = h.load('tabState/sessionSnapshot.js')
  assert.equal(snapshot(h.store, 1).workspaces[0].tasks[0].tabs.length, 1)
  task.selectedInWindow = 1
  assert.equal(snapshot(h.store, 3).workspaces[0].tasks[0].tabs.length, 0)
  assert.equal(task.tabs.count(), 2)
})
