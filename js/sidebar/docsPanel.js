/* global ipc, l, tasks, empty */

/* Workspace-scoped document list for the Docs activity. Documents are kept in
 * Min's local data store, so this panel is available for workspaces without a
 * folder path as well. */

const customDataStore = require('util/customDataStore.js')
const docsView = require('docsView.js')
const promptModal = require('promptModal.js')
const sidebarUI = require('sidebar/ui.js')

const panel = document.getElementById('sidebar-panel-docs')

let currentWorkspaceId = null
let documents = []
let isLoading = false
let lastError = null
let refreshSequence = 0
let creating = false
let queuedEventRefresh = null
let refreshRequestNumber = 0
const latestRefreshRequestByWorkspace = new Map()
const privateUpdateSequences = new Map()

function t (key, fallback) {
  const value = l(key)
  return typeof value === 'string' && value ? value : fallback
}

function normalizeId (value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function workspaceIdFromSelection () {
  if (typeof workspaces === 'undefined' || !workspaces || typeof workspaces.getSelected !== 'function') return null
  const workspace = workspaces.getSelected()
  return workspace ? normalizeId(workspace.id) : null
}

function workspaceIdForEvent (value) {
  const selected = workspaceIdFromSelection()
  const eventId = value !== null && value !== undefined && value !== ''
    ? (typeof value === 'object' ? (value.workspaceId || value.workspace_id) : value)
    : null
  return normalizeId(eventId) || selected
}

function normalizeDocument (document) {
  if (!document || typeof document !== 'object') return null
  const id = normalizeId(document.id || document.document_id)
  if (!id) return null
  return Object.assign({}, document, {
    id: id,
    title: document.title ? String(document.title) : t('docsUntitled', 'Untitled'),
    private: document.private === true
  })
}

function documentsFromResult (result) {
  if (Array.isArray(result)) return result.map(normalizeDocument).filter(Boolean)
  if (!result || typeof result !== 'object') return []
  const list = Array.isArray(result.documents)
    ? result.documents
    : (Array.isArray(result.items) ? result.items : [])
  return list.map(normalizeDocument).filter(Boolean)
}

function documentFromResult (result) {
  if (!result || typeof result !== 'object') return null
  return normalizeDocument(result.document || result)
}

function resultError (result, fallback) {
  if (result && result.error) return String(result.error)
  return fallback
}

function ensureStoreMethod (name) {
  if (!customDataStore || typeof customDataStore[name] !== 'function') {
    throw new Error('Document storage is unavailable')
  }
  return customDataStore[name]
}

function operationSucceeded (result) {
  return !!result && result.ok !== false && !result.error
}

function sortDocuments (list) {
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

function isCurrentRefresh (workspaceId, sequence) {
  if (workspaceId !== currentWorkspaceId || sequence !== refreshSequence) return false
  const selected = workspaceIdFromSelection()
  return !selected || selected === workspaceId
}

function buildHeader () {
  return sidebarUI.createPanelHeader({
    title: t('sidebarDocs', 'Docs'),
    className: 'docs-header',
    actions: [{
      icon: 'codicon-add',
      label: t('docsNew', 'New document'),
      disabled: !currentWorkspaceId || creating,
      onClick: function (event) {
        event.stopPropagation()
        createDocument()
      }
    }, {
      icon: 'codicon-refresh',
      label: t('docsRefresh', 'Refresh'),
      disabled: !currentWorkspaceId || isLoading,
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
    message: t('docsEmpty', 'No documents yet.'),
    actionLabel: t('docsNew', 'New document'),
    actionDisabled: creating,
    onAction: function (event) {
      event.stopPropagation()
      createDocument()
    }
  })
}

function buildErrorState () {
  const state = document.createElement('div')
  state.className = 'docs-error'
  state.setAttribute('role', 'alert')
  const message = document.createElement('span')
  message.textContent = lastError
  state.appendChild(message)
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'docs-retry-button'
  retry.textContent = t('docsRefresh', 'Refresh')
  retry.addEventListener('click', function (event) {
    event.stopPropagation()
    refresh()
  })
  state.appendChild(retry)
  return state
}

function buildRow (documentData) {
  const isPrivate = documentData.private === true
  const row = document.createElement('div')
  row.className = 'docs-row' + (isPrivate ? ' private' : '')
  row.dataset.documentId = documentData.id
  row.tabIndex = 0
  row.setAttribute('role', 'button')

  const icon = document.createElement('i')
  icon.className = 'docs-row-icon codicon codicon-note'
  icon.setAttribute('aria-hidden', 'true')
  row.appendChild(icon)

  const content = document.createElement('div')
  content.className = 'docs-row-content'
  const name = document.createElement('div')
  name.className = 'docs-row-title'
  name.textContent = documentData.title
  name.title = documentData.title
  content.appendChild(name)
  if (isPrivate) {
    const meta = document.createElement('div')
    meta.className = 'docs-row-meta'
    meta.textContent = t('docsPrivateHint', 'Private documents are unavailable to AI.')
    content.appendChild(meta)
  }
  row.appendChild(content)

  const privacy = document.createElement('button')
  privacy.type = 'button'
  privacy.className = 'docs-row-privacy'
  privacy.title = isPrivate
    ? t('docsPrivateHint', 'Private documents are unavailable to AI.')
    : t('docsMakePrivate', 'Make private')
  privacy.setAttribute('aria-label', privacy.title)
  privacy.setAttribute('aria-pressed', String(isPrivate))
  const lock = document.createElement('i')
  lock.className = 'docs-lock-icon codicon ' + (isPrivate ? 'codicon-lock' : 'codicon-unlock')
  lock.setAttribute('aria-hidden', 'true')
  privacy.appendChild(lock)
  privacy.addEventListener('click', function (event) {
    event.stopPropagation()
    updatePrivate(documentData, privacy, !isPrivate)
  })
  row.appendChild(privacy)

  const actions = document.createElement('div')
  actions.className = 'docs-row-actions'

  const rename = document.createElement('button')
  rename.type = 'button'
  rename.className = 'codicon codicon-rename git-icon-button'
  rename.title = t('docsRename', 'Rename')
  rename.setAttribute('aria-label', rename.title)
  rename.addEventListener('click', function (event) {
    event.stopPropagation()
    renameDocument(documentData)
  })
  actions.appendChild(rename)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'codicon codicon-trash git-icon-button'
  remove.title = t('docsDelete', 'Delete')
  remove.setAttribute('aria-label', remove.title)
  remove.addEventListener('click', function (event) {
    event.stopPropagation()
    deleteDocument(documentData)
  })
  actions.appendChild(remove)
  row.appendChild(actions)

  function openRow (event) {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
    if (event.type === 'keydown') event.preventDefault()
    if (!currentWorkspaceId) return
    docsView.open(currentWorkspaceId, documentData.id, documentData.title)
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
  body.className = 'docs-body'
  panel.appendChild(body)

  if (!currentWorkspaceId) {
    const message = document.createElement('div')
    message.className = 'docs-empty-message docs-no-workspace'
    message.textContent = t('docsNoWorkspace', 'No workspace selected.')
    body.appendChild(message)
    return
  }

  if (isLoading && documents.length === 0) {
    const loading = document.createElement('div')
    loading.className = 'docs-loading'
    loading.textContent = t('docsLoading', 'Loading…')
    body.appendChild(loading)
  } else if (documents.length === 0) {
    body.appendChild(buildEmptyState())
  } else {
    sortDocuments(documents).forEach(function (documentData) {
      body.appendChild(buildRow(documentData))
    })
  }

  if (lastError) body.appendChild(buildErrorState())
}

async function refresh (options) {
  options = options || {}
  const requestedWorkspaceId = normalizeId(options.workspaceId !== undefined
    ? options.workspaceId
    : workspaceIdFromSelection())

  if (requestedWorkspaceId !== currentWorkspaceId) {
    currentWorkspaceId = requestedWorkspaceId
    documents = []
    lastError = null
  }

  const sequence = ++refreshSequence
  const requestNumber = ++refreshRequestNumber
  latestRefreshRequestByWorkspace.set(requestedWorkspaceId, requestNumber)
  if (!requestedWorkspaceId) {
    isLoading = false
    documents = []
    render()
    return []
  }

  if (!options.silent || documents.length === 0) {
    isLoading = true
    render()
  }

  try {
    const result = await ensureStoreMethod('listDocuments')(requestedWorkspaceId)
    if (!isCurrentRefresh(requestedWorkspaceId, sequence)) return null
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('docsLoadError', 'Could not load documents')))
    }
    documents = sortDocuments(documentsFromResult(result))
    lastError = null
    isLoading = false
    render()
    return documents
  } catch (error) {
    if (!isCurrentRefresh(requestedWorkspaceId, sequence)) return null
    isLoading = false
    lastError = error && error.message ? error.message : t('docsLoadError', 'Could not load documents')
    render()
    return null
  }
}

async function createDocument () {
  const workspaceId = currentWorkspaceId || workspaceIdFromSelection()
  if (!workspaceId || creating) return null
  creating = true
  render()

  let title
  try {
    title = await promptModal.prompt({
      title: t('docsNew', 'New document'),
      label: t('docsTitle', 'Document title'),
      value: t('docsUntitled', 'Untitled'),
      ok: t('docsSave', 'Save'),
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
    const result = await ensureStoreMethod('createDocument')(workspaceId, title)
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('docsCreateError', 'Could not create document')))
    }
    const created = documentFromResult(result)
    lastError = null
    await refresh({ workspaceId: workspaceId, silent: true })
    if (created && created.id && currentWorkspaceId === workspaceId && workspaceIdFromSelection() === workspaceId) {
      docsView.open(workspaceId, created.id, created.title)
    }
    return created
  } catch (error) {
    if (currentWorkspaceId === workspaceId) {
      lastError = error && error.message ? error.message : t('docsCreateError', 'Could not create document')
    }
    return null
  } finally {
    creating = false
    if (currentWorkspaceId === workspaceId) render()
  }
}

async function renameDocument (documentData) {
  const workspaceId = currentWorkspaceId
  if (!workspaceId || !documentData) return null
  const title = await promptModal.prompt({
    title: t('docsRename', 'Rename'),
    label: t('docsTitle', 'Document title'),
    value: documentData.title,
    ok: t('docsSave', 'Save'),
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!title || currentWorkspaceId !== workspaceId) return null

  try {
    const result = await ensureStoreMethod('updateDocument')(workspaceId, documentData.id, { title: title })
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('docsRenameError', 'Could not rename document')))
    }
    docsView.updateTitle(workspaceId, documentData.id, title)
    lastError = null
    await refresh({ workspaceId: workspaceId, silent: true })
    return documentFromResult(result)
  } catch (error) {
    if (currentWorkspaceId === workspaceId) {
      lastError = error && error.message ? error.message : t('docsRenameError', 'Could not rename document')
      render()
    }
    return null
  }
}

async function deleteDocument (documentData) {
  const workspaceId = currentWorkspaceId
  if (!workspaceId || !documentData) return false
  const confirmed = await promptModal.confirm({
    title: t('docsDelete', 'Delete'),
    message: t('docsDeleteConfirm', 'Delete document "%s"? This cannot be undone.').replace('%s', documentData.title),
    ok: t('docsDelete', 'Delete'),
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!confirmed || currentWorkspaceId !== workspaceId) return false

  try {
    const result = await ensureStoreMethod('deleteDocument')(workspaceId, documentData.id)
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('docsDeleteError', 'Could not delete document')))
    }
    docsView.close(workspaceId, documentData.id)
    lastError = null
    await refresh({ workspaceId: workspaceId, silent: true })
    return true
  } catch (error) {
    if (currentWorkspaceId === workspaceId) {
      lastError = error && error.message ? error.message : t('docsDeleteError', 'Could not delete document')
      render()
    }
    return false
  }
}

async function updatePrivate (documentData, input, value) {
  const workspaceId = currentWorkspaceId
  if (!workspaceId || !documentData || !input) return
  const sequence = (privateUpdateSequences.get(documentData.id) || 0) + 1
  privateUpdateSequences.set(documentData.id, sequence)
  const desired = value === true
  input.disabled = true
  input.setAttribute('aria-busy', 'true')

  try {
    const result = await ensureStoreMethod('updateDocument')(workspaceId, documentData.id, { private: desired })
    if (privateUpdateSequences.get(documentData.id) !== sequence) return
    if (!operationSucceeded(result)) {
      throw new Error(resultError(result, t('docsSaveError', 'Could not save document')))
    }
    const stored = documents.find(function (entry) { return entry.id === documentData.id })
    if (stored) stored.private = desired
    lastError = null
    render()
  } catch (error) {
    if (privateUpdateSequences.get(documentData.id) !== sequence) return
    if (currentWorkspaceId === workspaceId) {
      lastError = error && error.message ? error.message : t('docsSaveError', 'Could not save document')
      render()
    }
  } finally {
    input.removeAttribute('aria-busy')
    input.disabled = false
  }
}

function onWorkspaceChange (workspaceId) {
  const selected = workspaceIdFromSelection()
  const next = workspaceIdForEvent(workspaceId)
  if (workspaceId !== null && workspaceId !== undefined && workspaceId !== '' && selected && next !== selected) return
  if (next === currentWorkspaceId) return

  refreshSequence++
  currentWorkspaceId = next
  documents = []
  lastError = null
  isLoading = !!next
  render()
  refresh({ workspaceId: next, silent: true })
}

function onDocumentsChanged (event, value) {
  const eventWorkspaceId = workspaceIdForEvent(value)
  if (!eventWorkspaceId || eventWorkspaceId !== currentWorkspaceId) return
  queueRefresh(eventWorkspaceId)
}

/* The main process broadcast and the Docs page relay can describe the same
 * save. Coalesce callbacks delivered in one turn so one save causes one list
 * read, while still invalidating stale responses with refreshSequence. */
function queueRefresh (workspaceId) {
  if (queuedEventRefresh && queuedEventRefresh.workspaceId === workspaceId) return
  queuedEventRefresh = { workspaceId: workspaceId, requestNumber: refreshRequestNumber }
  setTimeout(function () {
    const queued = queuedEventRefresh
    queuedEventRefresh = null
    if (!queued || queued.workspaceId !== currentWorkspaceId) return
    // A CRUD action may have already started its explicit refresh before the
    // broadcast callback runs. That request supersedes this queued one.
    if (latestRefreshRequestByWorkspace.get(queued.workspaceId) > queued.requestNumber) return
    refresh({ workspaceId: queued.workspaceId, silent: true })
  }, 0)
}

const docsPanel = {
  initialize: function () {
    if (!panel) return
    docsView.initialize()
    render()

    if (typeof workspaces !== 'undefined' && workspaces && typeof workspaces.on === 'function') {
      workspaces.on('workspace-selected', onWorkspaceChange)
    }

    if (docsView && typeof docsView.onChanged === 'function') {
      docsView.onChanged(function (change) {
        if (!change || normalizeId(change.workspaceId) !== currentWorkspaceId) return
        queueRefresh(currentWorkspaceId)
      })
    }

    if (typeof ipc !== 'undefined' && ipc && typeof ipc.on === 'function') {
      ipc.on('docs-changed', onDocumentsChanged)
      ipc.on('docsChanged', onDocumentsChanged)
    }

    currentWorkspaceId = workspaceIdFromSelection()
    documents = []
    isLoading = !!currentWorkspaceId
    render()
    refresh({ workspaceId: currentWorkspaceId })
  },
  refresh: refresh,
  render: render,
  getWorkspaceId: function () { return currentWorkspaceId },
  getDocuments: function () { return documents.slice() }
}

module.exports = docsPanel
