const test = require('node:test')
const assert = require('node:assert/strict')
const createDesignPanelLifecycle = require('../js/sidebar/designPanelLifecycle.js')
const createDesignPanelExport = require('../js/sidebar/designPanelExport.js')

function deferred () {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise(function (resolve, reject) {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise: promise, resolve: resolveDeferred, reject: rejectDeferred }
}

test('same-scope panel refreshes share one request', async () => {
  const lifecycle = createDesignPanelLifecycle()
  const pending = deferred()
  let calls = 0
  const first = lifecycle.refresh('status', 'tab-1/file-a', function () {
    calls++
    return pending.promise
  })
  const duplicate = lifecycle.refresh('status', 'tab-1/file-a', function () {
    calls++
    return 'unexpected second request'
  })
  assert.equal(duplicate, first)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve('current')
  assert.deepEqual(await first, { value: 'current', current: true })
})

test('older responses cannot commit after A to B to A context switches', async () => {
  const lifecycle = createDesignPanelLifecycle()
  const requests = []
  let currentScope = 'A'
  function refresh (scope) {
    const pending = deferred()
    requests.push(pending)
    return lifecycle.refresh('overlay', scope, function () { return pending.promise }, function () {
      return currentScope === scope
    })
  }

  const firstA = refresh('A')
  currentScope = 'B'
  const fromB = refresh('B')
  currentScope = 'A'
  const secondA = refresh('A')
  await Promise.resolve()
  requests[0].resolve('old A')
  requests[1].resolve('B')
  requests[2].resolve('new A')
  assert.equal((await firstA).current, false)
  assert.equal((await fromB).current, false)
  assert.deepEqual(await secondA, { value: 'new A', current: true })
})

test('invalidating an in-flight result makes it stale even if the scope key returns', async () => {
  const lifecycle = createDesignPanelLifecycle()
  const pending = deferred()
  const first = lifecycle.refresh('spec', 'workspace-a/path-a', function () { return pending.promise })
  lifecycle.invalidate('spec')
  const second = lifecycle.refresh('spec', 'workspace-a/path-a', function () { return 'fresh' })
  pending.resolve('stale')
  assert.equal((await first).current, false)
  assert.deepEqual(await second, { value: 'fresh', current: true })
})

test('export preferences coalesce by context and ignore a folder response after a switch', async () => {
  const pending = deferred()
  const contextA = { revision: 1, workspaceId: 'a', workspacePath: '/a', tabId: 'tab-a', url: 'figma-a' }
  let currentContext = contextA
  let preferenceCalls = 0
  const controller = createDesignPanelExport({
    ipc: { invoke () { preferenceCalls++; return pending.promise } },
    isContextCurrent: context => lifecycleContextCurrent(context, currentContext),
    getContext: () => currentContext,
    render () {},
    isBusy: () => false,
    isReady: () => true,
    getNodeId: () => '1:1',
    getParsed: () => ({ fileKey: 'file-a' }),
    designCommand: async () => ({ ok: true }),
    setError () {},
    setResult () {},
    el () {},
    t: (key, fallback) => fallback
  })
  const first = controller.loadPrefs(contextA)
  const duplicate = controller.loadPrefs(contextA)
  await Promise.resolve()
  assert.equal(preferenceCalls, 1)
  currentContext = { revision: 2, workspaceId: 'b', workspacePath: '/b', tabId: 'tab-b', url: 'figma-b' }
  pending.resolve({ effective: '/a/exports' })
  assert.equal(await first, false)
  assert.equal(await duplicate, false)
  assert.equal(controller.state.dir, '')
})

function lifecycleContextCurrent (context, current) {
  return context.revision === current.revision && context.workspacePath === current.workspacePath && context.tabId === current.tabId
}
