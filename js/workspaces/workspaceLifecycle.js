/* global ipc */
module.exports = function ({ workspaces, splitView, editorView, webviews, confirmDiscardTabs, switchToWorkspace }) {
  /* creates a new workspace: one Workspace record owning one initial task */

  function addWorkspace (workspace) {
    workspace = workspace || {}
    const id = workspaces.add(workspace)
    switchToWorkspace(id)
    return id
  }

  /* what deleting a workspace takes with it, so the confirmation can say so */

  function summarizeWorkspace (id) {
    var ws = workspaces.get(id)
    if (!ws) {
      return null
    }
    var tabs = ws.tasks.map(task => task.tabs.get()).reduce((all, arr) => all.concat(arr), [])
    return {
      tasks: ws.tasks.getLength(),
      tabs: tabs.length,
      terminals: tabs.filter(tab => tab.kind === 'terminal').length
    }
  }

  /* destroys a workspace: all of its tasks, views and workspace-scoped state */

  function closeWorkspace (id) {
    var ws = workspaces.get(id)
    if (!ws) {
      return false
    }

    const wasSelected = workspaces.getSelected() && workspaces.getSelected().id === id

    if (!confirmDiscardTabs(ws.tasks.map(task => task.tabs.get()).reduce((all, arr) => all.concat(arr), []))) {
      return false
    }

    if (wasSelected) splitView.clearAll()

    ws.tasks.forEach(function (task) {
      ipc.send('agent-destroy-task-session', { taskId: task.id })
      task.tabs.get().forEach(function (tab) {
        editorView.allowDiscard(tab.id)
        webviews.destroy(tab.id)
      })
    })

    var taskIds = ws.tasks.map(function (task) { return task.id })

    workspaces.destroy(id)
    removeWorkspaceState(id, taskIds)

    if (wasSelected) {
      const remaining = workspaces.getActive()
      if (remaining.length > 0) {
        const mostRecent = remaining.sort(function (a, b) {
          return workspaces.getLastActivity(b.id) - workspaces.getLastActivity(a.id)
        })[0]
        return switchToWorkspace(mostRecent.id)
      } else {
        return addWorkspace()
      }
    }
  }

  /* removes workspace-scoped persisted state (sidebar, tree, git, docs, agents) */
  function removeWorkspaceState (id, taskIds) {
    try {
      var uiStateDB = require('util/uiStateDB.js')
      if (uiStateDB.deleteWorkspaceState) {
        uiStateDB.deleteWorkspaceState(id)
      }
    } catch (e) {}
    try {
      var customDataStore = require('util/customDataStore.js')
      if (customDataStore.deleteWorkspaceDocuments) {
        customDataStore.deleteWorkspaceDocuments(id)
      }
    } catch (e) {}
    ipc.send('agent-destroy-workspace-sessions', { workspaceId: id, taskIds: taskIds || [] })
  }

  /* archives a workspace: switches away from it if it is open, stops its agent
  sessions, destroys all of its views to free memory, and marks it as archived
  so it no longer appears in the regular workspace list. Its state (including
  activeTaskId) is kept so it can be restored later. */

  function archiveWorkspace (id) {
    var ws = workspaces.get(id)
    if (!ws || ws.archived) {
      return false
    }

    const allTabs = ws.tasks.map(task => task.tabs.get()).reduce((all, arr) => all.concat(arr), [])
    if (!confirmDiscardTabs(allTabs)) {
      return false
    }

    // if this workspace is open in the current window, switch away from it first

    if (workspaces.getSelected() && workspaces.getSelected().id === id) {
      var remainingWorkspaces = workspaces.getActive().filter(function (w) {
        return w.id !== id
      })

      if (remainingWorkspaces.length > 0) {
        var mostRecent = remainingWorkspaces.sort(function (a, b) {
          return workspaces.getLastActivity(b.id) - workspaces.getLastActivity(a.id)
        })[0]

        switchToWorkspace(mostRecent.id)
      } else {
        addWorkspace()
      }
    }

    // stop every agent session in the workspace
    ws.tasks.forEach(function (task) {
      ipc.send('agent-destroy-task-session', { taskId: task.id })
    })

    workspaces.update(id, { archived: true })

    // free the memory used by the workspace's views; they are recreated lazily when the workspace is restored

    workspaces.get(id).tasks.forEach(function (task) {
      task.tabs.get().forEach(function (tab) {
        editorView.allowDiscard(tab.id)
        webviews.destroy(tab.id)
      })
    })
    return true
  }

  /* restores an archived workspace and switches back to its last active task */

  function restoreWorkspace (id, options) {
    var ws = workspaces.get(id)
    if (!ws || !ws.archived) {
      return
    }

    workspaces.update(id, { archived: false })

    switchToWorkspace(id, options)
  }

  return { addWorkspace, summarizeWorkspace, closeWorkspace, removeWorkspaceState, archiveWorkspace, restoreWorkspace }
}
