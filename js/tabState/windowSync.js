const browserUI = require('browserUI.js')
const workspaceDrawer = require('workspaceDrawer/workspaceDrawer.js')
const webviews = require('webviews.js')
const editorView = require('editorView.js')
const applyWindowEvent = require('tabState/applyWindowEvent.js')

const windowSync = {

  pendingEvents: [],
  syncTimeout: null,
  sendEvents: function () {
    ipc.send('tab-state-change', windowSync.pendingEvents)
    windowSync.pendingEvents = []
    windowSync.syncTimeout = null
  },
  initialize: function () {
    // Workspace-level events come from the stable store; task/tab events
    // arrive via the store forwarder (see wireTaskEvents) with their exact
    // upstream payload shapes.
    workspaces.on('*', function (...data) {
      if (data[0] === 'state-sync-change') {
        return
      }
      // multi-select is a window-local UI state, don't sync it to other windows
      if (data[0] === 'tab-multi-selected' || data[0] === 'tab-multi-selection-cleared') {
        return
      }
      windowSync.pendingEvents.push(data)
      if (!windowSync.syncTimeout) {
        windowSync.syncTimeout = setTimeout(windowSync.sendEvents, 0)
      }
    })

    ipc.on('tab-state-change-receive', function (e, data) {
      const { sourceWindowId, events } = data
      const refreshTasks = new Set()
      for (const event of events) {
        const selectedTask = tasks.getSelected()
        const priorSelectedTask = selectedTask && selectedTask.id
        const priorSelectedWorkspace = workspaces.getSelected() && workspaces.getSelected().id

        // close window if its task is destroyed
        if (
          (event[0] === 'task-destroyed' && event[1] === priorSelectedTask) ||
          (event[0] === 'workspace-destroyed' && event[1] === priorSelectedWorkspace) ||
          (event[0] === 'tab-destroyed' && event[2] === priorSelectedTask && selectedTask && selectedTask.tabs.count() === 1 && selectedTask.tabs.has(event[1]))
        ) {
          ipc.invoke('close')
          ipc.removeAllListeners('tab-state-change-receive')
          return
        }

        applyWindowEvent(workspaces, event, sourceWindowId, tasks)
        if (event[0] === 'workspace-updated' && event[2] === 'archived' && event[3] === true) {
          const ws = workspaces.get(event[1])
          if (ws) {
            if (ws.id === priorSelectedWorkspace) browserUI.splitView.clearAll()
            ws.tasks.forEach(task => task.tabs.forEach(tab => {
              editorView.allowDiscard(tab.id)
              webviews.destroy(tab.id)
            }))
          }
        }

        // UI updates

        if (event[0] === 'task-selected' && event[1] === priorSelectedTask) {
          // our task is being taken by another window
          // switch to an empty task not open in any window, if possible
          var newTaskCandidates = tasks.filter(task => task.tabs.isEmpty() && !task.selectedInWindow && !task.name)
            .sort((a, b) => {
              return tasks.getLastActivity(b.id) - tasks.getLastActivity(a.id)
            })
          if (newTaskCandidates.length > 0) {
            browserUI.switchToTask(newTaskCandidates[0].id)
          } else {
            browserUI.addTask()
          }
          workspaceDrawer.show()
        }
        if (event[0] === 'workspace-selected' && event[1] === priorSelectedWorkspace) {
          // our workspace is being taken by another window; the task-level
          // steal handling above covers the task itself
          workspaceDrawer.show()
        }
        if (event[0] === 'workspace-updated' && event[2] === 'archived' && event[3] === true && event[1] === priorSelectedWorkspace) {
          const remaining = workspaces.getActive().sort((a, b) => workspaces.getLastActivity(b.id) - workspaces.getLastActivity(a.id))
          if (remaining.length) browserUI.switchToWorkspace(remaining[0].id)
          else browserUI.addWorkspace()
        }

        // if a tab was added or removed from our task, force a rerender
        if (
          selectedTask &&
          ((event[0] === 'tab-added' && event[4] === priorSelectedTask) ||
          (event[0] === 'tab-splice' && event[1] === priorSelectedTask) ||
          (event[0] === 'tab-destroyed' && event[2] === priorSelectedTask))
        ) {
          refreshTasks.add(selectedTask.id)
        }
      }
      const selected = tasks.getSelected()
      if (selected && refreshTasks.has(selected.id)) {
        browserUI.switchToTask(selected.id, { focusWebview: false })
      }
      workspaces.emit('state-sync-change')
    })
  }
}
module.exports = windowSync
