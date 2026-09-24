/* Async request coalescing and stale-result protection for Pro Settings. */
(function (root) {
  root.createSettingsLifecycle = function () {
    const active = new Map()
    let revision = 0

    function refresh (slot, scope, operation, isScopeCurrent) {
      const key = JSON.stringify(scope == null ? null : scope)
      const existing = active.get(slot)
      if (existing && existing.key === key) return existing.promise

      const request = { key: key, revision: ++revision, promise: null }
      active.set(slot, request)
      request.promise = Promise.resolve().then(operation).then(function (value) {
        return {
          value: value,
          current: active.get(slot) === request && (!isScopeCurrent || isScopeCurrent())
        }
      }, function (error) {
        return {
          error: error,
          current: active.get(slot) === request && (!isScopeCurrent || isScopeCurrent())
        }
      }).finally(function () {
        if (active.get(slot) === request) active.delete(slot)
      })
      return request.promise
    }

    function invalidate (slot) {
      if (arguments.length) active.delete(slot)
      else active.clear()
      revision++
    }

    return { refresh: refresh, invalidate: invalidate }
  }
})(window)
