/* Small, dependency-injected pieces of the agent panel lifecycle. */

function scopeKey (scope) {
  scope = scope || {}
  return JSON.stringify([
    scope.workspaceId || 'default',
    scope.taskId || 'default',
    scope.cwd || null
  ])
}

function createScopeLoader (options) {
  options = options || {}
  let activeKey = null
  let selectionRevision = 0
  const latestByScope = new Map()
  const inFlight = new Map()

  function select (scope) {
    const key = (options.keyFor || scopeKey)(scope)
    const changed = key !== activeKey
    if (changed) {
      activeKey = key
      selectionRevision++
      if (options.onSelect) options.onSelect(scope, key)
    }
    return { key: key, revision: selectionRevision, changed: changed }
  }

  function isCurrent (scope, selection) {
    const key = (options.keyFor || scopeKey)(scope)
    return key === activeKey && (!selection || selection.revision === selectionRevision)
  }

  function refresh (scope) {
    const selection = select(scope)
    const requestKey = selection.key + '\u0000' + selection.revision
    if (inFlight.has(requestKey)) return inFlight.get(requestKey)

    const version = (latestByScope.get(selection.key) || 0) + 1
    latestByScope.set(selection.key, version)
    const promise = Promise.resolve().then(function () {
      return options.load(scope)
    }).then(function (state) {
      if (!state || latestByScope.get(selection.key) !== version) return state
      if (options.onResult) {
        options.onResult(scope, state, isCurrent(scope, selection), selection)
      }
      return state
    }).finally(function () {
      if (inFlight.get(requestKey) === promise) inFlight.delete(requestKey)
    })
    inFlight.set(requestKey, promise)
    return promise
  }

  return { select: select, refresh: refresh, isCurrent: isCurrent }
}

function createLatestRequestGuard () {
  let revision = 0
  return {
    next: function () { return ++revision },
    isCurrent: function (token) { return token === revision },
    invalidate: function () { revision++ }
  }
}

function createStreamingRenderer (options) {
  options = options || {}
  const scheduleTimeout = options.setTimeout || setTimeout
  const cancelTimeout = options.clearTimeout || clearTimeout
  const delay = options.delay == null ? 100 : options.delay
  let timer = null
  let element = null
  let text = ''
  let revision = 0

  function clear () {
    if (timer) cancelTimeout(timer)
    timer = null
  }

  function render (scroll) {
    const target = element
    const value = text
    if (!target) return
    options.render(target, value)
    if (scroll && options.scroll) options.scroll()
  }

  function schedule (target, value) {
    element = target
    text = value
    if (timer) return
    const scheduledRevision = revision
    timer = scheduleTimeout(function () {
      timer = null
      if (scheduledRevision !== revision) return
      render(true)
    }, delay)
  }

  function flush () {
    clear()
    render(false)
    element = null
    text = ''
  }

  function cancel () {
    clear()
    revision++
    element = null
    text = ''
  }

  return { schedule: schedule, flush: flush, cancel: cancel }
}

module.exports = {
  scopeKey: scopeKey,
  createScopeLoader: createScopeLoader,
  createLatestRequestGuard: createLatestRequestGuard,
  createStreamingRenderer: createStreamingRenderer
}
