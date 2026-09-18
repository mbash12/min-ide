var statistics = require('js/statistics.js')
var searchEngine = require('js/util/searchEngine.js')
var urlParser = require('js/util/urlParser.js')

/* common actions that affect different parts of the UI (webviews, tabstrip, etc) */

var settings = require('util/settings/settings.js')
var webviews = require('webviews.js')
var focusMode = require('focusMode.js')
var tabBar = require('navbar/tabBar.js')
var tabEditor = require('navbar/tabEditor.js')
var searchbar = require('searchbar/searchbar.js')
var splitView = require('splitView.js')
var editorView = require('editorView.js')

/* Ask before throwing away any editor content that only exists in a view.
The check is intentionally renderer-side: closeTab and workspace actions are
synchronous today, while editor pages report their state over view IPC. */
function confirmDiscardTabs (tabList) {
  return tabList.every(function (tab) {
    return editorView.confirmDiscard(tab.id)
  })
}

/* creates a new workspace: one Workspace record owning one initial task */

function addWorkspace (workspace) {
  workspace = workspace || {}
  const id = workspaces.add(workspace)
  switchToWorkspace(id)
  return id
}

/* creates a new task inside the selected workspace */

function addTask () {
  const ws = workspaces.getSelected()
  if (!ws) {
    return addWorkspace()
  }
  // insert after current task
  let index
  if (tasks.getSelected()) {
    index = tasks.getIndex(tasks.getSelected().id) + 1
  }
  const id = tasks.add({}, index)
  switchToTask(id)

  return id
}

/* creates a new tab */

/*
options
  options.enterEditMode - whether to enter editing mode when the tab is created. Defaults to true.
  options.openInBackground - whether to open the tab without switching to it. Defaults to false.
*/
function addTab (tabId = tabs.add(), options = {}) {
  /*
  adding a new tab should destroy the current one if either:
  * The current tab is an empty, non-private tab, and the new tab is private
  * The current tab is empty, and the new tab has a URL
  */

  // opening a new tab pauses split view (the group is remembered)
  if (splitView.isSplit()) {
    splitView.pause()
  }

  if (!options.openInBackground && !tabs.get(tabs.getSelected()).url && ((!tabs.get(tabs.getSelected()).private && tabs.get(tabId).private) || tabs.get(tabId).url)) {
    destroyTab(tabs.getSelected())
  }

  tabBar.addTab(tabId)
  webviews.add(tabId)

  if (!options.openInBackground) {
    const focusWebview = (options.focusWebview != null)
      ? options.focusWebview
      : (options.enterEditMode === false)
    switchToTab(tabId, {
      focusWebview: focusWebview
    })
    if (options.enterEditMode !== false) {
      tabEditor.show(tabId)
    }
  } else {
    tabBar.getTab(tabId).scrollIntoView()
  }
}

function moveTabLeft (tabId = tabs.getSelected()) {
  tabs.moveBy(tabId, -1)
  tabBar.updateAll()
  splitView.handleTabReorder()
}

function moveTabRight (tabId = tabs.getSelected()) {
  tabs.moveBy(tabId, 1)
  tabBar.updateAll()
  splitView.handleTabReorder()
}

/* destroys a task object and the associated webviews */

function destroyTask (id) {
  var task = tasks.get(id)
  if (!task || !confirmDiscardTabs(task.tabs.get())) {
    return false
  }

  // A task lifecycle change invalidates both the shown split and paused
  // groups. Clear them before destroying the task's views.
  splitView.clearAll()

  task.tabs.get().forEach(function (tab) {
    editorView.allowDiscard(tab.id)
    webviews.destroy(tab.id)
  })

  tasks.destroy(id)
  return true
}

/* destroys the webview and tab element for a tab */
function destroyTab (id, options) {
  options = options || {}
  if (!options.skipDirtyCheck && !editorView.confirmDiscard(id)) {
    return false
  }

  editorView.allowDiscard(id)

  // if the destroyed tab is part of a split view, exit split mode first,
  // keeping the other pane's tab visible
  if (splitView.getGroupForTab(id)) {
    splitView.handleTabDestroyed(id)
  }

  tabBar.removeTab(id)
  tabs.destroy(id) // remove from state - returns the index of the destroyed tab
  tabBar.updateMultiSelected() // remove any leftover multi-select highlights
  webviews.destroy(id) // remove the webview
  return true
}

/* destroys a task, and either switches to the next most-recent task or creates a new one.
A workspace is never left taskless: closing the last task recreates an empty one. */

function closeTask (taskId) {
  var previousCurrentTask = tasks.getSelected() && tasks.getSelected().id

  // stop the task's agent session before tearing down its views
  ipc.send('agent-destroy-task-session', { taskId: taskId })

  if (!destroyTask(taskId)) {
    return false
  }

  if (taskId === previousCurrentTask) {
    // the current task was destroyed, find another task to switch to

    if (tasks.getLength() === 0) {
      // there are no tasks left, create a new one
      return addTask()
    } else {
      // switch to the most-recent task

      var recentTaskList = tasks.map(function (task) {
        return { id: task.id, lastActivity: tasks.getLastActivity(task.id) }
      })

      const mostRecent = recentTaskList.reduce(
        (latest, current) => current.lastActivity > latest.lastActivity ? current : latest
      )

      return switchToTask(mostRecent.id)
    }
  }
}

/* destroys a workspace: all of its tasks, views and workspace-scoped state */

function closeWorkspace (id) {
  var ws = workspaces.get(id)
  if (!ws) {
    return false
  }

  const wasSelected = workspaces.getSelected() && workspaces.getSelected().id === id

  // stop every task agent session in the workspace first
  ws.tasks.forEach(function (task) {
    ipc.send('agent-destroy-task-session', { taskId: task.id })
  })

  if (!confirmDiscardTabs(ws.tasks.map(task => task.tabs.get()).reduce((all, arr) => all.concat(arr), []))) {
    return false
  }

  splitView.clearAll()

  ws.tasks.forEach(function (task) {
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

/* destroys a tab, and either switches to the next tab or creates a new one */

function closeTab (tabId, options) {
  options = options || {}

  /* disabled in focus mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  if (tabId === tabs.getSelected()) {
    var currentIndex = tabs.getIndex(tabs.getSelected())
    var nextTab =
    tabs.getAtIndex(currentIndex - 1) || tabs.getAtIndex(currentIndex + 1)

    if (!destroyTab(tabId)) {
      return false
    }

    if (nextTab) {
      switchToTab(nextTab.id, { focusWebview: options.focusWebview !== false })
    } else {
      addTab()
    }
  } else {
    return destroyTab(tabId)
  }
}

function setWindowTitle () {
  const task = tasks.getSelected()
  if (!task) {
    return
  }
  const tab = task.tabs.get(task.tabs.getSelected())

  const truncateString = (str, len) => {
    if (str.length > len) {
      return str.substring(0, len) + '...'
    } else {
      return str
    }
  }

  const title = [
    truncateString(tab.title || '', 100),
    truncateString(task.name || '', 100),
    'Min'
  ].filter(str => !!str).join(' | ')

  if (document.title !== title) {
    document.title = title
    ipc.send('set-window-title', title)
  }
}

/* changes the profile (session partition) used by a workspace. All existing
views of the workspace's tasks are destroyed so they get recreated with the
new partition. Kept under the old setTaskProfile name for callers; the id is
a workspace id. */

function setTaskProfile (workspaceId, profileId, options) {
  options = options || {}
  var ws = workspaces.get(workspaceId)
  if (!ws) {
    return false
  }

  if (ws.profileId === profileId) {
    return true
  }

  const allTabs = ws.tasks.map(task => task.tabs.get()).reduce((all, arr) => all.concat(arr), [])
  if (!options.skipDirtyCheck && !confirmDiscardTabs(allTabs)) {
    return false
  }

  // Drop every group, including paused groups, before replacing the views.
  splitView.clearAll()

  ws.tasks.forEach(function (task) {
    task.tabs.get().forEach(function (tab) {
      editorView.allowDiscard(tab.id)
      webviews.destroy(tab.id)
    })
  })

  workspaces.update(workspaceId, { profileId: profileId })

  if (workspaceId === workspaces.getSelected().id) {
    var selectedTab = tasks.getSelected() && tasks.getSelected().tabs.getSelected()
    if (selectedTab) {
      switchToTab(selectedTab, { focusWebview: true })
    } else {
      addTab()
    }
  }
  return true
}

/* Handles a profile being deleted from Pro Settings. The live workspace
assignment is updated first, and all old views are recreated lazily against
the default partition instead of leaving the deleted profile id in memory. */
function getProfileDeletionTasks (profileId) {
  const affected = []
  workspaces.forEach(function (ws) {
    if (ws.profileId === profileId) {
      ws.tasks.forEach(function (task) {
        affected.push({ workspace: ws, task: task })
      })
    }
  })
  return affected
}

function confirmProfileDeletion (profileId) {
  const affectedTasks = getProfileDeletionTasks(profileId)
  const affectedTabs = []
  affectedTasks.forEach(function (entry) {
    affectedTabs.push.apply(affectedTabs, entry.task.tabs.get())
  })
  return confirmDiscardTabs(affectedTabs)
}

function applyProfileDeleted (profileId) {
  if (!profileId) {
    return false
  }

  const affectedTasks = getProfileDeletionTasks(profileId)

  const selectedTask = tasks.getSelected()
  const selectedTaskId = selectedTask && selectedTask.id
  const selectedTabId = selectedTask && selectedTask.tabs.getSelected()

  splitView.clearAll()
  affectedTasks.forEach(function (entry) {
    entry.task.tabs.get().forEach(function (tab) {
      editorView.allowDiscard(tab.id)
      webviews.destroy(tab.id)
    })
    workspaces.update(entry.workspace.id, { profileId: null })
  })

  // Recreate the selected tab immediately so the user does not see a blank
  // content area after deleting the profile. Other workspaces recreate views
  // when they are selected.
  if (selectedTaskId && affectedTasks.some(function (entry) { return entry.task.id === selectedTaskId })) {
    const task = workspaces.findTask(selectedTaskId)
    if (selectedTabId && task.tabs.has(selectedTabId)) {
      switchToTab(selectedTabId, { focusWebview: true })
    } else if (task.tabs.count() === 0) {
      addTab()
    }
  }
  return true
}

function handleProfileDeleted (profileId) {
  if (!profileId || !confirmProfileDeletion(profileId)) {
    return false
  }
  return applyProfileDeleted(profileId)
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

  // Archived workspaces must not retain paused groups or stale attached views.
  splitView.clearAll()

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

/* changes the currently-selected task inside the selected workspace and updates the UI */

function switchToTask (id, options) {
  options = options || {}

  // switching tasks destroys the visible and all paused split groups
  splitView.clearAll()

  tasks.setSelected(id)

  tabBar.updateAll()

  var taskData = tasks.get(id)
  if (!taskData) {
    return
  }

  // remember the task on the workspace so workspace switches restore it
  const ws = workspaces.getSelected()
  if (ws) {
    workspaces.update(ws.id, { activeTaskId: id }, false)
  }

  if (taskData.tabs.count() > 0) {
    var selectedTab = taskData.tabs.getSelected()

    // if the task has no tab that is selected, switch to the most recent one

    if (!selectedTab) {
      selectedTab = taskData.tabs.get().sort(function (a, b) {
        return b.lastActivity - a.lastActivity
      })[0].id
    }

    switchToTab(selectedTab, { focusWebview: options.focusWebview !== false })
  } else {
    addTab()
  }

  setWindowTitle(taskData)
}

/* changes the currently-selected workspace, restoring its last active task */

function switchToWorkspace (id, options) {
  options = options || {}
  var ws = workspaces.get(id)
  if (!ws) {
    return
  }

  // setSelected re-points window.tasks to this workspace's list; it must run
  // before splitView.clearAll, which reads window.tabs (undefined until the
  // first task is selected).
  workspaces.setSelected(id)

  // switching workspaces destroys the visible and all paused split groups
  splitView.clearAll()

  tabBar.updateAll()

  var taskId = ws.activeTaskId && ws.tasks.get(ws.activeTaskId) ? ws.activeTaskId : null
  if (!taskId) {
    if (ws.tasks.getLength() === 0) {
      taskId = tasks.add({})
    } else {
      taskId = ws.tasks.getSelected() ? ws.tasks.getSelected().id : ws.tasks.byIndex(0).id
    }
    workspaces.update(id, { activeTaskId: taskId }, false)
  }

  switchToTask(taskId, options)
}

workspaces.on('workspace-selected', function () {
  setWindowTitle()
})

// Title subscriptions live on the WorkspaceStore (stable reference) and on
// each TaskList at creation time. window.tasks is re-pointed on every
// workspace switch, so task-level subscriptions must be attached per list.
function subscribeTaskList (taskList) {
  taskList.on('task-updated', function (id, key) {
    if (key === 'name') {
      const selected = window.tasks.getSelected()
      if (selected && id === selected.id) {
        setWindowTitle()
      }
    }
  })

  taskList.on('tab-selected', function () {
    setWindowTitle()
  })

  taskList.on('tab-updated', function (id, key) {
    if (key === 'title') {
      setWindowTitle()
    }
  })
}

workspaces.on('workspace-added', function (id) {
  const ws = workspaces.get(id)
  if (ws) {
    subscribeTaskList(ws.tasks)
  }
})

workspaces.on('workspace-selected', function () {
  setWindowTitle()
})

/* switches to a tab - update the webview, state, tabstrip, etc. */

function switchToTab (id, options) {
  options = options || {}

  // handles both split states: switching panes while split, and
  // pausing/resuming the split group when switching tabs
  splitView.setActiveTab(id)

  if (splitView.isSplit()) {
    // in split view, switching tabs changes which pane is active
    tabs.setSelected(id)
    tabBar.setActiveTab(id)
    webviews.setSelected(id, {
      focus: options.focusWebview !== false
    })
    tabEditor.hide()
    return
  }

  tabs.setSelected(id)
  tabBar.setActiveTab(id)
  webviews.setSelected(id, {
    focus: options.focusWebview !== false
  })

  tabEditor.hide()

  if (!tabs.get(id).url) {
    document.body.classList.add('is-ntp')
  } else {
    document.body.classList.remove('is-ntp')
  }
}

require('util/followTaskList.js').followTaskList(function (taskList) {
  taskList.on('tab-updated', function (id, key) {
    if (key === 'url' && window.tabs && id === window.tabs.getSelected()) {
      document.body.classList.remove('is-ntp')
    }
  })
})

webviews.bindEvent('did-create-popup', function (tabId, popupId, initialURL) {
  var popupTab = tabs.add({
    // in most cases, initialURL will be overwritten once the popup loads, but if the URL is a downloaded file, it will remain the same
    url: initialURL,
    private: tabs.get(tabId).private
  })
  tabBar.addTab(popupTab)
  webviews.add(popupTab, popupId)
  switchToTab(popupTab)
})

webviews.bindEvent('new-tab', function (tabId, url, openInForeground) {
  var newTab = tabs.add({
    url: url,
    private: tabs.get(tabId).private // inherit private status from the current tab
  })

  addTab(newTab, {
    enterEditMode: false,
    openInBackground: !settings.get('openTabsInForeground') && !openInForeground
  })
})

webviews.bindIPC('close-window', function (tabId, args) {
  closeTab(tabId)
})

/* Pro Settings lives in a webview, so its localStorage update cannot mutate
the live task objects directly. The preload relay delivers the deleted id to
this renderer, which moves affected workspaces to the default profile and
recreates their views. */
webviews.bindIPC('profileDeleted', function (tabId, args) {
  applyProfileDeleted(args && args[0])
})

/* Request/response form used by Pro Settings. Confirm before the page removes
the profile from localStorage; this avoids leaving live tasks pointing at a
profile that was deleted after an unsaved-editor prompt was canceled. */
webviews.bindIPC('profileDeleteRequested', function (tabId, args) {
  const profileId = args && args[0]
  const allowed = !!profileId && confirmProfileDeletion(profileId)
  if (!allowed) {
    if (webviews.hasViewForTab(tabId)) {
      webviews.callAsync(tabId, 'send', ['profileDeleteResult', { profileId: profileId, ok: false }])
    }
    return
  }

  if (webviews.hasViewForTab(tabId)) {
    webviews.callAsync(tabId, 'send', ['profileDeleteResult', { profileId: profileId, ok: true }])
  }
})

ipc.on('set-file-view', function (e, data) {
  if (!window.tabs) {
    return
  }
  tabs.get().forEach(function (tab) {
    if (tab.url === data.url) {
      tabs.update(tab.id, { isFileView: data.isFileView })
    }
  })
})

searchbar.events.on('url-selected', function (data) {
  var searchbarQuery = searchEngine.getSearch(urlParser.parse(data.url))
  if (searchbarQuery) {
    statistics.incrementValue('searchCounts.' + searchbarQuery.engine)
  }

  if (data.background) {
    var newTab = tabs.add({
      url: data.url,
      private: tabs.get(tabs.getSelected()).private
    })
    addTab(newTab, {
      enterEditMode: false,
      openInBackground: true
    })
  } else {
    webviews.update(tabs.getSelected(), data.url)
    tabEditor.hide()
  }
})

tabBar.events.on('tab-selected', function (id) {
  switchToTab(id)
})

tabBar.events.on('tab-closed', function (id) {
  closeTab(id)
})

// Backwards-compatible aliases: task-level names kept for callers that
// operate on the selected workspace's task list.
const destroyWorkspace = destroyTask
const setWorkspaceProfile = setTaskProfile
const archiveTask = archiveWorkspace
const restoreTask = restoreWorkspace

module.exports = {
  addTask,
  addTab,
  destroyTask,
  destroyTab,
  closeTask,
  closeTab,
  switchToTask,
  switchToTab,
  moveTabLeft,
  moveTabRight,
  setTaskProfile,
  handleProfileDeleted,
  archiveTask,
  restoreTask,
  addWorkspace,
  destroyWorkspace,
  closeWorkspace,
  switchToWorkspace,
  setWorkspaceProfile,
  archiveWorkspace,
  restoreWorkspace,
  removeWorkspaceState,
  splitView
}
