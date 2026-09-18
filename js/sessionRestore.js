var browserUI = require('browserUI.js')
var webviews = require('webviews.js')
var tabEditor = require('navbar/tabEditor.js')
var tabState = require('tabState.js')
var settings = require('util/settings/settings.js')
var workspaceDrawer = require('workspaceDrawer/workspaceDrawer.js')
const writeFileAtomic = require('write-file-atomic')
const statistics = require('js/statistics.js')

const sessionRestore = {
  savePath: window.globalArgs['user-data-path'] + (platformType === 'windows' ? '\\sessionRestore.json' : '/sessionRestore.json'),
  previousState: null,
  save: function (forceSave, sync) {
    //only one window (the focused one) should be responsible for saving session restore data
    if (!document.body.classList.contains('focused')) {
      return
    }

    var stateString = JSON.stringify(workspaces.getStringifyableState())
    var data = {
      version: 3,
      state: JSON.parse(stateString),
      saveTime: Date.now()
    }

    // save all tabs that aren't private

    for (var i = 0; i < data.state.workspaces.length; i++) {
      for (var j = 0; j < data.state.workspaces[i].tasks.length; j++) {
        data.state.workspaces[i].tasks[j].tabs = data.state.workspaces[i].tasks[j].tabs.filter(function (tab) {
          return !tab.private
        })
      }
    }

    //if startupTabOption is "open a new blank task", don't save any tabs in the current task
    if (settings.get('startupTabOption') === 3) {
      for (var i = 0; i < data.state.workspaces.length; i++) {
        for (var j = 0; j < data.state.workspaces[i].tasks.length; j++) {
          var liveTask = workspaces.findTask(data.state.workspaces[i].tasks[j].id)
          if (liveTask && liveTask.selectedInWindow) { //need to re-fetch the task because temporary properties have been removed
            data.state.workspaces[i].tasks[j].tabs = []
          }
        }
      }
    }

    if (forceSave === true || stateString !== sessionRestore.previousState) {
      try {
        localStorage.setItem('taskRestoreData', JSON.stringify(data))
      } catch (e) {}
      if (sync === true) {
        writeFileAtomic.sync(sessionRestore.savePath, JSON.stringify(data), {})
      } else {
        writeFileAtomic(sessionRestore.savePath, JSON.stringify(data), {}, function (err) {
          if (err) {
            console.warn(err)
            statistics.incrementValue('sessionRestoreSaveAsyncWriteErrors')
          }
        })
      }
      sessionRestore.previousState = stateString
    }
  },
  restoreFromFile: function () {
    var savedStringData
    try {
      savedStringData = fs.readFileSync(sessionRestore.savePath, 'utf-8')
    } catch (e) {
      console.warn('failed to read session restore data', e)
    }

    // default to reopening the last task so the last tabs are shown on startup
    var startupConfigOption = settings.get('startupTabOption') || 1
    /*
    1 - reopen last task
    2 - open new task, keep old tabs in background
    3 - discard old tabs and open new task
    */

    /*
    Disabled - show a user survey on startup
    // the survey should only be shown after an upgrade from an earlier version
    var shouldShowSurvey = false
    if (savedStringData && !localStorage.getItem('1.15survey')) {
      shouldShowSurvey = true
    }
    localStorage.setItem('1.15survey', 'true')
    */

    /* Backs up a pre-v3 session file before starting fresh. Reset-fresh
    migration: old shapes are never restored, only preserved on disk. */
    function backupAndStartFresh (reason) {
      if (savedStringData) {
        try {
          var backupSavePath = require('path').join(window.globalArgs['user-data-path'], 'sessionRestoreBackup-' + Date.now() + '.json')
          writeFileAtomic.sync(backupSavePath, savedStringData, {})
        } catch (e) {
          console.warn('failed to back up old session restore data', e)
        }
      }
      console.log('starting fresh workspace state (' + reason + ')')
      var workspaceId = workspaces.add({ name: 'Workspace 1' })
      browserUI.switchToWorkspace(workspaceId)
      return workspaceId
    }

    try {
      // first run, show the tour
      if (!savedStringData) {
        var freshId = backupAndStartFresh('first run')

        var newTab = tasks.getSelected().tabs.add({
            url: 'https://minbrowser.github.io/min/tour'
        })
        browserUI.addTab(newTab, {
         enterEditMode: false
        })
        return
      }

      var data = JSON.parse(savedStringData)

      // the data isn't restorable (anything that isn't v3 starts fresh)
      if (!data.version || data.version !== 3 || !data.state || !data.state.workspaces || data.state.workspaces.length === 0) {
        backupAndStartFresh('unsupported version ' + data.version)

        browserUI.addTab(tasks.getSelected().tabs.add())
        return
      }

      // add the saved workspaces

      data.state.workspaces.forEach(function (workspace) {
        // restore the workspace item (with its tasks)
        workspaces.add(workspace, undefined, false)

        /*
        If a task contained only private tabs, none of the tabs will be contained in the session restore data, but tasks must always have at least 1 tab, so create a new empty tab if the task doesn't have any.
        */
        workspace.tasks.forEach(function (task) {
          if (task.tabs.length === 0) {
            workspaces.findTask(task.id).tabs.add()
          }
        })
      })

      var mostRecentWorkspaces = workspaces.getActive().sort((a, b) => {
        return workspaces.getLastActivity(b.id) - workspaces.getLastActivity(a.id)
      })
      if (mostRecentWorkspaces.length > 0) {
        workspaces.setSelected(mostRecentWorkspaces[0].id)
      }

      // switch to the previously selected workspace (restores its active task)

      if (tasks.getSelected().tabs.isEmpty() || startupConfigOption === 1) {
        browserUI.switchToWorkspace(mostRecentWorkspaces[0].id)
        if (tasks.getSelected().tabs.isEmpty()) {
          tabEditor.show(tasks.getSelected().tabs.getSelected())
        }
      } else {
        window.createdNewTaskOnStartup = true
        // try to reuse a previous empty task in this workspace
        var lastTask = tasks.byIndex(tasks.getLength() - 1)
        if (lastTask && lastTask.tabs.isEmpty() && !lastTask.name) {
          browserUI.switchToTask(lastTask.id)
          tabEditor.show(lastTask.tabs.getSelected())
        } else {
          browserUI.addTask()
        }
      }

      /* Disabled - show user survey
      // if this isn't the first run, and the survey popup hasn't been shown yet, show it
      if (shouldShowSurvey) {
        fetch('https://minbrowser.org/survey/survey15.json').then(function (response) {
          return response.json()
        }).then(function (data) {
          setTimeout(function () {
            if (data.available && data.url) {
              if (tasks.getSelected().tabs.isEmpty()) {
                webviews.update(tasks.getSelected().tabs.getSelected(), data.url)
                tabEditor.hide()
              } else {
                var surveyTab = tasks.getSelected().tabs.add({
                  url: data.url
                })
                browserUI.addTab(surveyTab, {
                  enterEditMode: false
                })
              }
            }
          }, 200)
        })
      }
      */
    } catch (e) {
      // an error occured while restoring the session data

      console.error('restoring session failed: ', e)

      var backupSavePath = require('path').join(window.globalArgs['user-data-path'], 'sessionRestoreBackup-' + Date.now() + '.json')

      writeFileAtomic.sync(backupSavePath, savedStringData, {})

      // destroy any tabs that were created during the restore attempt
      tabState.initialize()

      // create a new tab with an explanation of what happened
      var errorWorkspaceId = workspaces.add({ name: 'Workspace 1' })
      browserUI.switchToWorkspace(errorWorkspaceId)
      var newSessionErrorTab = tasks.getSelected().tabs.add({
        url: 'min://app/pages/sessionRestoreError/index.html?backupLoc=' + encodeURIComponent(backupSavePath)
      })

      browserUI.switchToTab(newSessionErrorTab)

      statistics.incrementValue('sessionRestorationErrors')
    }
  },
  syncWithWindow: function () {
    const data = ipc.sendSync('request-tab-state')
    console.log('got from window', data)

    data.workspaces.forEach(function (workspace) {
      // restore the workspace item (with its tasks)
      workspaces.add(workspace, undefined, false)
    })

    if (Object.hasOwn(window.globalArgs, 'initial-task')) {
      const home = workspaces.findWorkspaceContainingTask(window.globalArgs['initial-task'])
      if (home) {
        browserUI.switchToWorkspace(home.id)
      }
      browserUI.switchToTask(window.globalArgs['initial-task'])
      return
    }

    // reuse an existing task or create a new task in this window
    // same as windowSync.js
    var selectedWs = workspaces.getSelected()
    if (!selectedWs) {
      const mostRecent = workspaces.getActive().sort((a, b) => {
        return workspaces.getLastActivity(b.id) - workspaces.getLastActivity(a.id)
      })[0]
      if (mostRecent) {
        browserUI.switchToWorkspace(mostRecent.id)
        selectedWs = workspaces.getSelected()
      }
    }
    if (selectedWs) {
      var newTaskCandidates = tasks.filter(task => task.tabs.isEmpty() && !task.selectedInWindow && !task.name)
        .sort((a, b) => {
          return tasks.getLastActivity(b.id) - tasks.getLastActivity(a.id)
        })
      if (newTaskCandidates.length > 0) {
        browserUI.switchToTask(newTaskCandidates[0].id)
        tabEditor.show(tasks.getSelected().tabs.getSelected())
      } else {
        browserUI.addTask()
      }
    } else {
      browserUI.addWorkspace()
    }
  },
  restore: function () {
    if (Object.hasOwn(window.globalArgs, 'initial-window')) {
      sessionRestore.restoreFromFile()
    } else {
      sessionRestore.syncWithWindow()
    }
    if (settings.get('newWindowOption') === 2 && !Object.hasOwn(window.globalArgs, 'launch-window') && !Object.hasOwn(window.globalArgs, 'initial-task')) {
      workspaceDrawer.show()
    }
  },
  initialize: function () {
    setInterval(sessionRestore.save, 30000)

    window.onbeforeunload = function (e) {
      sessionRestore.save(true, true)
      //workaround for notifying the other windows that the task open in this window isn't open anymore.
      //This should ideally be done in windowSync, but it needs to run synchronously, which windowSync doesn't
      var outgoingWs = workspaces.getSelected()
      var outgoingTask = tasks.getSelected()
      var releaseEvents = []
      if (outgoingWs) {
        releaseEvents.push(['workspace-updated', outgoingWs.id, 'selectedInWindow', null])
      }
      if (outgoingTask) {
        releaseEvents.push(['task-updated', outgoingTask.id, 'selectedInWindow', null])
      }
      if (releaseEvents.length > 0) {
        ipc.send('tab-state-change', releaseEvents)
      }
    }

    ipc.on('read-tab-state', function (e) {
      ipc.send('return-tab-state', workspaces.getCopyableState())
    })
  }
}

module.exports = sessionRestore
