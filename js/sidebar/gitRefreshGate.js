/* Coalesces refresh requests for one workspace while invalidating stale reads. */

module.exports = function createGitRefreshGate () {
  var active = null

  function run (key, refresh) {
    if (active && active.key === key) {
      active.pending = true
      active.revision++
      return active.promise
    }

    var task = { key: key, pending: true, revision: 0, promise: null }
    active = task
    task.promise = (async function () {
      while (task.pending) {
        if (active !== task) break
        task.pending = false
        var revision = ++task.revision
        var isCurrent = function () { return active === task && task.revision === revision }
        await refresh(isCurrent)
        if (!task.pending) break
      }
    })().finally(function () {
      if (active === task) active = null
    })
    return task.promise
  }

  function invalidate () {
    active = null
  }

  return { run: run, invalidate: invalidate }
}
