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

const { addWorkspace, closeWorkspace, removeWorkspaceState, archiveWorkspace, restoreWorkspace } = require('workspaces/workspaceLifecycle.js')({
  workspaces, splitView, editorView, webviews, confirmDiscardTabs, switchToWorkspace
})
const { setWorkspaceProfile, handleProfileDeleted, applyProfileDeleted, getProfileUsageWorkspaces, clearProfileData } = require('workspaces/profileLifecycle.js')({
  workspaces, tasks, splitView, editorView, webviews, confirmDiscardTabs, switchToTab, addTab
})

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

  const selectedTab = tabs.getSelected() && tabs.get(tabs.getSelected())
  if (!options.openInBackground && selectedTab && selectedTab.id !== tabId && !selectedTab.url && ((!selectedTab.private && tabs.get(tabId).private) || tabs.get(tabId).url)) {
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

  if (tasks.getSelected() === task) splitView.clearAll()
  ipc.send('agent-destroy-task-session', { taskId: id })

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
  const tab = task.tabs.getSelected() && task.tabs.get(task.tabs.getSelected())

  const truncateString = (str, len) => {
    if (str.length > len) {
      return str.substring(0, len) + '...'
    } else {
      return str
    }
  }

  const title = [
    truncateString((tab && tab.title) || '', 100),
    truncateString(task.name || '', 100),
    'Min'
  ].filter(str => !!str).join(' | ')

  if (document.title !== title) {
    document.title = title
    ipc.send('set-window-title', title)
  }
}

/* changes the currently-selected task inside the selected workspace and updates the UI */

function switchToTask (id, options) {
  options = options || {}

  if (!tasks.get(id)) return

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

  // bring back the layout the task was left in (see js/splitView.js)
  splitView.restoreForSelectedTask()
}

/* changes the currently-selected workspace, restoring its last active task */

function switchToWorkspace (id, options) {
  options = options || {}
  var ws = workspaces.get(id)
  if (!ws) {
    return
  }

  // setSelected re-points window.tasks to this workspace's list. Task
  // selection (which sets window.tabs) must happen before anything that
  // reads window.tabs: splitView.clearAll, tabBar.updateAll.
  workspaces.setSelected(id)

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

// Title subscriptions live on the WorkspaceStore (stable reference). The
// store re-emits inner TaskList/TabList events for every workspace -
// including ones added with emit=false during session restore, which the
// previous 'workspace-added' subscription never saw. window.tasks is
// re-pointed on every workspace switch, so listeners must not be attached
// per list.
workspaces.on('task-updated', function (id, key) {
  if (key === 'name') {
    const selected = window.tasks.getSelected()
    if (selected && id === selected.id) {
      setWindowTitle()
    }
  }
})

workspaces.on('tab-selected', function () {
  setWindowTitle()
})

workspaces.on('tab-updated', function (id, key) {
  if (key === 'title') {
    setWindowTitle()
  }
})

workspaces.on('workspace-selected', function () {
  setWindowTitle()
})

/* switches to a tab - update the webview, state, tabstrip, etc. */

function switchToTab (id, options) {
  options = options || {}
  if (!window.tabs || !tabs.has(id)) return

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

tasks.on('tab-updated', function (id, key) {
  if (key === 'url' && window.tabs && id === window.tabs.getSelected()) {
    document.body.classList.remove('is-ntp')
  }
})

function openRelatedTab (sourceId, url, foreground, existingViewId) {
  const owner = workspaces.findTaskContainingTab(sourceId)
  if (!owner) return
  const home = owner.tabs.parentTaskList.workspace
  const tabId = owner.tabs.add({ url: url, private: owner.tabs.get(sourceId).private })
  // Adopt the native popup before switching tasks can lazily create a view
  // for the same tab; OAuth requires keeping the original opener/session.
  if (existingViewId) webviews.add(tabId, existingViewId)
  if (foreground) {
    if (workspaces.getSelected() !== home) switchToWorkspace(home.id)
    if (tasks.getSelected() !== owner) switchToTask(owner.id)
  }
  if (tasks.getSelected() === owner) {
    if (existingViewId) {
      if (!tabBar.getTab(tabId)) tabBar.addTab(tabId)
      if (foreground) switchToTab(tabId)
    } else {
      addTab(tabId, { enterEditMode: false, openInBackground: !foreground })
    }
  } else if (!existingViewId) {
    webviews.add(tabId, existingViewId)
  }
}

webviews.bindEvent('did-create-popup', function (tabId, popupId, initialURL, openInForeground) {
  openRelatedTab(tabId, initialURL, openInForeground !== false, popupId)
})

webviews.bindEvent('new-tab', function (tabId, url, openInForeground) {
  openRelatedTab(tabId, url, settings.get('openTabsInForeground') || openInForeground)
})

webviews.bindIPC('close-window', function (tabId) {
  const owner = workspaces.findTaskContainingTab(tabId)
  if (!owner) return
  if (owner === tasks.getSelected()) closeTab(tabId)
  else {
    if (focusMode.enabled()) {
      focusMode.warn()
      return
    }
    if (!editorView.confirmDiscard(tabId)) return
    editorView.allowDiscard(tabId)
    webviews.destroy(tabId)
    owner.tabs.destroy(tabId)
  }
})

/* Pro Settings lives in a webview, so its localStorage update cannot mutate
the live task objects directly. The preload relay delivers the deleted id to
this renderer, which moves affected workspaces to the default profile and
recreates their views. */
webviews.bindIPC('profileDeleted', function (tabId, args) {
  applyProfileDeleted(args && args[0])
})

/* Request/response form used by Pro Settings. A profile that is still
assigned to a workspace cannot be deleted - the page is told which workspaces
block it. Unused profiles delete right away; the profileDeleted/applyDeleted
path stays as a safety net for races between the check and the removal. */
webviews.bindIPC('profileDeleteRequested', function (tabId, args) {
  const profileId = args && args[0]
  const result = { profileId: profileId, ok: false }
  if (profileId) {
    const usedBy = getProfileUsageWorkspaces(profileId)
    if (usedBy.length) {
      result.reason = 'in-use'
      result.workspaces = usedBy
    } else {
      result.ok = true
    }
  }
  if (webviews.hasViewForTab(tabId)) {
    webviews.callAsync(tabId, 'send', ['profileDeleteResult', result])
  }
})

/* Clear Data for a profile's session partition; live web tabs on every
workspace using it are reloaded afterwards so logout/cache effects show. */
webviews.bindIPC('profileClearDataRequested', function (tabId, args) {
  const request = (args && args[0]) || {}
  const finish = function (result) {
    if (webviews.hasViewForTab(tabId)) {
      webviews.callAsync(tabId, 'send', ['profileClearDataResult', Object.assign({ profileId: request.profileId }, result)])
    }
  }
  if (request.profileId === undefined || !request.types || (!request.types.siteData && !request.types.cache)) {
    finish({ ok: false })
    return
  }
  clearProfileData(request.profileId || null, request.types).then(finish)
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
  setWorkspaceProfile,
  handleProfileDeleted,
  addWorkspace,
  closeWorkspace,
  switchToWorkspace,
  archiveWorkspace,
  restoreWorkspace,
  removeWorkspaceState,
  splitView
}
