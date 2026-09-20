/* Task-scoped preferences (HANDOVER §2): a small JSON key/value store carried
on the task record as `task.prefs`, so it persists with the workspace through
session restore and travels with archive/restore like any other task field.
Values must be JSON-serializable; set a key to null/undefined to remove it. */

const taskPrefs = {
  get: function (taskId, key) {
    if (typeof workspaces === 'undefined') {
      return undefined
    }
    const task = workspaces.findTask(taskId)
    return (task && task.prefs) ? task.prefs[key] : undefined
  },

  /* returns the whole prefs object for a task (a copy is not made - treat it
  as read-only and write through set) */
  getAll: function (taskId) {
    if (typeof workspaces === 'undefined') {
      return {}
    }
    const task = workspaces.findTask(taskId)
    return (task && task.prefs) || {}
  },

  set: function (taskId, key, value) {
    const ws = typeof workspaces !== 'undefined' && workspaces.findWorkspaceContainingTask(taskId)
    if (!ws) {
      return false
    }
    const task = ws.tasks.get(taskId)
    const prefs = Object.assign({}, task.prefs)
    if (value === undefined || value === null) {
      delete prefs[key]
    } else {
      prefs[key] = value
    }
    ws.tasks.update(taskId, { prefs: Object.keys(prefs).length > 0 ? prefs : null })
    return true
  }
}

module.exports = taskPrefs
