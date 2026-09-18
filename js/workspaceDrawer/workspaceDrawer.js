const browserUI = require('browserUI.js')
const webviews = require('webviews.js')
const tabEditor = require('navbar/tabEditor.js')
const focusMode = require('focusMode.js')
const profiles = require('profiles.js')
const settings = require('util/settings/settings.js')
const proSettingsPage = require('util/proSettingsPage.js')

const drawer = document.getElementById('workspace-drawer')
const backdrop = document.getElementById('workspace-backdrop')
const workspaceListEl = document.getElementById('workspace-list')
const addWorkspaceButton = document.getElementById('add-workspace')
const manageProfilesButton = document.getElementById('manage-profiles-button')
const workspaceModal = document.getElementById('workspace-modal')
const workspaceModalTitle = document.getElementById('workspace-modal-title')
const workspaceModalNameInput = document.getElementById('workspace-modal-name')
const workspaceModalProfileSelect = document.getElementById('workspace-modal-profile')
const workspaceModalPathInput = document.getElementById('workspace-modal-path')
const workspaceModalBrowseButton = document.getElementById('workspace-modal-browse')
const workspaceModalClearPathButton = document.getElementById('workspace-modal-clear-path')
const workspaceModalSave = document.getElementById('workspace-modal-save')
const workspaceModalCancel = document.getElementById('workspace-modal-cancel')
const workspaceModalDelete = document.getElementById('workspace-modal-delete')
const indicator = document.getElementById('workspace-indicator')
const indicatorName = indicator ? indicator.querySelector('.workspace-indicator-name') : null
const indicatorIcon = indicator ? indicator.querySelector('.workspace-indicator-icon') : null

let modalWorkspaceId = null
let modalIsCreate = false

function profileInitial (profile) {
  const el = document.createElement('span')
  el.className = 'profile-initial'
  el.textContent = (profile.name.trim()[0] || '?').toUpperCase()
  el.style.backgroundColor = profiles.getColor(profile.id)
  return el
}

function defaultInitial () {
  const el = document.createElement('span')
  el.className = 'profile-initial profile-initial-default i carbon:user-multiple'
  return el
}

function populateProfileSelect (selectedId) {
  workspaceModalProfileSelect.textContent = ''
  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = l('taskProfileDefault')
  workspaceModalProfileSelect.appendChild(defaultOpt)
  profiles.getProfiles().forEach(function (p) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    workspaceModalProfileSelect.appendChild(opt)
  })
  workspaceModalProfileSelect.value = selectedId || ''
}

function openWorkspaceModal (workspaceId) {
  const isCreate = !workspaceId
  modalIsCreate = isCreate
  modalWorkspaceId = workspaceId || null

  if (isCreate) {
    workspaceModalTitle.textContent = l('workspaceCreateTitle')
    workspaceModalNameInput.value = ''
    populateProfileSelect('')
    workspaceModalPathInput.value = ''
    workspaceModalDelete.hidden = true
    workspaceModalSave.textContent = l('workspaceCreateAction')
  } else {
    const ws = workspaces.get(workspaceId)
    if (!ws) return
    workspaceModalTitle.textContent = l('workspaceEditTitle')
    workspaceModalNameInput.value = ws.name || ''
    populateProfileSelect(ws.profileId || '')
    workspaceModalPathInput.value = ws.path || ''
    workspaceModalDelete.hidden = false
    workspaceModalSave.textContent = l('dialogConfirmButton')
  }

  workspaceModal.hidden = false
  workspaceModalNameInput.focus()
  workspaceModalNameInput.select()
}

function closeWorkspaceModal () {
  workspaceModal.hidden = true
  modalWorkspaceId = null
}

function saveWorkspaceModal () {
  const name = workspaceModalNameInput.value.trim() || null
  const profileId = workspaceModalProfileSelect.value || null
  const path = workspaceModalPathInput.value.trim() || null

  if (modalIsCreate) {
    let index
    if (workspaces.getSelected()) {
      index = workspaces.getIndex(workspaces.getSelected().id) + 1
    }
    const newId = workspaces.add({ name: name, profileId: profileId, path: path }, index)
    browserUI.switchToWorkspace(newId)
  } else {
    const ws = workspaces.get(modalWorkspaceId)
    if (!ws) {
      closeWorkspaceModal()
      return
    }
    if (name !== ws.name) {
      workspaces.update(modalWorkspaceId, { name: name })
    }
    if (profileId !== (ws.profileId || '')) {
      browserUI.setWorkspaceProfile(modalWorkspaceId, profileId || null)
    }
    if (path !== (ws.path || '')) {
      workspaces.update(modalWorkspaceId, { path: path })
    }
  }

  closeWorkspaceModal()
  workspaceDrawer.render()
}

/* opens a folder picker and assigns the selection to the workspace path field */
async function browseWorkspacePath () {
  try {
    const filePaths = await ipc.invoke('showOpenDialog', {
      properties: ['openDirectory']
    })
    if (filePaths && filePaths.length > 0) {
      workspaceModalPathInput.value = filePaths[0]
    }
  } catch (e) {
    console.error('failed to open folder picker', e)
  }
}

function openProfilesPage () {
  // profile management lives in the Pro Settings page's Profiles tab;
  // open() focuses the existing Pro Settings tab instead of duplicating it
  proSettingsPage.open('min://proSettings?tab=profiles')
}

function createWorkspaceRow (ws) {
  const row = document.createElement('div')
  row.className = 'ws-row'
  if (workspaces.getSelected() && ws.id === workspaces.getSelected().id) {
    row.classList.add('selected')
  }
  row.setAttribute('data-workspace', ws.id)

  const profile = profiles.getProfile(ws.profileId)
  row.appendChild(profile ? profileInitial(profile) : defaultInitial())

  const mainEl = document.createElement('span')
  mainEl.className = 'ws-row-main'
  const nameEl = document.createElement('span')
  nameEl.className = 'ws-row-name'
  nameEl.textContent = ws.name || l('defaultTaskName').replace('%n', workspaces.getIndex(ws.id) + 1)
  mainEl.appendChild(nameEl)

  if (ws.path) {
    const pathEl = document.createElement('span')
    pathEl.className = 'ws-row-path'
    pathEl.textContent = ws.path
    pathEl.title = ws.path
    mainEl.appendChild(pathEl)
  }
  row.appendChild(mainEl)

  const badge = document.createElement('span')
  badge.className = 'ws-row-badge'
  const count = ws.tasks ? ws.tasks.map(task => task.tabs.count()).reduce((a, b) => a + b, 0) : 0
  badge.textContent = String(count)
  badge.title = count === 1 ? '1 tab' : count + ' tabs'
  row.appendChild(badge)

  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'ws-row-settings i carbon:archive'
  archiveBtn.title = l('workspaceArchiveAction')
  archiveBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    browserUI.archiveWorkspace(ws.id)
    workspaceDrawer.render()
  })
  row.appendChild(archiveBtn)

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'ws-row-settings i carbon:edit'
  settingsBtn.title = l('taskSettings')
  settingsBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    openWorkspaceModal(ws.id)
  })
  row.appendChild(settingsBtn)

  row.addEventListener('click', function (e) {
    if (e.target === settingsBtn || settingsBtn.contains(e.target)) return
    browserUI.switchToWorkspace(ws.id)
    workspaceDrawer.hide()
  })

  return row
}

/* archived workspaces keep their tabs in the session data, but all of their
views are destroyed to save memory. Opening one restores it. */

function createArchivedWorkspaceRow (ws) {
  const row = document.createElement('div')
  row.className = 'ws-row ws-row-archived'
  row.setAttribute('data-workspace', ws.id)

  const mainEl = document.createElement('span')
  mainEl.className = 'ws-row-main'
  const nameEl = document.createElement('span')
  nameEl.className = 'ws-row-name'
  nameEl.textContent = ws.name || l('defaultTaskName').replace('%n', workspaces.getIndex(ws.id) + 1)
  mainEl.appendChild(nameEl)

  if (ws.path) {
    const pathEl = document.createElement('span')
    pathEl.className = 'ws-row-path'
    pathEl.textContent = ws.path
    pathEl.title = ws.path
    mainEl.appendChild(pathEl)
  }
  row.appendChild(mainEl)

  const badge = document.createElement('span')
  badge.className = 'ws-row-badge'
  const count = ws.tasks ? ws.tasks.map(task => task.tabs.count()).reduce((a, b) => a + b, 0) : 0
  badge.textContent = String(count)
  badge.title = count === 1 ? '1 tab' : count + ' tabs'
  row.appendChild(badge)

  const restoreBtn = document.createElement('button')
  restoreBtn.className = 'ws-row-settings i carbon:renew'
  restoreBtn.title = l('workspaceRestoreAction')
  restoreBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    browserUI.restoreWorkspace(ws.id)
    workspaceDrawer.hide()
  })
  row.appendChild(restoreBtn)

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'ws-row-settings i carbon:edit'
  settingsBtn.title = l('taskSettings')
  settingsBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    openWorkspaceModal(ws.id)
  })
  row.appendChild(settingsBtn)

  row.addEventListener('click', function (e) {
    if (e.target === restoreBtn || restoreBtn.contains(e.target)) return
    browserUI.restoreWorkspace(ws.id)
    workspaceDrawer.hide()
  })

  return row
}

var workspaceDrawer = {
  isShown: false,

  render: function () {
    empty(workspaceListEl)
    workspaces.getActive().forEach(function (ws) {
      workspaceListEl.appendChild(createWorkspaceRow(ws))
    })

    const archivedWorkspaces = workspaces.getArchived()
    if (archivedWorkspaces.length > 0) {
      const collapsed = settings.get('archivedWorkspacesCollapsed') === true

      const heading = document.createElement('button')
      heading.className = 'ws-section-heading'
      heading.setAttribute('aria-expanded', String(!collapsed))

      const chevron = document.createElement('span')
      chevron.className = 'ws-section-chevron i carbon:chevron-' + (collapsed ? 'right' : 'down')
      heading.appendChild(chevron)

      const label = document.createElement('span')
      label.className = 'ws-section-label'
      label.textContent = l('archivedWorkspacesHeading')
      heading.appendChild(label)

      const countEl = document.createElement('span')
      countEl.className = 'ws-row-badge'
      countEl.textContent = String(archivedWorkspaces.length)
      heading.appendChild(countEl)

      heading.addEventListener('click', function (e) {
        // stopPropagation keeps the document-level outside-click handler from
        // closing the drawer (the re-render detaches this element mid-bubble)
        e.stopPropagation()
        settings.set('archivedWorkspacesCollapsed', !collapsed)
        workspaceDrawer.render()
      })

      workspaceListEl.appendChild(heading)

      if (!collapsed) {
        archivedWorkspaces.forEach(function (ws) {
          workspaceListEl.appendChild(createArchivedWorkspaceRow(ws))
        })
      }
    }
  },

  show: function () {
    if (focusMode.enabled()) {
      focusMode.warn()
      return
    }
    webviews.requestPlaceholder('workspaceDrawer')
    document.body.classList.add('workspace-drawer-shown')
    document.body.setAttribute('data-context', 'workspaceDrawer')
    tabEditor.hide()
    this.isShown = true
    if (indicator) indicator.classList.add('active')
    this.render()
    drawer.hidden = false
    backdrop.hidden = false
  },

  hide: function () {
    if (!this.isShown) return
    this.isShown = false
    drawer.hidden = true
    backdrop.hidden = true
    setTimeout(function () {
      if (!workspaceDrawer.isShown) {
        empty(workspaceListEl)
        webviews.hidePlaceholder('workspaceDrawer')
      }
    }, 250)
    document.body.classList.remove('workspace-drawer-shown')
    document.body.removeAttribute('data-context')
    if (indicator) indicator.classList.remove('active')
    if (!tabs.getSelected()) {
      const mostRecent = tabs.get().sort(function (a, b) { return b.lastActivity - a.lastActivity })[0]
      if (mostRecent) browserUI.switchToTab(mostRecent.id)
    }
    try {
      const selected = tasks.getSelected()
      if (selected) {
        browserUI.switchToTask(selected.id)
        browserUI.switchToTab(tabs.getSelected())
      }
    } catch (e) {}
  },

  toggle: function () {
    if (this.isShown) this.hide()
    else this.show()
  },

  initialize: function () {
    if (indicator) {
      indicator.addEventListener('click', function (e) {
        e.stopPropagation()
        workspaceDrawer.toggle()
      })
    }

    addWorkspaceButton.addEventListener('click', function (e) {
      e.stopPropagation()
      openWorkspaceModal(null)
    })

    if (manageProfilesButton) {
      manageProfilesButton.addEventListener('click', function (e) {
        e.stopPropagation()
        workspaceDrawer.hide()
        openProfilesPage()
      })
    }

    workspaceModalSave.addEventListener('click', saveWorkspaceModal)
    workspaceModalCancel.addEventListener('click', closeWorkspaceModal)
    if (workspaceModalBrowseButton) {
      workspaceModalBrowseButton.addEventListener('click', function (e) {
        e.stopPropagation()
        browseWorkspacePath()
      })
    }
    if (workspaceModalClearPathButton) {
      workspaceModalClearPathButton.addEventListener('click', function (e) {
        e.stopPropagation()
        workspaceModalPathInput.value = ''
      })
    }
    workspaceModal.querySelector('.modal-close-button').addEventListener('click', closeWorkspaceModal)
    workspaceModalDelete.addEventListener('click', function () {
      const id = modalWorkspaceId
      closeWorkspaceModal()
      if (id) {
        browserUI.closeWorkspace(id)
        workspaceDrawer.render()
      }
    })
    workspaceModalNameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveWorkspaceModal()
      if (e.key === 'Escape') closeWorkspaceModal()
    })
    workspaceModalPathInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveWorkspaceModal()
      if (e.key === 'Escape') closeWorkspaceModal()
    })
    workspaceModal.addEventListener('click', function (e) {
      e.stopPropagation()
    })

    document.addEventListener('click', function (e) {
      if (workspaceModal && !workspaceModal.hidden) {
        if (!workspaceModal.contains(e.target)) closeWorkspaceModal()
        return
      }
      const promptEl = document.getElementById('app-prompt-modal')
      if (promptEl && !promptEl.hidden) return
      if (!workspaceDrawer.isShown) return
      if (backdrop && e.target === backdrop) {
        workspaceDrawer.hide()
        return
      }
      if (drawer.contains(e.target)) return
      if (indicator && indicator.contains(e.target)) return
      workspaceDrawer.hide()
    })

    const keybindings = require('keybindings.js')
    keybindings.defineShortcut('toggleTasks', function () {
      if (!workspaceModal.hidden) {
        closeWorkspaceModal()
        return
      }
      if (workspaceDrawer.isShown) workspaceDrawer.hide()
      else workspaceDrawer.show()
    })
    keybindings.defineShortcut({ keys: 'esc' }, function () {
      const promptEl = document.getElementById('app-prompt-modal')
      if (promptEl && !promptEl.hidden) return
      if (!workspaceModal.hidden) {
        closeWorkspaceModal()
        return
      }
      workspaceDrawer.hide()
    })
    keybindings.defineShortcut('enterEditMode', function () {
      if (!workspaceModal.hidden) return
      workspaceDrawer.hide()
    })

    if (manageProfilesButton) manageProfilesButton.title = l('taskProfileManage')

    const updateIndicator = function () {
      const ws = workspaces.getSelected()
      if (!ws || !indicatorName || !indicatorIcon) return
      const task = tasks.getSelected()
      const wsName = ws.name || l('defaultTaskName').replace('%n', workspaces.getIndex(ws.id) + 1)
      const name = task && task.name ? wsName + ' › ' + task.name : wsName
      indicatorName.textContent = name
      indicator.title = name
      const profile = profiles.getProfile(ws.profileId)
      if (profile) {
        indicatorIcon.classList.remove('i', 'carbon:user-multiple', 'carbon:user')
        indicatorIcon.textContent = (profile.name.trim()[0] || '?').toUpperCase()
        indicatorIcon.style.backgroundColor = profiles.getColor(profile.id)
        indicatorIcon.classList.add('profile-initial')
      } else {
        indicatorIcon.classList.remove('profile-initial')
        indicatorIcon.textContent = ''
        indicatorIcon.style.backgroundColor = ''
        indicatorIcon.classList.add('i', 'carbon:user-multiple')
      }
    }

    require('util/followTaskList.js').followTaskList(function (taskList) {
      taskList.on('task-selected', updateIndicator)
      taskList.on('task-updated', function (id, key) {
        if (key === 'name') updateIndicator()
      })
    })
    workspaces.on('workspace-selected', function () {
      updateIndicator()
      if (workspaceDrawer.isShown) workspaceDrawer.render()
    })
    workspaces.on('workspace-updated', function (id, key) {
      if (key === 'name' || key === 'profileId') updateIndicator()
      if (key === 'archived' && workspaceDrawer.isShown) workspaceDrawer.render()
    })
    workspaces.on('state-sync-change', function () {
      updateIndicator()
      if (workspaceDrawer.isShown) workspaceDrawer.render()
    })

    updateIndicator()
    window.workspaceDrawer = workspaceDrawer
  }
}

module.exports = workspaceDrawer
