/* Lifecycle helpers for Notes tabs. Notes are global, so a note tab is
 * identified by the tab's `kind`/`resource` metadata alone - never by which
 * workspace or task happens to contain it. The URL stays generic; the note id
 * reaches the page through the view's resource bridge (see HANDOVER §13). */

const NOTES_BASE = 'min://app/pages/notes/index.html'

let pageBindingsInstalled = false
const changedListeners = []

function normalizeId (value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function isNotesURL (url) {
  if (typeof url !== 'string') return false
  return url.split('#')[0].startsWith(NOTES_BASE)
}

function getNoteIdentity (tab) {
  if (!tab) return null
  if (tab.kind !== 'note' && !isNotesURL(tab.url)) return null
  const noteId = normalizeId(tab.resource)
  return noteId ? { noteId: noteId } : null
}

function getNotesURL () {
  return NOTES_BASE
}

function forEachWorkspace (callback) {
  if (typeof workspaces === 'undefined' || !workspaces) return

  if (typeof workspaces.forEach === 'function') {
    workspaces.forEach(callback)
    return
  }

  if (Array.isArray(workspaces.workspaces)) {
    workspaces.workspaces.forEach(callback)
  }
}

function getTabRecord (noteId) {
  const note = normalizeId(noteId)
  if (!note) return null

  let found = null
  forEachWorkspace(function (workspace) {
    if (found || !workspace || !workspace.tasks) return
    workspace.tasks.forEach(function (task) {
      if (found || !task || !task.tabs) return
      const entries = typeof task.tabs.get === 'function' ? task.tabs.get() : []
      entries.forEach(function (tab) {
        if (found || !tab) return
        const identity = getNoteIdentity(tab)
        if (identity && identity.noteId === note) {
          found = { id: tab.id, noteId: note, tab: tab, workspace: workspace, task: task }
        }
      })
    })
  })
  return found
}

function getTabRecordForId (tabId) {
  if (tabId === null || tabId === undefined) return null

  let found = null
  forEachWorkspace(function (workspace) {
    if (found || !workspace || !workspace.tasks) return
    workspace.tasks.forEach(function (task) {
      if (found || !task || !task.tabs) return
      const entries = typeof task.tabs.get === 'function' ? task.tabs.get() : []
      entries.forEach(function (tab) {
        if (!found && tab && String(tab.id) === String(tabId)) {
          const identity = getNoteIdentity(tab)
          if (identity) {
            found = {
              id: tab.id,
              noteId: identity.noteId,
              tab: tab,
              workspace: workspace,
              task: task
            }
          }
        }
      })
    })
  })
  return found
}

function findTab (noteId) {
  const record = getTabRecord(noteId)
  return record ? record.id : null
}

function selectedWorkspaceId () {
  if (typeof workspaces === 'undefined' || !workspaces || typeof workspaces.getSelected !== 'function') return null
  const workspace = workspaces.getSelected()
  return workspace ? normalizeId(workspace.id) : null
}

function emitChanged (change) {
  changedListeners.slice().forEach(function (listener) {
    try {
      listener(change)
    } catch (e) {
      // A stale sidebar listener must not break the Notes tab lifecycle.
    }
  })
}

function payloadFromArgs (args) {
  const payload = args && args[0]
  if (payload && typeof payload === 'object') return payload
  if (payload === undefined || payload === null) return {}
  return { value: payload }
}

function handleNoteChanged (tabId, args) {
  const record = getTabRecordForId(tabId)
  const payload = payloadFromArgs(args)
  emitChanged({
    noteId: (record && record.noteId) || normalizeId(payload.noteId || (payload.note && payload.note.id)),
    note: payload.note || null,
    deletedId: normalizeId(payload.deletedId),
    type: payload.type || 'save'
  })
}

function installPageBindings () {
  if (pageBindingsInstalled) return
  pageBindingsInstalled = true

  let webviews
  try {
    webviews = require('webviews.js')
  } catch (e) {
    return
  }
  if (!webviews || typeof webviews.bindIPC !== 'function') return

  // Support the kebab-case name used by the page bridge and the camelCase
  // spelling used by other Min preload relays. Each binding is installed once.
  ;['notes-changed', 'notesChanged', 'notes-saved', 'notesSaved'].forEach(function (name) {
    webviews.bindIPC(name, handleNoteChanged)
  })
}

function focusTab (record) {
  if (!record) return false

  let browserUI
  try {
    browserUI = require('browserUI.js')
  } catch (e) {
    return false
  }

  const selected = selectedWorkspaceId()
  if (record.workspace && selected !== normalizeId(record.workspace.id) && browserUI.switchToWorkspace) {
    browserUI.switchToWorkspace(record.workspace.id, { focusWebview: true })
  }
  if (record.task && browserUI.switchToTask) {
    browserUI.switchToTask(record.task.id, { focusWebview: false })
  }
  if (browserUI.switchToTab) {
    browserUI.switchToTab(record.id, { focusWebview: true })
  }
  return true
}

function open (noteId, title) {
  const note = normalizeId(noteId)
  if (!note) return null

  installPageBindings()

  const existing = getTabRecord(note)
  if (existing) {
    if (title && existing.task && existing.task.tabs && typeof existing.task.tabs.update === 'function') {
      existing.task.tabs.update(existing.id, { title: String(title) })
    }
    focusTab(existing)
    return existing.id
  }

  const selectedTabs = typeof tabs !== 'undefined' ? tabs : (tasks.getSelected() && tasks.getSelected().tabs)
  if (!selectedTabs || typeof selectedTabs.add !== 'function') return null

  const tabId = selectedTabs.add({
    url: getNotesURL(),
    kind: 'note',
    resource: note,
    title: title ? String(title) : '',
    private: false
  })

  let browserUI
  try {
    browserUI = require('browserUI.js')
  } catch (e) {
    browserUI = null
  }
  if (browserUI && browserUI.addTab) {
    browserUI.addTab(tabId, { enterEditMode: false })
  }
  return tabId
}

function updateTitle (noteId, title) {
  const record = getTabRecord(noteId)
  if (!record) return false
  const taskTabs = record.task ? record.task.tabs : null
  if (!taskTabs || typeof taskTabs.update !== 'function') return false
  taskTabs.update(record.id, { title: String(title || '') })
  return true
}

/* A note tab can live in any workspace's task. Closing one in the selected
 * workspace goes through the normal close path; anywhere else the tab record
 * and its live view are removed directly, and the tab is taken out of the
 * task's saved split layout so the remaining panes stay tiled. */
function removeFromSplitState (task, tabId) {
  const state = task && task.splitState
  if (!state || !Array.isArray(state.groups)) return
  state.groups = state.groups.filter(function (group) {
    if (!group || !Array.isArray(group.paneTabIds)) return false
    const index = group.paneTabIds.indexOf(tabId)
    if (index === -1) return true
    group.paneTabIds.splice(index, 1)
    if (Array.isArray(group.fractions)) group.fractions.splice(index, 1)
    if (typeof group.activePane === 'number' && group.activePane >= group.paneTabIds.length) {
      group.activePane = Math.max(0, group.paneTabIds.length - 1)
    }
    return group.paneTabIds.length >= 2
  })
}

function close (noteId) {
  const record = getTabRecord(noteId)
  if (!record) return false

  let browserUI
  try {
    browserUI = require('browserUI.js')
  } catch (e) {
    browserUI = null
  }

  const selected = selectedWorkspaceId()
  if (record.workspace && selected === normalizeId(record.workspace.id)) {
    if (browserUI && browserUI.closeTab) {
      return browserUI.closeTab(record.id, { skipDirtyCheck: true }) !== false
    }
    return false
  }

  // The tab's workspace is not the active one, so the shared `tabs` global
  // cannot see it; destroy the record in its own task instead. Notes save
  // continuously, so there is no dirty state to confirm.
  if (record.task && record.task.tabs && typeof record.task.tabs.destroy === 'function') {
    record.task.tabs.destroy(record.id)
  }
  removeFromSplitState(record.task, record.id)
  try {
    require('webviews.js').destroy(record.id)
  } catch (e) {}
  return true
}

const notesView = {
  baseURL: NOTES_BASE,
  isNotesURL: isNotesURL,
  getNoteIdentity: getNoteIdentity,
  getNotesURL: getNotesURL,
  getNoteURL: getNotesURL,
  findTab: findTab,
  open: open,
  updateTitle: updateTitle,
  close: close,
  closeNoteTab: close,
  initialize: installPageBindings,
  onChanged: function (listener) {
    if (typeof listener !== 'function') return function () {}
    changedListeners.push(listener)
    return function () {
      const index = changedListeners.indexOf(listener)
      if (index >= 0) changedListeners.splice(index, 1)
    }
  }
}

module.exports = notesView
