const WorkspaceStore = require('tabState/workspace.js')
const TaskList = require('tabState/task.js')

function initialize () {
  // The workspace store owns all workspaces and is a stable reference.
  // window.tasks is re-pointed to the selected workspace's TaskList on
  // every workspace switch (see WorkspaceStore.setSelected), so
  // selected-only call sites keep working unchanged.
  window.workspaces = new WorkspaceStore()
  window.tasks = null
  window.WorkspaceStore = WorkspaceStore
  window.WorkspaceList = WorkspaceStore
  window.TaskList = TaskList
  window.tabs = undefined
}

module.exports = { initialize }
