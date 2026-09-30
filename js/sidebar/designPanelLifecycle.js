/* Coalesce same-scope panel reads and prevent superseded work from publishing. */

function createDesignPanelLifecycle () {
  const active = new Map()
  let requestRevision = 0

  function keyFor (scope) {
    return typeof scope === 'string' ? scope : JSON.stringify(scope == null ? null : scope)
  }

  function isCurrent (slot, request, isScopeCurrent) {
    return active.get(slot) === request && (!isScopeCurrent || isScopeCurrent())
  }

  function refresh (slot, scope, operation, isScopeCurrent) {
    const scopeKey = keyFor(scope)
    const current = active.get(slot)
    if (current && current.scopeKey === scopeKey) return current.promise

    const request = { scopeKey: scopeKey, revision: ++requestRevision, promise: null }
    active.set(slot, request)
    request.promise = Promise.resolve().then(operation).then(function (value) {
      return { value: value, current: isCurrent(slot, request, isScopeCurrent) }
    }, function (error) {
      return { error: error, current: isCurrent(slot, request, isScopeCurrent) }
    }).finally(function () {
      if (active.get(slot) === request) active.delete(slot)
    })
    return request.promise
  }

  function invalidate (slot) {
    if (arguments.length) active.delete(slot)
    else active.clear()
    requestRevision++
  }

  return { refresh: refresh, invalidate: invalidate }
}

module.exports = createDesignPanelLifecycle
