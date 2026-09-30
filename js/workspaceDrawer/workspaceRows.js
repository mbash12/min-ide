module.exports = function ({ browserUI, profiles, workspaceDrawer, openWorkspaceModal, closeTaskInWorkspace, switchToWorkspaceTask }) {
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

  function createWorkspaceRow (ws) {
    const row = document.createElement('div')
    row.className = 'ws-row'
    if (workspaces.getSelected() && ws.id === workspaces.getSelected().id) {
      row.classList.add('selected')
    }
    row.setAttribute('data-workspace', ws.id)

    const collapsed = workspaces.isCollapsed(ws.id)
    const collapseBtn = document.createElement('button')
    collapseBtn.className = 'ws-row-collapse i carbon:chevron-' + (collapsed ? 'right' : 'down')
    collapseBtn.setAttribute('aria-expanded', String(!collapsed))
    collapseBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      workspaces.update(ws.id, { collapsed: !collapsed })
      workspaceDrawer.render()
    })
    row.appendChild(collapseBtn)

    const profile = profiles.getProfile(ws.profileId)
    row.appendChild(profile ? profileInitial(profile) : defaultInitial())

    const mainEl = document.createElement('span')
    mainEl.className = 'ws-row-main'
    const nameEl = document.createElement('span')
    nameEl.className = 'ws-row-name'
    nameEl.textContent = ws.name || l('defaultWorkspaceName').replace('%n', workspaces.getIndex(ws.id) + 1)
    mainEl.appendChild(nameEl)

    if (ws.path) {
      const pathEl = document.createElement('span')
      pathEl.className = 'ws-row-path'
      pathEl.textContent = ws.path
      pathEl.title = ws.path
      // the folder is gone: say so instead of pretending the workspace still has
      // files, and leave the stored path in place so the user can replace it (§8)
      if (require('workspacePathStatus.js').isUsable(ws.id, ws.path) === false) {
        const warning = document.createElement('span')
        warning.className = 'codicon codicon-warning ws-row-warning'
        warning.title = l('workspaceFolderMissing')
        mainEl.appendChild(warning)
        pathEl.classList.add('ws-row-path-missing')
        pathEl.title = l('workspaceFolderMissing')
      }
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

  function createTaskRow (ws, task, index) {
    const row = document.createElement('div')
    row.className = 'ws-task-row'
    // the facade only resolves the active workspace's list, so background
    // workspaces never highlight - their own getSelected() keeps a stale
    // selectedInWindow from when they were last open
    const selectedTask = tasks.getSelected()
    if (selectedTask && task.id === selectedTask.id) {
      row.classList.add('selected')
    }
    row.setAttribute('data-task', task.id)

    const nameEl = document.createElement('span')
    nameEl.className = 'ws-task-name'
    nameEl.textContent = task.name || l('defaultTaskName').replace('%n', index + 1)
    row.appendChild(nameEl)

    const badge = document.createElement('span')
    badge.className = 'ws-row-badge'
    const count = task.tabs.count()
    badge.textContent = String(count)
    badge.title = count === 1 ? '1 tab' : count + ' tabs'
    row.appendChild(badge)

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'ws-row-settings i carbon:trash-can'
    deleteBtn.title = l('taskDelete')
    deleteBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      closeTaskInWorkspace(ws, task)
      workspaceDrawer.render()
    })
    row.appendChild(deleteBtn)

    row.addEventListener('click', function () {
      switchToWorkspaceTask(ws, task.id)
    })

    return row
  }

  function createTaskList (ws) {
    const list = document.createElement('div')
    list.className = 'ws-task-list'

    ws.tasks.forEach(function (task, index) {
      list.appendChild(createTaskRow(ws, task, index))
    })

    const addButton = document.createElement('button')
    addButton.className = 'ws-task-add'

    const addIcon = document.createElement('i')
    addIcon.className = 'i carbon:add'
    addButton.appendChild(addIcon)

    const addLabel = document.createElement('span')
    addLabel.textContent = l('newTask')
    addButton.appendChild(addLabel)

    addButton.addEventListener('click', function (e) {
      e.stopPropagation()
      const selected = workspaces.getSelected()
      if (selected && selected.id === ws.id) {
        browserUI.addTask()
      } else {
        const taskId = ws.tasks.add({})
        browserUI.switchToWorkspace(ws.id)
        browserUI.switchToTask(taskId)
      }
      workspaceDrawer.hide()
    })
    list.appendChild(addButton)

    return list
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
    nameEl.textContent = ws.name || l('defaultWorkspaceName').replace('%n', workspaces.getIndex(ws.id) + 1)
    mainEl.appendChild(nameEl)

    if (ws.path) {
      const pathEl = document.createElement('span')
      pathEl.className = 'ws-row-path'
      pathEl.textContent = ws.path
      pathEl.title = ws.path
      // the folder is gone: say so instead of pretending the workspace still has
      // files, and leave the stored path in place so the user can replace it (§8)
      if (require('workspacePathStatus.js').isUsable(ws.id, ws.path) === false) {
        const warning = document.createElement('span')
        warning.className = 'codicon codicon-warning ws-row-warning'
        warning.title = l('workspaceFolderMissing')
        mainEl.appendChild(warning)
        pathEl.classList.add('ws-row-path-missing')
        pathEl.title = l('workspaceFolderMissing')
      }
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

  return { createWorkspaceRow, createTaskList, createArchivedWorkspaceRow }
}
