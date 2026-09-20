const WorkspaceStore = require('tabState/workspace.js')
const TaskList = require('tabState/task.js')

function initialize () {
  // The workspace store owns all workspaces and is a stable reference.
  // window.tasks is a stable facade over the selected workspace's TaskList:
  // members delegate at call time, so task-scoped call sites keep working
  // across workspace switches without re-pointing or re-subscribing.
  window.workspaces = new WorkspaceStore()
  /* Modules may touch window.tasks before the first workspace is selected,
  so the facade falls back to an empty TaskList - same contract as the old
  throwaway seed, except event subscriptions go to the store and are never
  lost. */
  const emptyTaskList = new TaskList()
  window.tasks = new Proxy({}, {
    get: function (_, prop) {
      if (prop === 'on') {
        /* TaskList events are forwarded to the store by wireTaskEvents with
        identical payloads, so subscribing at store level follows the active
        workspace automatically instead of going stale on every switch. */
        return function (name, fn) { return window.workspaces.on(name, fn) }
      }
      const ws = window.workspaces.getSelected()
      const list = (ws && ws.tasks) || emptyTaskList
      const value = list[prop]
      return typeof value === 'function' ? value.bind(list) : value
    },
    set: function (_, prop, value) {
      const ws = window.workspaces.getSelected()
      if (ws) ws.tasks[prop] = value
      return true
    }
  })
  window.WorkspaceStore = WorkspaceStore
  window.WorkspaceList = WorkspaceStore
  window.TaskList = TaskList
  window.tabs = undefined
}

module.exports = { initialize }
