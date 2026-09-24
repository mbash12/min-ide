/* Debounced, workspace-owned writes for the Git panel state. A captured batch
   checks ownership again when it reaches the write queue so deletion cannot
   resurrect a key after workspace cleanup. */

module.exports = function createGitStatePersistence (options) {
  var uiStateDB = options.uiStateDB
  var workspaces = options.workspaces
  var getCurrentWorkspaceId = options.getCurrentWorkspaceId
  var delay = options.delay == null ? 150 : options.delay
  var timer = null
  var revision = 0
  var pending = new Map()
  var writeChain = Promise.resolve()
  var destroyedWorkspaceIds = new Set()

  function normalizedId (workspaceId) {
    return workspaceId == null || workspaceId === '' ? null : String(workspaceId)
  }

  function keyFor (workspaceId) {
    return 'git:' + workspaceId
  }

  function isWritable (workspaceId) {
    var id = normalizedId(workspaceId)
    return !!id && !destroyedWorkspaceIds.has(id) && !!workspaces.get(id)
  }

  function schedule () {
    if (!timer) timer = setTimeout(flush, delay)
  }

  function flush () {
    if (timer) clearTimeout(timer)
    timer = null
    var writes = Array.from(pending.entries())
    pending.clear()
    if (writes.length) {
      writeChain = writeChain.then(function () {
        return Promise.all(writes.map(function (entry) {
          var workspaceId = entry[0].slice('git:'.length)
          if (!isWritable(workspaceId)) return null
          return uiStateDB.setGitPanelState(entry[0], entry[1])
        }))
      }).catch(function () {})
    }
    if (pending.size) schedule()
    return writeChain
  }

  function persist (workspaceId, snapshot) {
    var id = normalizedId(workspaceId)
    if (!isWritable(id)) return false
    revision++
    pending.set(keyFor(id), snapshot)
    schedule()
    return true
  }

  function invalidateWorkspace (workspaceId) {
    var id = normalizedId(workspaceId)
    if (!id) return
    destroyedWorkspaceIds.add(id)
    pending.delete(keyFor(id))
    if (!pending.size && timer) {
      clearTimeout(timer)
      timer = null
    }
    if (normalizedId(getCurrentWorkspaceId()) === id) revision++
  }

  function workspaceAdded (workspaceId) {
    var id = normalizedId(workspaceId)
    if (id) destroyedWorkspaceIds.delete(id)
  }

  return {
    persist: persist,
    flush: flush,
    invalidateWorkspace: invalidateWorkspace,
    workspaceAdded: workspaceAdded,
    isWritable: isWritable,
    getRevision: function () { return revision }
  }
}
