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

/* creates a new task */

function addTask () {
  // insert after current task
  let index
  if (tasks.getSelected()) {
    index = tasks.getIndex(tasks.getSelected().id) + 1
  }
  tasks.setSelected(tasks.add({}, index))

  tabBar.updateAll()
  addTab()
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

  task.tabs.forEach(function (tab) {
    webviews.destroy(tab.id)
  })

  tasks.destroy(id)
}

/* destroys the webview and tab element for a tab */
function destroyTab (id) {
  // if the destroyed tab is part of a split view, exit split mode first,
  // keeping the other pane's tab visible
  if (splitView.isSplit() && splitView.getPaneIds().includes(id)) {
    splitView.handleTabDestroyed(id)
  }

  tabBar.removeTab(id)
  tabs.destroy(id) // remove from state - returns the index of the destroyed tab
  tabBar.updateMultiSelected() // remove any leftover multi-select highlights
  webviews.destroy(id) // remove the webview
}

/* destroys a task, and either switches to the next most-recent task or creates a new one */

function closeTask (taskId) {
  var previousCurrentTask = tasks.getSelected().id

  destroyTask(taskId)

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

    destroyTab(tabId)

    if (nextTab) {
      switchToTab(nextTab.id, { focusWebview: options.focusWebview !== false })
    } else {
      addTab()
    }
  } else {
    destroyTab(tabId)
  }
}

function setWindowTitle () {
  const task = tasks.getSelected()
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

/* changes the profile (session partition) used by a task. All existing views
of the task are destroyed so they get recreated with the new partition. */

function setTaskProfile (taskId, profileId) {
  var task = tasks.get(taskId)
  if (!task) {
    return
  }

  if (task.profileId === profileId) {
    return
  }

  // pause split view first so the panes don't hold on to the old views
  if (splitView.isSplit()) {
    splitView.destroy()
  }

  task.tabs.forEach(function (tab) {
    webviews.destroy(tab.id)
  })

  tasks.update(taskId, { profileId: profileId })

  if (taskId === tasks.getSelected().id) {
    var selectedTab = tasks.get(taskId).tabs.getSelected()
    if (selectedTab) {
      switchToTab(selectedTab, { focusWebview: true })
    } else {
      addTab()
    }
  }
}

/* archives a task: switches away from it if it is open, destroys all of its
webviews to free memory, and marks it as archived so it no longer appears in
the regular workspace list. Its state is kept so it can be restored later. */

function archiveTask (id) {
  var task = tasks.get(id)
  if (!task || task.archived) {
    return
  }

  // if this workspace is open in the current window, switch away from it first

  if (tasks.getSelected() && tasks.getSelected().id === id) {
    var remainingTasks = tasks.getActive().filter(function (t) {
      return t.id !== id
    })

    if (remainingTasks.length > 0) {
      var mostRecent = remainingTasks.sort(function (a, b) {
        return tasks.getLastActivity(b.id) - tasks.getLastActivity(a.id)
      })[0]

      switchToTask(mostRecent.id)
    } else {
      addTask()
    }
  }

  tasks.update(id, { archived: true })

  // free the memory used by the task's views; they are recreated lazily when the task is restored

  tasks.get(id).tabs.forEach(function (tab) {
    webviews.destroy(tab.id)
  })
}

/* restores an archived task and switches back to it, recreating its views */

function restoreTask (id, options) {
  var task = tasks.get(id)
  if (!task || !task.archived) {
    return
  }

  tasks.update(id, { archived: false })

  switchToTask(id, options)
}

/* changes the currently-selected task and updates the UI */

function switchToTask (id, options) {
  options = options || {}

  // switching tasks destroys the split group
  splitView.destroy()

  tasks.setSelected(id)

  tabBar.updateAll()

  var taskData = tasks.get(id)

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

tasks.on('task-updated', function (id, key) {
  if (key === 'name' && id === tasks.getSelected().id) {
    setWindowTitle()
  }
})

tasks.on('tab-selected', function () {
  setWindowTitle()
})

tasks.on('tab-updated', function (id, key) {
  if (key === 'title') {
    setWindowTitle()
  }
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

tasks.on('tab-updated', function (id, key) {
  if (key === 'url' && id === tabs.getSelected()) {
    document.body.classList.remove('is-ntp')
  }
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

ipc.on('set-file-view', function (e, data) {
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

const addWorkspace = addTask
const destroyWorkspace = destroyTask
const closeWorkspace = closeTask
const switchToWorkspace = switchToTask
const setWorkspaceProfile = setTaskProfile
const archiveWorkspace = archiveTask
const restoreWorkspace = restoreTask

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
  archiveTask,
  restoreTask,
  addWorkspace,
  destroyWorkspace,
  closeWorkspace,
  switchToWorkspace,
  setWorkspaceProfile,
  archiveWorkspace,
  restoreWorkspace,
  splitView
}
