/* Lifecycle helpers for workspace Docs tabs. A Docs tab is identified by both
 * the workspace and document query parameters; a document id by itself is
 * deliberately never enough to reuse a tab. */

const DOCS_BASE = 'min://app/pages/docs/index.html'

let pageBindingsInstalled = false
const changedListeners = []

function normalizeId (value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function isDocsURL (url) {
  if (typeof url !== 'string') return false
  return url.split('#')[0].startsWith(DOCS_BASE)
}

function getDocumentIdentity (url) {
  if (!isDocsURL(url)) return null

  try {
    const parsed = new URL(url)
    const workspaceId = normalizeId(parsed.searchParams.get('workspace'))
    const documentId = normalizeId(parsed.searchParams.get('doc'))
    if (!workspaceId || !documentId) return null
    return { workspaceId: workspaceId, documentId: documentId }
  } catch (e) {
    return null
  }
}

function getDocsURL (workspaceId, documentId) {
  const ws = normalizeId(workspaceId)
  const doc = normalizeId(documentId)
  if (!ws || !doc) return null
  return DOCS_BASE + '?workspace=' + encodeURIComponent(ws) + '&doc=' + encodeURIComponent(doc)
}

function forEachWorkspace (callback) {
  if (typeof tasks === 'undefined' || !tasks) return

  if (typeof tasks.forEach === 'function') {
    tasks.forEach(callback)
    return
  }

  if (Array.isArray(tasks.workspaces)) {
    tasks.workspaces.forEach(callback)
  }
}

function getTabRecord (workspaceId, documentId) {
  const ws = normalizeId(workspaceId)
  const doc = normalizeId(documentId)
  if (!ws || !doc) return null

  let found = null
  forEachWorkspace(function (workspace) {
    if (found || !workspace || normalizeId(workspace.id) !== ws || !workspace.tabs) return
    const entries = typeof workspace.tabs.get === 'function' ? workspace.tabs.get() : []
    entries.forEach(function (tab) {
      if (found || !tab) return
      const identity = getDocumentIdentity(tab.url)
      if (identity && identity.workspaceId === ws && identity.documentId === doc) {
        found = { id: tab.id, workspaceId: ws, documentId: doc, tab: tab, workspace: workspace }
      }
    })
  })
  return found
}

function findTab (workspaceId, documentId) {
  const record = getTabRecord(workspaceId, documentId)
  return record ? record.id : null
}

function selectedWorkspaceId () {
  if (typeof tasks === 'undefined' || !tasks || typeof tasks.getSelected !== 'function') return null
  const workspace = tasks.getSelected()
  return workspace ? normalizeId(workspace.id) : null
}

function emitChanged (change) {
  changedListeners.slice().forEach(function (listener) {
    try {
      listener(change)
    } catch (e) {
      // A stale sidebar listener must not break the Docs tab lifecycle.
    }
  })
}

function payloadFromArgs (args) {
  const payload = args && args[0]
  if (payload && typeof payload === 'object') return payload
  if (payload === undefined || payload === null) return {}
  return { value: payload }
}

function handleTitleChanged (tabId, args) {
  const record = getTabRecordForId(tabId)
  if (!record) return

  const payload = payloadFromArgs(args)
  const title = payload.title !== undefined ? payload.title : payload.value
  if (title === undefined || title === null) return

  const nextTitle = String(title).trim()
  if (record.workspace.tabs && typeof record.workspace.tabs.update === 'function') {
    const currentTitle = record.tab && record.tab.title ? String(record.tab.title) : ''
    if (currentTitle !== nextTitle) {
      record.workspace.tabs.update(record.id, { title: nextTitle })
    }
  }

  emitChanged({
    workspaceId: record.workspaceId,
    documentId: record.documentId,
    title: nextTitle,
    type: 'title'
  })
}

function handleDocumentChanged (tabId, args) {
  const record = getTabRecordForId(tabId)
  if (!record) return
  const payload = payloadFromArgs(args)
  emitChanged({
    workspaceId: record.workspaceId,
    documentId: record.documentId,
    document: payload.document || payload,
    type: payload.type || 'save'
  })
}

function getTabRecordForId (tabId) {
  if (tabId === null || tabId === undefined) return null

  let found = null
  forEachWorkspace(function (workspace) {
    if (found || !workspace || !workspace.tabs) return
    const entries = typeof workspace.tabs.get === 'function' ? workspace.tabs.get() : []
    entries.forEach(function (tab) {
      if (!found && tab && String(tab.id) === String(tabId)) {
        const identity = getDocumentIdentity(tab.url)
        if (identity) {
          found = {
            id: tab.id,
            workspaceId: identity.workspaceId,
            documentId: identity.documentId,
            tab: tab,
            workspace: workspace
          }
        }
      }
    })
  })
  return found
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

  // Support the kebab-case names used by the page bridge and the camelCase
  // spelling used by older Min preload relays. Each binding is installed once.
  ;['docs-title-changed', 'docsTitleChanged'].forEach(function (name) {
    webviews.bindIPC(name, handleTitleChanged)
  })
  ;['docs-changed', 'docsChanged', 'docs-saved', 'docsSaved'].forEach(function (name) {
    webviews.bindIPC(name, handleDocumentChanged)
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
  if (selected !== record.workspaceId && browserUI.switchToTask) {
    browserUI.switchToTask(record.workspaceId, { focusWebview: true })
  }
  if (browserUI.switchToTab) {
    browserUI.switchToTab(record.id, { focusWebview: true })
  }
  return true
}

function open (workspaceId, documentId, title) {
  const ws = normalizeId(workspaceId)
  const doc = normalizeId(documentId)
  if (!ws || !doc) return null

  installPageBindings()

  const existing = getTabRecord(ws, doc)
  if (existing) {
    if (title && existing.workspace.tabs && typeof existing.workspace.tabs.update === 'function') {
      existing.workspace.tabs.update(existing.id, { title: String(title) })
    }
    focusTab(existing)
    return existing.id
  }

  if (typeof tasks === 'undefined' || !tasks || typeof tasks.get !== 'function') return null
  const workspace = tasks.get(ws)
  if (!workspace) return null

  let browserUI
  try {
    browserUI = require('browserUI.js')
  } catch (e) {
    browserUI = null
  }

  // tabs is an alias for the selected workspace's TabList. Opening from the
  // sidebar normally already targets the selected workspace, but explicitly
  // switch first so a caller cannot accidentally put a Docs tab in another
  // workspace.
  if (selectedWorkspaceId() !== ws) {
    if (browserUI && browserUI.switchToTask) {
      browserUI.switchToTask(ws, { focusWebview: false })
    } else if (typeof tasks.setSelected === 'function') {
      tasks.setSelected(ws)
    }
  }

  const selectedTabs = typeof tabs !== 'undefined' ? tabs : workspace.tabs
  if (!selectedTabs || typeof selectedTabs.add !== 'function') return null

  const url = getDocsURL(ws, doc)
  const tabId = selectedTabs.add({
    url: url,
    title: title ? String(title) : '',
    private: false
  })

  if (browserUI && browserUI.addTab) {
    browserUI.addTab(tabId, { enterEditMode: false })
  }
  return tabId
}

function updateTitle (workspaceId, documentId, title) {
  const record = getTabRecord(workspaceId, documentId)
  if (!record || !record.workspace.tabs || typeof record.workspace.tabs.update !== 'function') return false
  record.workspace.tabs.update(record.id, { title: String(title || '') })
  return true
}

function close (workspaceId, documentId) {
  const record = getTabRecord(workspaceId, documentId)
  if (!record) return false

  // Deletion is initiated from the selected workspace's sidebar. Avoid
  // switching workspaces as a side effect if a stale row races with a switch.
  if (selectedWorkspaceId() !== record.workspaceId) return false

  try {
    const browserUI = require('browserUI.js')
    if (browserUI && browserUI.closeTab) {
      return browserUI.closeTab(record.id, { skipDirtyCheck: true }) !== false
    }
  } catch (e) {}
  return false
}

const docsView = {
  baseURL: DOCS_BASE,
  isDocsURL: isDocsURL,
  getDocumentIdentity: getDocumentIdentity,
  getDocsURL: getDocsURL,
  getDocumentURL: getDocsURL,
  findTab: findTab,
  open: open,
  updateTitle: updateTitle,
  close: close,
  closeDocumentTab: close,
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

module.exports = docsView
