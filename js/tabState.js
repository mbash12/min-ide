const WorkspaceList = require('tabState/workspace.js')

function initialize () {
  window.tasks = new WorkspaceList()
  window.workspaces = window.tasks
  window.WorkspaceList = WorkspaceList
  window.TaskList = WorkspaceList
  window.tabs = undefined
}

module.exports = { initialize }
