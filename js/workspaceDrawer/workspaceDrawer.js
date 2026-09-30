/* global ipc */
const browserUI = require('browserUI.js')
const webviews = require('webviews.js')
const tabEditor = require('navbar/tabEditor.js')
const focusMode = require('focusMode.js')
const profiles = require('profiles.js')
const settings = require('util/settings/settings.js')
const proSettingsPage = require('util/proSettingsPage.js')
const editorView = require('editorView.js')
const promptModal = require('promptModal.js')
const reconcileChildren = require('util/reconcileChildren.js')
const rowCache = new Map()
let archivedHeadingCache = null

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
let modalRevision = 0

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
  modalRevision++
  modalIsCreate = isCreate
  modalWorkspaceId = workspaceId || null

  if (isCreate) {
    workspaceModalTitle.textContent = l('workspaceCreateTitle')
    // prefill the default name, matching what an unnamed workspace row shows
    workspaceModalNameInput.value = l('defaultWorkspaceName').replace('%n', workspaces.getLength() + 1)
    populateProfileSelect(settings.get('defaultWorkspaceProfile') || '')
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

async function confirmWorkspaceDelete (id) {
  const ws = workspaces.get(id)
  const summary = browserUI.summarizeWorkspace(id)
  if (!ws || !summary) return false
  const name = ws.name || l('defaultWorkspaceName').replace('%n', workspaces.getIndex(id) + 1)
  // one pass with a function replacer, so a workspace named "%t" or "$&" stays literal
  const values = { w: name, t: String(summary.tasks), b: String(summary.tabs), n: String(summary.terminals) }
  const fill = text => text.replace(/%([wtbn])/g, (match, key) => values[key])
  let message = fill(l('workspaceDeleteConfirm'))
  if (summary.terminals > 0) {
    message += ' ' + fill(l('workspaceDeleteTerminals'))
  }
  return promptModal.confirm({
    title: l('workspaceDelete'),
    message: message,
    ok: l('workspaceDelete'),
    cancel: l('dialogSkipButton')
  })
}

function closeWorkspaceModal () {
  modalRevision++
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
  const revision = modalRevision
  try {
    const filePaths = await ipc.invoke('showOpenDialog', {
      properties: ['openDirectory']
    })
    if (revision === modalRevision && !workspaceModal.hidden && filePaths && filePaths.length > 0) {
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

/* tasks render as a sub-list under their workspace row. Clicking one switches
to the workspace first when it isn't the open one, then to the task itself. */

function switchToWorkspaceTask (ws, taskId) {
  const selected = workspaces.getSelected()
  if (!selected || selected.id !== ws.id) {
    browserUI.switchToWorkspace(ws.id)
  }
  browserUI.switchToTask(taskId)
  workspaceDrawer.hide()
}

/* browserUI.closeTask only knows the selected workspace's task list (the
`tasks` facade). For a task in a background workspace, destroy it through the
workspace's own list instead. */
function closeTaskInWorkspace (ws, task) {
  const selected = workspaces.getSelected()
  if (selected && selected.id === ws.id) {
    browserUI.closeTask(task.id)
    return
  }

  // same unsaved-editor guard as destroyTask, but checked against the task's
  // own tabs - the global `tabs` list only covers the selected workspace
  const discardable = task.tabs.get().every(function (tab) {
    if (editorView.isEditorTabData(tab) && webviews.isEditorDirty(tab.id)) {
      return typeof confirm !== 'function' || confirm('Discard unsaved changes in "' + (tab.title || '') + '"?')
    }
    return true
  })
  if (!discardable) {
    return
  }

  ipc.send('agent-destroy-task-session', { taskId: task.id })
  task.tabs.get().forEach(function (tab) {
    editorView.allowDiscard(tab.id)
    webviews.destroy(tab.id)
  })
  ws.tasks.destroy(task.id)
}

function cachedWorkspaceRows (ws, archived) {
  const selected = workspaces.getSelected()
  const selectedTask = selected === ws && tasks.getSelected()
  const collapsed = workspaces.isCollapsed(ws.id)
  const signature = JSON.stringify([
    workspaces.getIndex(ws.id), ws.name, ws.path, archived, collapsed,
    selected === ws, selectedTask && selectedTask.id,
    profiles.getProfile(ws.profileId), ws.profileId ? profiles.getColor(ws.profileId) : null,
    require('workspacePathStatus.js').isUsable(ws.id, ws.path),
    ws.tasks.map(task => [task.id, task.name, task.tabs.count()])
  ])
  const previous = rowCache.get(ws.id)
  if (previous && previous.signature === signature) return previous.nodes
  const nodes = archived ? [createArchivedWorkspaceRow(ws)] : [createWorkspaceRow(ws)]
  if (!archived && !collapsed) nodes.push(createTaskList(ws))
  rowCache.set(ws.id, { signature, nodes })
  return nodes
}

var workspaceDrawer = {
  isShown: false,

  render: function () {
    const scrollTop = workspaceListEl.scrollTop
    const desired = []
    rowCache.forEach((entry, id) => { if (!workspaces.get(id)) rowCache.delete(id) })
    workspaces.getActive().forEach(function (ws) {
      desired.push(...cachedWorkspaceRows(ws, false))
    })

    const archivedWorkspaces = workspaces.getArchived()
    if (archivedWorkspaces.length > 0) {
      const collapsed = settings.get('archivedWorkspacesCollapsed') === true

      const headingKey = String(collapsed) + ':' + archivedWorkspaces.length
      let heading = archivedHeadingCache && archivedHeadingCache.key === headingKey && archivedHeadingCache.node
      if (!heading) {
        heading = document.createElement('button')
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

        archivedHeadingCache = { key: headingKey, node: heading }
      }
      desired.push(heading)

      if (!collapsed) {
        archivedWorkspaces.forEach(function (ws) {
          desired.push(...cachedWorkspaceRows(ws, true))
        })
      }
    }
    reconcileChildren(workspaceListEl, desired)
    workspaceListEl.scrollTop = scrollTop
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
        rowCache.clear()
        archivedHeadingCache = null
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
    workspaceModalDelete.addEventListener('click', async function () {
      const id = modalWorkspaceId
      closeWorkspaceModal()
      if (!id) return
      // Unlike deleting a task there is no undo here: the workspace's documents
      // and AI chat history go with it, and its terminals are stopped.
      if (!(await confirmWorkspaceDelete(id))) return
      browserUI.closeWorkspace(id)
      workspaceDrawer.render()
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
      const wsName = ws.name || l('defaultWorkspaceName').replace('%n', workspaces.getIndex(ws.id) + 1)
      // same fallback as the drawer rows: unnamed tasks show "Task %n"
      const taskName = task ? (task.name || l('defaultTaskName').replace('%n', tasks.getIndex(task.id) + 1)) : null
      const name = taskName ? wsName + ' › ' + taskName : wsName
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

    tasks.on('task-selected', updateIndicator)
    tasks.on('task-updated', function (id, key) {
      if (key === 'name') updateIndicator()
    })

    /* keep the task sub-lists live while the drawer is open. `tasks.on` is the
    facade over the WorkspaceStore, so these fire for every workspace's list,
    not just the selected one. */
    let renderPending = false
    const renderIfShown = function () {
      if (!workspaceDrawer.isShown || renderPending) return
      renderPending = true
      requestAnimationFrame(function () {
        renderPending = false
        if (workspaceDrawer.isShown) workspaceDrawer.render()
      })
    }
    tasks.on('task-added', renderIfShown)
    tasks.on('task-destroyed', renderIfShown)
    tasks.on('task-moved', renderIfShown)
    tasks.on('task-selected', renderIfShown)
    tasks.on('task-updated', function (id, key) {
      if (key === 'name') renderIfShown()
    })
    tasks.on('tab-added', renderIfShown)
    tasks.on('tab-destroyed', renderIfShown)
    tasks.on('tab-splice', renderIfShown)
    workspaces.on('workspace-added', renderIfShown)
    workspaces.on('workspace-destroyed', renderIfShown)
    workspaces.on('workspace-selected', function () {
      updateIndicator()
      renderIfShown()
    })

    /* the folder check finishes after the rows are built, so rebuild them once
    the answer is in to show or clear the missing-folder warning */
    require('workspacePathStatus.js').onChange(function () {
      updateIndicator()
      renderIfShown()
    })
    workspaces.on('workspace-updated', function (id, key) {
      if (key === 'name' || key === 'profileId') updateIndicator()
      if (['archived', 'collapsed', 'name', 'profileId', 'path'].includes(key)) renderIfShown()
    })
    workspaces.on('state-sync-change', function () {
      updateIndicator()
      renderIfShown()
    })

    updateIndicator()
    window.workspaceDrawer = workspaceDrawer
  }
}

const { createWorkspaceRow, createTaskList, createArchivedWorkspaceRow } = require('workspaceDrawer/workspaceRows.js')({
  browserUI, profiles, workspaceDrawer, openWorkspaceModal, closeTaskInWorkspace, switchToWorkspaceTask
})

module.exports = workspaceDrawer
