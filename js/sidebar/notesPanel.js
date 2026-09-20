/* global ipc, l, empty */

/* Global note list for the Notes activity. Notes are not scoped to a
 * workspace: the same list shows in every workspace, including ones without a
 * folder path. They are also user-only by design - unlike documents there is
 * no privacy toggle because no AI code path can ever read a note. */

const customDataStore = require('util/customDataStore.js')
const notesView = require('notesView.js')
const promptModal = require('promptModal.js')
const sidebarUI = require('sidebar/ui.js')
const formatRelativeDate = require('util/relativeDate.js')

const panel = document.getElementById('sidebar-panel-notes')

let notes = []
let isLoading = false
let lastError = null
let refreshSequence = 0
let creating = false
let queuedEventRefresh = false

function t (key, fallback) {
  const value = l(key)
  return typeof value === 'string' && value ? value : fallback
}

function normalizeId (value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function normalizeNote (note) {
  if (!note || typeof note !== 'object') return null
  const id = normalizeId(note.id || note.note_id)
  if (!id) return null
  return Object.assign({}, note, {
    id: id,
    title: note.title ? String(note.title) : t('notesUntitled', 'Untitled')
  })
}

function notesFromResult (result) {
  if (Array.isArray(result)) return result.map(normalizeNote).filter(Boolean)
  if (!result || typeof result !== 'object') return []
  const list = Array.isArray(result.notes)
    ? result.notes
    : (Array.isArray(result.items) ? result.items : [])
  return list.map(normalizeNote).filter(Boolean)
}

function noteFromResult (result) {
  if (!result || typeof result !== 'object') return null
  return normalizeNote(result.note || result)
}

function resultError (result, fallback) {
  if (result && result.error) return String(result.error)
  return fallback
}

function ensureStoreMethod (name) {
  if (!customDataStore || typeof customDataStore[name] !== 'function') {
    throw new Error('Note storage is unavailable')
  }
  return customDataStore[name]
}

function operationSucceeded (result) {
  return !!result && result.ok !== false && !result.error
}

function sortNotes (list) {
  return list.slice().sort(function (a, b) {
    const aTime = Number(a.updated_at || a.updatedAt || 0)
    const bTime = Number(b.updated_at || b.updatedAt || 0)
    if (aTime !== bTime) return bTime - aTime
    const aTitle = String(a.title || '').toLocaleLowerCase()
    const bTitle = String(b.title || '').toLocaleLowerCase()
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle)
    return String(a.id).localeCompare(String(b.id))
  })
}

function isCurrentRefresh (sequence) {
  return sequence === refreshSequence
}

function buildHeader () {
  return sidebarUI.createPanelHeader({
    title: t('sidebarNotes', 'Notes'),
    className: 'notes-header',
    actions: [{
      icon: 'codicon-add',
      label: t('notesNew', 'New note'),
      disabled: creating,
      onClick: function (event) {
        event.stopPropagation()
        createNote()
      }
    }, {
      icon: 'codicon-refresh',
      label: t('notesRefresh', 'Refresh'),
      disabled: isLoading,
      onClick: function (event) {
        event.stopPropagation()
        refresh()
      }
    }]
  })
}

function buildEmptyState () {
  return sidebarUI.createEmptyState({
    icon: 'codicon-note',
    message: t('notesEmpty', 'No notes yet.'),
    actionLabel: t('notesNew', 'New note'),
    actionDisabled: creating,
    onAction: function (event) {
      event.stopPropagation()
      createNote()
    }
  })
}

function buildErrorState () {
  const state = document.createElement('div')
  state.className = 'notes-error'
  state.setAttribute('role', 'alert')
  const message = document.createElement('span')
  message.textContent = lastError
  state.appendChild(message)
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'notes-retry-button'
  retry.textContent = t('notesRefresh', 'Refresh')
  retry.addEventListener('click', function (event) {
    event.stopPropagation()
    refresh()
  })
  state.appendChild(retry)
  return state
}

function buildRow (noteData) {
  const row = document.createElement('div')
  row.className = 'notes-row'
  row.dataset.noteId = noteData.id
  row.tabIndex = 0
  row.setAttribute('role', 'button')

  const icon = document.createElement('i')
  icon.className = 'notes-row-icon codicon codicon-note'
  icon.setAttribute('aria-hidden', 'true')
  row.appendChild(icon)

  const content = document.createElement('div')
  content.className = 'notes-row-content'
  const name = document.createElement('div')
  name.className = 'notes-row-title'
  name.textContent = noteData.title
  name.title = noteData.title
  content.appendChild(name)

  const updated = Number(noteData.updated_at || noteData.updatedAt || 0)
  if (updated > 0) {
    const meta = document.createElement('div')
    meta.className = 'notes-row-meta'
    meta.textContent = formatRelativeDate(updated)
    content.appendChild(meta)
  }
  row.appendChild(content)

  const actions = document.createElement('div')
  actions.className = 'notes-row-actions'

  const rename = document.createElement('button')
  rename.type = 'button'
  rename.className = 'codicon codicon-rename git-icon-button'
  rename.title = t('notesRename', 'Rename')
  rename.setAttribute('aria-label', rename.title)
  rename.addEventListener('click', function (event) {
    event.stopPropagation()
    renameNote(noteData)
  })
  actions.appendChild(rename)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'codicon codicon-trash git-icon-button'
  remove.title = t('notesDelete', 'Delete')
  remove.setAttribute('aria-label', remove.title)
  remove.addEventListener('click', function (event) {
    event.stopPropagation()
    deleteNote(noteData)
  })
  actions.appendChild(remove)
  row.appendChild(actions)

  function openRow (event) {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
    if (event.type === 'keydown') event.preventDefault()
    notesView.open(noteData.id, noteData.title)
  }
  row.addEventListener('click', openRow)
  row.addEventListener('keydown', openRow)
  return row
}

function render () {
  if (!panel) return
  empty(panel)
  panel.appendChild(buildHeader())

  const body = document.createElement('div')
  body.className = 'notes-body'
  panel.appendChild(body)

  if (isLoading && notes.length === 0) {
    const loading = document.createElement('div')
    loading.className = 'notes-loading'
    loading.textContent = t('notesLoading', 'Loading…')
    body.appendChild(loading)
  } else if (notes.length === 0) {
    body.appendChild(buildEmptyState())
  } else {
    sortNotes(notes).forEach(function (noteData) {
      body.appendChild(buildRow(noteData))
    })
  }

  if (lastError) body.appendChild(buildErrorState())
}

async function refresh (options) {
  options = options || {}
  const sequence = ++refreshSequence

  if (!options.silent || notes.length === 0) {
    isLoading = true
    render()
  }

  try {
    const result = await ensureStoreMethod('listNotes')()
    if (!isCurrentRefresh(sequence)) return null
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('notesLoadError', 'Could not load notes')))
    }
    notes = sortNotes(notesFromResult(result))
    lastError = null
    isLoading = false
    render()
    return notes
  } catch (error) {
    if (!isCurrentRefresh(sequence)) return null
    isLoading = false
    lastError = error && error.message ? error.message : t('notesLoadError', 'Could not load notes')
    render()
    return null
  }
}

async function createNote () {
  if (creating) return null
  creating = true
  render()

  let title
  try {
    title = await promptModal.prompt({
      title: t('notesNew', 'New note'),
      label: t('notesTitle', 'Note title'),
      value: t('notesUntitled', 'Untitled'),
      ok: t('notesSave', 'Save'),
      cancel: l('dialogSkipButton') || 'Cancel'
    })
  } catch (error) {
    title = null
  }

  if (!title) {
    creating = false
    render()
    return null
  }

  try {
    const result = await ensureStoreMethod('createNote')(title)
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('notesCreateError', 'Could not create note')))
    }
    const created = noteFromResult(result)
    lastError = null
    await refresh({ silent: true })
    if (created && created.id) {
      notesView.open(created.id, created.title)
    }
    return created
  } catch (error) {
    lastError = error && error.message ? error.message : t('notesCreateError', 'Could not create note')
    return null
  } finally {
    creating = false
    render()
  }
}

async function renameNote (noteData) {
  if (!noteData) return null
  const title = await promptModal.prompt({
    title: t('notesRename', 'Rename'),
    label: t('notesTitle', 'Note title'),
    value: noteData.title,
    ok: t('notesSave', 'Save'),
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!title) return null

  try {
    const result = await ensureStoreMethod('updateNote')(noteData.id, { title: title })
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('notesRenameError', 'Could not rename note')))
    }
    notesView.updateTitle(noteData.id, title)
    lastError = null
    await refresh({ silent: true })
    return noteFromResult(result)
  } catch (error) {
    lastError = error && error.message ? error.message : t('notesRenameError', 'Could not rename note')
    render()
    return null
  }
}

async function deleteNote (noteData) {
  if (!noteData) return false
  const confirmed = await promptModal.confirm({
    title: t('notesDelete', 'Delete'),
    message: t('notesDeleteConfirm', 'Delete note "%s"? This cannot be undone.').replace('%s', noteData.title),
    ok: t('notesDelete', 'Delete'),
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!confirmed) return false

  try {
    const result = await ensureStoreMethod('deleteNote')(noteData.id)
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('notesDeleteError', 'Could not delete note')))
    }
    notesView.close(noteData.id)
    lastError = null
    await refresh({ silent: true })
    return true
  } catch (error) {
    lastError = error && error.message ? error.message : t('notesDeleteError', 'Could not delete note')
    render()
    return false
  }
}

function onNotesChanged () {
  queueRefresh()
}

/* Saves from open note tabs and panel CRUD can arrive together; coalesce them
 * so one burst causes one list read, while refreshSequence still invalidates
 * any response that was already in flight. */
function queueRefresh () {
  if (queuedEventRefresh) return
  queuedEventRefresh = true
  setTimeout(function () {
    queuedEventRefresh = false
    refresh({ silent: true })
  }, 0)
}

const notesPanel = {
  initialize: function () {
    if (!panel) return
    notesView.initialize()
    render()

    if (notesView && typeof notesView.onChanged === 'function') {
      notesView.onChanged(function () {
        queueRefresh()
      })
    }

    if (typeof ipc !== 'undefined' && ipc && typeof ipc.on === 'function') {
      ipc.on('notes-changed', onNotesChanged)
      ipc.on('notesChanged', onNotesChanged)
    }

    notes = []
    isLoading = true
    render()
    refresh()
  },
  refresh: refresh,
  render: render,
  getNotes: function () { return notes.slice() }
}

module.exports = notesPanel
