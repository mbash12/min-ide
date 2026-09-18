const { ipcRenderer } = require('electron')

var webviews = require('webviews.js')
var keybindings = require('keybindings.js')
var browserUI = require('browserUI.js')
var editorView = require('editorView.js')
var splitView = require('splitView.js')
var tabBar = require('navbar/tabBar.js')
var tabEditor = require('navbar/tabEditor.js')
var focusMode = require('focusMode.js')
var modalMode = require('modalMode.js')
var keyboardNavigationHelper = require('util/keyboardNavigationHelper.js')
var Sortable = require('sortablejs')

const createTaskContainer = require('taskOverlay/taskOverlayBuilder.js')
const profiles = require('profiles.js')

var taskContainer = document.getElementById('task-area')
// The workspace indicator element is owned by the workspace drawer module;
// the overlay only toggles its active class while shown.
var addTaskButton = document.getElementById('add-task')
var addTaskLabel = addTaskButton.querySelector('span')
var taskOverlayNavbar = document.getElementById('task-overlay-navbar')

function addTaskFromMenu () {
  /* new tasks can't be created in modal mode */
  if (modalMode.enabled()) {
    return
  }

  /* new tasks can't be created in focus mode or modal mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  browserUI.addTask()
  taskOverlay.show()
  setTimeout(function () {
    taskOverlay.hide()
    tabEditor.show(tabs.getSelected())
  }, 600)
}

function deleteTabFromOverlay (item) {
  var itemIsFocused = item.classList.contains('fakefocus') || (document.activeElement === item)
  var successorTab = item.previousElementSibling || item.nextElementSibling
  if (!successorTab) {
    var allTabs = Array.from(document.querySelectorAll('.task-tab-item'))
    successorTab = allTabs[allTabs.indexOf(item) - 1] || allTabs[allTabs.indexOf(item) + 1]
  }

  var tabId = item.getAttribute('data-tab')

  var task = workspaces.findWorkspaceContainingTask(tabId).tasks.getTaskContainingTab(tabId)

  if (!editorView.confirmDiscard(tabId)) return
  editorView.allowDiscard(tabId)
  if (splitView.getGroupForTab(tabId)) {
    splitView.handleTabDestroyed(tabId)
  }

  workspaces.findWorkspaceContainingTask(tabId).tasks.get(task.id).tabs.destroy(tabId)
  webviews.destroy(tabId)

  tabBar.updateAll()

  // the workspace stays around when it has no tabs left; it can be
  // deleted manually from its settings popup

  if (itemIsFocused && successorTab) {
    successorTab.focus()
  }
}

/* ------- workspace profile popups ------- */

var manageProfilesButton = document.getElementById('manage-profiles-button')
var profilePopup = document.getElementById('profile-popup')
// profile-popup is created lazily if the recovered overlay DOM predates it
if (!profilePopup) {
  profilePopup = document.createElement('div')
  profilePopup.id = 'profile-popup'
  profilePopup.hidden = true
  document.body.appendChild(profilePopup)
}

manageProfilesButton.title = l('taskProfileManage')

/* positions a popup element next to an anchor element */
function positionPopup (popup, anchor) {
  var anchorRect = anchor.getBoundingClientRect()
  var popupWidth = 280
  var left = Math.min(anchorRect.left, window.innerWidth - popupWidth - 8)
  popup.style.left = Math.max(8, left) + 'px'
  popup.style.top = (anchorRect.bottom + 4) + 'px'
}

function hideProfilePopup () {
  profilePopup.hidden = true
  profilePopup.textContent = ''
}

function showProfilePopup (anchor, buildFn) {
  profilePopup.textContent = ''
  buildFn(profilePopup)
  profilePopup.hidden = false
  positionPopup(profilePopup, anchor)
}

/* popup for one task: rename, change profile, delete */
function showTaskSettings (taskId, anchor) {
  const task = tasks.get(taskId)
  if (!task) {
    return
  }

  showProfilePopup(anchor, function (popup) {
    var title = document.createElement('div')
    title.className = 'profile-popup-title'
    title.textContent = task.name || l('defaultTaskName').replace('%n', tasks.getIndex(task.id) + 1)
    popup.appendChild(title)

    /* rename */
    var renameLabel = document.createElement('div')
    renameLabel.className = 'profile-popup-section-label'
    renameLabel.textContent = l('taskRename')
    popup.appendChild(renameLabel)

    var renameInput = document.createElement('input')
    renameInput.type = 'text'
    renameInput.value = task.name || ''
    renameInput.spellcheck = false
    renameInput.className = 'profile-popup-rename-input'
    renameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        this.blur()
      }
    })
    renameInput.addEventListener('change', function () {
      tasks.update(task.id, { name: this.value.trim() || null })
      taskOverlay.render()
    })
    popup.appendChild(renameInput)

    /* profile: tasks inherit their workspace's profile; change it in the
    workspace drawer. Show it read-only here. */
    var profileLabel = document.createElement('div')
    profileLabel.className = 'profile-popup-section-label'
    profileLabel.textContent = l('taskProfileLabel')
    popup.appendChild(profileLabel)

    var defaultRow = document.createElement('div')
    defaultRow.className = 'profile-popup-row'

    var defaultInitial = document.createElement('span')
    defaultInitial.className = 'profile-initial profile-initial-default i carbon:user-multiple'
    defaultRow.appendChild(defaultInitial)

    var defaultName = document.createElement('span')
    defaultName.className = 'profile-popup-name'
    defaultName.textContent = l('taskProfileDefault')
    defaultRow.appendChild(defaultName)

    var defaultSelect = document.createElement('button')
    defaultSelect.className = 'profile-popup-select i carbon:checkmark'
    defaultSelect.title = l('taskProfileSelect')
    const wsProfileId = (workspaces.getSelected() || {}).profileId || null
    defaultSelect.classList.toggle('selected', !wsProfileId)
    defaultRow.appendChild(defaultSelect)

    popup.appendChild(defaultRow)

    profiles.getProfiles().forEach(function (profile) {
      var row = document.createElement('div')
      row.className = 'profile-popup-row'

      var initial = document.createElement('span')
      initial.className = 'profile-initial'
      initial.textContent = (profile.name.trim()[0] || '?').toUpperCase()
      initial.style.backgroundColor = profiles.getColor(profile.id)
      row.appendChild(initial)

      var nameSpan = document.createElement('span')
      nameSpan.className = 'profile-popup-name'
      nameSpan.textContent = profile.name
      row.appendChild(nameSpan)

      var selectButton = document.createElement('button')
      selectButton.className = 'profile-popup-select i carbon:checkmark'
      selectButton.title = l('taskProfileSelect')
      selectButton.classList.toggle('selected', wsProfileId === profile.id)
      row.appendChild(selectButton)

      popup.appendChild(row)
    })

    var manageButton = document.createElement('button')
    manageButton.className = 'profile-popup-manage'
    manageButton.textContent = l('taskProfileManage')
    manageButton.addEventListener('click', function () {
      hideProfilePopup()
      taskOverlay.hide()
      require('workspaceDrawer/workspaceDrawer.js').show()
    })
    popup.appendChild(manageButton)

    var profileNote = document.createElement('div')
    profileNote.className = 'profile-popup-section-label'
    profileNote.textContent = l('taskProfileInherited') || ''
    popup.appendChild(profileNote)

    /* delete */
    var deleteButton = document.createElement('button')
    deleteButton.className = 'profile-popup-delete-task'
    deleteButton.textContent = l('taskDelete')
    deleteButton.addEventListener('click', function () {
      hideProfilePopup()
      browserUI.closeTask(task.id)
      taskOverlay.render()
    })
    popup.appendChild(deleteButton)

    renameInput.focus()
    renameInput.select()
  })
}

/* popup for creating / renaming / deleting profiles */
function showProfileManager (anchor) {
  showProfilePopup(anchor, function (popup) {
    var title = document.createElement('div')
    title.className = 'profile-popup-title'
    title.textContent = l('taskProfileManagerTitle')
    popup.appendChild(title)

    profiles.getProfiles().forEach(function (profile) {
      var row = document.createElement('div')
      row.className = 'profile-popup-row'

      var initial = document.createElement('span')
      initial.className = 'profile-initial'
      initial.textContent = (profile.name.trim()[0] || '?').toUpperCase()
      initial.style.backgroundColor = profiles.getColor(profile.id)
      row.appendChild(initial)

      var nameSpan = document.createElement('span')
      nameSpan.className = 'profile-popup-name'
      nameSpan.textContent = profile.name
      row.appendChild(nameSpan)

      // rename: turns the row into an inline input (inside the popup)
      var renameButton = document.createElement('button')
      renameButton.className = 'profile-popup-rename i carbon:edit'
      renameButton.title = l('taskProfileRename')
      renameButton.addEventListener('click', function () {
        var input = document.createElement('input')
        input.type = 'text'
        input.value = profile.name
        input.spellcheck = false
        input.className = 'profile-popup-rename-input'

        var save = function () {
          var newName = input.value.trim()
          if (newName) {
            profiles.renameProfile(profile.id, newName)
            taskOverlay.render()
            showProfileManager(anchor)
          } else {
            row.replaceChild(nameSpan, input)
            row.appendChild(renameButton)
          }
        }

        row.replaceChild(input, nameSpan)
        renameButton.remove()
        input.focus()
        input.select()
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            save()
          } else if (e.key === 'Escape') {
            row.replaceChild(nameSpan, input)
            row.appendChild(renameButton)
          }
        })
        input.addEventListener('blur', save)
      })
      row.appendChild(renameButton)

      var deleteButton = document.createElement('button')
      deleteButton.className = 'profile-popup-delete i carbon:trash-can'
      deleteButton.title = l('taskProfileDelete')
      deleteButton.addEventListener('click', function () {
        // Move live workspaces to the default session first. This also asks
        // before discarding an unsaved editor and clears split groups.
        if (!browserUI.handleProfileDeleted(profile.id)) return
        profiles.removeProfile(profile.id)
        taskOverlay.render()
        showProfileManager(anchor)
      })
      row.appendChild(deleteButton)

      popup.appendChild(row)
    })

    if (profiles.getProfiles().length === 0) {
      var emptyEl = document.createElement('div')
      emptyEl.className = 'profiles-empty'
      emptyEl.textContent = l('taskProfileEmpty')
      popup.appendChild(emptyEl)
    }

    var addRow = document.createElement('div')
    addRow.className = 'profile-popup-add-row'

    var addInput = document.createElement('input')
    addInput.type = 'text'
    addInput.placeholder = l('taskProfileAddPlaceholder')
    addInput.spellcheck = false
    addRow.appendChild(addInput)

    var addButton = document.createElement('button')
    addButton.textContent = l('taskProfileAdd')
    addButton.addEventListener('click', function () {
      var name = addInput.value.trim()
      if (!name) {
        return
      }
      profiles.addProfile(name)
      taskOverlay.render()
      showProfileManager(anchor)
    })
    addRow.appendChild(addButton)

    popup.appendChild(addRow)

    addInput.focus()
  })
}

manageProfilesButton.addEventListener('click', function (e) {
  e.stopPropagation()
  if (profilePopup.hidden) {
    showProfileManager(manageProfilesButton)
  } else {
    hideProfilePopup()
  }
})

var taskOverlay = {
  overlayElement: document.getElementById('task-overlay'),
  isShown: false,
  sortableInstances: [],
  addTaskDragging: function () {
    const sortable = new Sortable(taskContainer, {
      group: 'overlay-tasks',
      draggable: '.task-container',
      ghostClass: 'task-drop-placeholder',
      scroll: true,
      scrollSensitivity: 100,
      forceAutoScrollFallback: true,
      scrollSpeed: 15,
      onEnd: function (e) {
        var droppedTaskId = e.item.getAttribute('data-task')
        const insertionPoint = Array.from(taskContainer.children).indexOf(e.item)

        // remove the task from the task list and reinsert it
        tasks.reorder(tasks.getIndex(droppedTaskId), insertionPoint)
      }
    })
    taskOverlay.sortableInstances.push(sortable)
  },
  addTabDragging: function (el) {
    const sortable = new Sortable(el, {
      group: 'overlay-tabs',
      draggable: '.task-tab-item',
      ghostClass: 'tab-drop-placeholder',
      multiDrag: true,
      multiDragKey: (window.platformType === 'mac' ? 'Meta' : 'Ctrl'),
      selectedClass: 'dragging-selected',
      animation: 200,
      scroll: true,
      scrollSensitivity: 100,
      forceAutoScrollFallback: true,
      scrollSpeed: 15,
      onStart: function () {
        taskOverlay.overlayElement.classList.add('is-dragging-tab')
      },
      onEnd: function (e) {
        taskOverlay.overlayElement.classList.remove('is-dragging-tab')

        const items = (e.items.length === 0) ? [e.item] : e.items

        const sortedItems = Array.from(e.to.children).filter(item => items.some(item2 => item2 === item))

        var newTask
        // if dropping on "add task" button, create a new task
        if (e.to === addTaskButton) {
          // insert after current task
          let index
          if (tasks.getSelected()) {
            index = tasks.getIndex(tasks.getSelected().id) + 1
          }
          newTask = tasks.get(tasks.add({}, index))
        } else {
        // otherwise, find a source task to add this tab to
          newTask = tasks.get(e.to.getAttribute('data-task'))
        }

        sortedItems.forEach(function (item) {
          var tabId = item.getAttribute('data-tab')
          var previousHome = workspaces.findWorkspaceContainingTask(tabId)
          var previousTask = previousHome.tasks.getTaskContainingTab(tabId) // note: can't use e.from here, because it contains only a single element and items could be coming from multiple tasks

          var oldTab = previousTask.tabs.splice(previousTask.tabs.getIndex(tabId), 1)[0]

          if (oldTab.selected) {
            // find a new tab in the old task to become the current one
            var mostRecentTab = previousTask.tabs.get().sort(function (a, b) {
              return b.lastActivity - a.lastActivity
            })[0]
            if (mostRecentTab) {
              previousTask.tabs.setSelected(mostRecentTab.id)
            }

            // shouldn't become selected in the new task
            oldTab.selected = false
          }

          // the old task keeps existing even when it has no tabs left;
          // it can be deleted manually from its settings popup

          if (e.to === addTaskButton) {
            item.remove()
          }

          var newIdx = Array.from(e.to.children).findIndex(t => t === item)

          // insert the tab at the correct spot
          newTask.tabs.splice(newIdx, 0, oldTab)
        })
        tabBar.updateAll()
        require('splitView.js').handleTabReorder()
        taskOverlay.render()
      }
    })
    taskOverlay.sortableInstances.push(sortable)
  },
  show: function () {
    /* disabled in focus mode */
    if (focusMode.enabled()) {
      focusMode.warn()
      return
    }

    // the drawer is full-height, so the current view is hidden behind a
    // placeholder screenshot while it is open (native views always paint
    // above the renderer DOM)
    webviews.requestPlaceholder('taskOverlay')

    document.body.classList.add('task-overlay-is-shown')
    document.body.setAttribute('data-context', 'taskOverlay')

    tabEditor.hide()

    document.getElementById('task-search-input').value = ''
    hideProfilePopup()

    this.isShown = true
    var indicatorEl = document.getElementById('workspace-indicator')
    if (indicatorEl) indicatorEl.classList.add('active')

    taskOverlay.render()

    // un-hide the overlay
    this.overlayElement.hidden = false

    // scroll to the selected element and focus it
    var currentTabElement = document.querySelector('.task-tab-item[data-tab="{id}"]'.replace('{id}', tasks.getSelected().tabs.getSelected()))

    if (currentTabElement) {
      currentTabElement.classList.add('fakefocus')
      currentTabElement.focus()
    }
  },
  render: function () {
    empty(taskContainer)
    this.sortableInstances.forEach(inst => inst.destroy())
    this.sortableInstances = []

    taskOverlay.addTabDragging(addTaskButton)
    taskOverlay.addTaskDragging()

    // show the active workspace's task elements (window.tasks is re-pointed
    // to the selected workspace's TaskList on every workspace switch)
    tasks.forEach(function (task, index) {
      const el = createTaskContainer(task, index, {
        tabSelect: function () {
          browserUI.switchToTask(task.id)
          browserUI.switchToTab(this.getAttribute('data-tab'))

          taskOverlay.hide()
        },
        tabDelete: function (item) {
          deleteTabFromOverlay(item)
        },
        taskSettings: function (taskId, anchor) {
          showTaskSettings(taskId, anchor)
        }
      })

      taskContainer.appendChild(el)
      taskOverlay.addTabDragging(el.querySelector('.task-tabs-container'))
    })
  },

  hide: function () {
    if (this.isShown) {
      this.isShown = false
      this.overlayElement.hidden = true

      // wait until the animation is complete to remove the tab elements
      setTimeout(function () {
        if (!taskOverlay.isShown) {
          empty(taskContainer)
          webviews.hidePlaceholder('taskOverlay')
        }
      }, 250)

      document.body.classList.remove('task-overlay-is-shown')
      document.body.removeAttribute('data-context')

      // close any tasks that are pending deletion

      var pendingDeleteTasks = document.body.querySelectorAll('.task-container.deleting')
      for (var i = 0; i < pendingDeleteTasks.length; i++) {
        browserUI.closeTask(pendingDeleteTasks[i].getAttribute('data-task'))
      }

      // if the current tab has been deleted, switch to the most recent one

      if (!tabs.getSelected()) {
        var mostRecentTab = tabs.get().sort(function (a, b) {
          return b.lastActivity - a.lastActivity
        })[0]

        if (mostRecentTab) {
          browserUI.switchToTab(mostRecentTab.id)
        }
      }

      // force the UI to rerender
      if (tasks.getSelected()) {
        browserUI.switchToTask(tasks.getSelected().id)
      }
      if (tabs.getSelected()) {
        browserUI.switchToTab(tabs.getSelected())
      }

      var indicatorEl = document.getElementById('workspace-indicator')
      if (indicatorEl) indicatorEl.classList.remove('active')
    }
  },

  toggle: function () {
    if (this.isShown) {
      this.hide()
    } else {
      this.show()
    }
  },

  /* close the drawer (and any open popup) when clicking outside of them */
  initializeOutsideClick: function () {
    document.addEventListener('click', function (e) {
      // close an open profile popup when clicking outside of it
      if (!profilePopup.hidden && !profilePopup.contains(e.target) && !manageProfilesButton.contains(e.target)) {
        hideProfilePopup()
      }

      if (!taskOverlay.isShown) {
        return
      }
      if (taskOverlay.overlayElement.contains(e.target)) {
        return
      }
      var indicatorEl = document.getElementById('workspace-indicator')
      if (indicatorEl && indicatorEl.contains(e.target)) {
        return
      }
      taskOverlay.hide()
    })
  },

  initializeSearch: function () {
    var container = document.querySelector('.task-search-input-container')
    var input = document.getElementById('task-search-input')

    input.placeholder = l('tasksSearchTabs') + ' (T)'

    container.addEventListener('click', e => { e.stopPropagation(); input.focus() })

    taskOverlay.overlayElement.addEventListener('keyup', function (e) {
      if (e.key.toLowerCase() === 't' && document.activeElement.tagName !== 'INPUT') {
        input.focus()
      }
    })

    input.addEventListener('input', function (e) {
      var search = input.value.toLowerCase().trim()

      if (!search) {
        // reset the overlay
        taskOverlay.render()
        input.focus()
        return
      }

      var totalTabMatches = 0

      tasks.forEach(function (task) {
        var taskContainer = document.querySelector(`.task-container[data-task="${task.id}"]`)

        var taskTabMatches = 0
        task.tabs.forEach(function (tab) {
          var tabContainer = document.querySelector(`.task-tab-item[data-tab="${tab.id}"]`)

          var searchText = (task.name + ' ' + tab.title + ' ' + tab.url).toLowerCase()

          const searchMatches = search.split(' ').every(word => searchText.includes(word))
          if (searchMatches) {
            tabContainer.hidden = false
            taskTabMatches++
            totalTabMatches++

            if (totalTabMatches === 1) {
              // first match
              tabContainer.classList.add('fakefocus')
            } else {
              tabContainer.classList.remove('fakefocus')
            }
          } else {
            tabContainer.hidden = true
          }
        })

        if (taskTabMatches === 0) {
          taskContainer.hidden = true
        } else {
          taskContainer.hidden = false
          taskContainer.classList.remove('collapsed')
        }
      })
    })

    input.addEventListener('keypress', function (e) {
      if (e.keyCode === 13) {
        var firstTab = taskOverlay.overlayElement.querySelector('.task-tab-item:not([hidden])')
        if (firstTab) {
          firstTab.click()
        }
      }
    })
  },
  initialize: function () {
    this.initializeSearch()
    this.initializeOutsideClick()

    keyboardNavigationHelper.addToGroup('taskOverlay', taskOverlay.overlayElement)

    // swipe down on the tabstrip to show the task overlay
    document.getElementById('navbar').addEventListener('wheel', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        // https://github.com/minbrowser/min/issues/698
        return
      }
      if (e.deltaY < -30 && e.deltaX < 10) {
        taskOverlay.show()
        e.stopImmediatePropagation()
      }
    })

    keybindings.defineShortcut('toggleTasks', function () {
      if (taskOverlay.isShown) {
        taskOverlay.hide()
      } else {
        taskOverlay.show()
      }
    })

    keybindings.defineShortcut({ keys: 'esc' }, function (e) {
      taskOverlay.hide()
    })

    keybindings.defineShortcut('enterEditMode', function (e) {
      taskOverlay.hide()
    })

    keybindings.defineShortcut('closeTab', function (e) {
      var focusedTab = (document.querySelector('.task-tab-item.fakefocus') || document.activeElement)
      if (focusedTab && focusedTab.getAttribute('data-tab')) {
        deleteTabFromOverlay(focusedTab)
        focusedTab.remove()
      }
    }, { contexts: ['taskOverlay'] })

    keybindings.defineShortcut('addTask', addTaskFromMenu)
    ipcRenderer.on('addTask', addTaskFromMenu) // for menu item

    addTaskLabel.textContent = l('newTask')

    addTaskButton.addEventListener('click', function (e) {
      browserUI.addTask()
      taskOverlay.hide()
      tabEditor.show(tabs.getSelected())
    })

    // clicking the drawer background (navbar) closes it
    taskOverlayNavbar.addEventListener('click', function (e) {
      if (e.target === taskOverlayNavbar || e.target.closest('.task-search-input-container')) {
        taskOverlay.hide()
      }
    })

    // NOTE: the workspace indicator is owned by the workspace drawer module
    // (workspaceDrawer.js updateIndicator shows Workspace › Task). The overlay
    // re-renders on selection changes via state-sync-change below.
    workspaces.on('workspace-selected', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    workspaces.on('state-sync-change', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })
  }
}

module.exports = taskOverlay
