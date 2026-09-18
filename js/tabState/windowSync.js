const browserUI = require('browserUI.js')
const workspaceDrawer = require('workspaceDrawer/workspaceDrawer.js')
const webviews = require('webviews.js')
const editorView = require('editorView.js')

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

    /* Resolves the TaskList owning a task id, searching every workspace.
    Task/tab events carry only the task id, so this routes them to the
    right list regardless of which workspace is selected locally. */
    function getTaskList (taskId) {
      return workspaces.getTaskList(taskId)
    }

    ipc.on('tab-state-change-receive', function (e, data) {
      const { sourceWindowId, events } = data
      events.forEach(function (event) {
        const selectedTask = tasks.getSelected()
        const priorSelectedTask = selectedTask && selectedTask.id
        const priorSelectedWorkspace = workspaces.getSelected() && workspaces.getSelected().id

        // close window if its task is destroyed
        if (
          (event[0] === 'task-destroyed' && event[1] === priorSelectedTask) ||
          (event[0] === 'workspace-destroyed' && event[1] === priorSelectedWorkspace) ||
          (event[0] === 'tab-destroyed' && event[2] === priorSelectedTask && tasks.getSelected().tabs.count() === 1)
        ) {
          ipc.invoke('close')
          ipc.removeAllListeners('tab-state-change-receive')
          return
        }

        switch (event[0]) {
          case 'workspace-added':
            workspaces.add(event[2], event[3], false)
            break
          case 'workspace-selected':
            workspaces.setSelected(event[1], false, sourceWindowId)
            break
          case 'workspace-destroyed':
            workspaces.destroy(event[1], false)
            break
          case 'workspace-updated': {
            var wsObj = {}
            wsObj[event[2]] = event[3]
            workspaces.update(event[1], wsObj, false)
            // the workspace was archived by another window: destroy its views
            if (event[2] === 'archived') {
              const ws = workspaces.get(event[1])
              browserUI.splitView.clearAll()
              if (ws) {
                ws.tasks.forEach(function (task) {
                  task.tabs.get().forEach(function (tab) {
                    editorView.allowDiscard(tab.id)
                    webviews.destroy(tab.id)
                  })
                })
              }
            }
            break
          }
          case 'task-added': {
            const homeList = event[4] ? workspaces.get(event[4]).tasks : tasks
            homeList.add(event[2], event[3], false)
            break
          }
          case 'task-selected':
            getTaskList(event[1]).setSelected(event[1], false, sourceWindowId)
            break
          case 'task-destroyed':
            getTaskList(event[1]).destroy(event[1], false)
            break
          case 'task-moved': {
            const movedList = getTaskList(event[1])
            movedList.reorder(event[2], event[3])
            break
          }
          case 'tab-added':
            workspaces.findTask(event[4]).tabs.add(event[2], event[3], false)
            break
          case 'tab-updated': {
            var obj = {}
            obj[event[2]] = event[3]
            workspaces.findTask(event[4]).tabs.update(event[1], obj, false)
            break
          }
          case 'task-updated': {
            var taskObj = {}
            taskObj[event[2]] = event[3]
            getTaskList(event[1]).update(event[1], taskObj, false)
            break
          }
          case 'tab-selected':
            workspaces.findTask(event[2]).tabs.setSelected(event[1], false)
            break
          case 'tab-destroyed':
            workspaces.findTask(event[2]).tabs.destroy(event[1], false)
            break
          case 'tab-splice':
            workspaces.findTask(event[1]).tabs.spliceNoEmit(...event.slice(2))
            break
          case 'state-sync-change':
            break
          default:
            console.warn(arguments)
            throw new Error('unimplemented event')
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
          // our workspace was archived by another window; switch to an empty task
          // not open in any window, if possible
          var fallbackTaskCandidates = tasks.filter(task => task.tabs.isEmpty() && !task.selectedInWindow && !task.name)
            .sort((a, b) => {
              return tasks.getLastActivity(b.id) - tasks.getLastActivity(a.id)
            })
          if (fallbackTaskCandidates.length > 0) {
            browserUI.switchToTask(fallbackTaskCandidates[0].id)
          } else {
            browserUI.addTask()
          }
        }
        // if a tab was added or removed from our task, force a rerender
        if (
          (event[0] === 'tab-splice' && event[1] === priorSelectedTask) ||
          (event[0] === 'tab-destroyed' && event[2] === priorSelectedTask)
        ) {
          browserUI.switchToTask(tasks.getSelected().id)
          browserUI.switchToTab(tabs.getSelected())
        }
      })

      workspaces.emit('state-sync-change')
    })
  }
}
module.exports = windowSync
