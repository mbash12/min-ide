const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred () {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise(function (resolve, reject) {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise: promise, resolve: resolveDeferred, reject: rejectDeferred }
}

function createLifecycle () {
  const context = vm.createContext({ window: {} })
  const source = fs.readFileSync(path.join(__dirname, '../pages/proSettings/settingsLifecycle.js'), 'utf8')
  vm.runInContext(source, context)
  return context.window.createSettingsLifecycle()
}

test('Pro Settings coalesces matching model and status requests', async () => {
  const lifecycle = createLifecycle()
  const pendingModels = deferred()
  const pendingStatus = deferred()
  let modelsCalls = 0
  let statusCalls = 0
  const models = lifecycle.refresh('models', 4, function () { modelsCalls++; return pendingModels.promise })
  const sameModels = lifecycle.refresh('models', 4, function () { modelsCalls++; return [] })
  const status = lifecycle.refresh('figma-status', 'global', function () { statusCalls++; return pendingStatus.promise })
  const sameStatus = lifecycle.refresh('figma-status', 'global', function () { statusCalls++; return null })
  assert.equal(sameModels, models)
  assert.equal(sameStatus, status)
  await Promise.resolve()
  assert.equal(modelsCalls, 1)
  assert.equal(statusCalls, 1)
  pendingModels.resolve(['model'])
  pendingStatus.resolve({ processRunning: true, windowVisible: false })
  assert.equal((await models).current, true)
  assert.equal((await status).value.windowVisible, false)
})

test('provider changes invalidate late catalog results while engine status remains independent', async () => {
  const lifecycle = createLifecycle()
  const oldModels = deferred()
  const currentModels = deferred()
  const oldStatus = deferred()
  let configRevision = 1
  const staleCatalog = lifecycle.refresh('models', configRevision, function () { return oldModels.promise }, function () {
    return configRevision === 1
  })
  const status = lifecycle.refresh('figma-status', 'global', function () { return oldStatus.promise })

  configRevision = 2
  lifecycle.invalidate('models')
  const freshCatalog = lifecycle.refresh('models', configRevision, function () { return currentModels.promise }, function () {
    return configRevision === 2
  })
  oldModels.resolve(['stale'])
  currentModels.resolve(['fresh'])
  oldStatus.resolve({ processRunning: true, windowVisible: true })
  assert.equal((await staleCatalog).current, false)
  assert.deepEqual(Array.from((await freshCatalog).value), ['fresh'])
  assert.equal((await status).current, true)
})
