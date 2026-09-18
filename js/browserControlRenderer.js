/* global ipc, tasks */
const browserUI = require('browserUI.js')
const webviews = require('webviews.js')

/* Tab operations for the AI browser tool, always against one workspace's
tab list — never whichever workspace happens to be selected in the window. */

function isRestrictedUrl (url) {
  if (!url || typeof url !== 'string') return false
  const parsed = url.trim().toLowerCase()
  return parsed.indexOf('min://settings') === 0 ||
    parsed.indexOf('min://prosettings') === 0 ||
    parsed.indexOf('min://profiles') === 0 ||
    parsed.indexOf('min://app/pages/settings') === 0 ||
    parsed.indexOf('min://app/pages/prosettings') === 0 ||
    parsed.indexOf('min://app/pages/profiles') === 0 ||
    parsed.indexOf('/pages/settings/') !== -1 ||
    parsed.indexOf('/pages/prosettings/') !== -1 ||
    parsed.indexOf('/pages/profiles/') !== -1
}

function getWorkspace (workspaceId) {
  if (!workspaceId) return null
  return tasks.get(workspaceId) || null
}

function tabPayload (ws, tab) {
  return {
    id: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    selected: tab.id === ws.tabs.getSelected(),
    private: !!tab.private
  }
}

let savedChromeFocusEl = null

function rememberChromeFocus () {
  if (!webviews.isChromeFocused()) return false
  savedChromeFocusEl = document.activeElement
  return true
}

function restoreChromeFocus () {
  webviews.releaseFocus()
  const el = savedChromeFocusEl
  if (el && document.contains(el) && typeof el.focus === 'function') {
    try { el.focus() } catch (e) {}
  }
}

function focusWorkspace (workspaceId) {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    throw new Error('Workspace not found')
  }
  if (ws.archived) {
    browserUI.restoreTask(ws.id, { focusWebview: false })
  } else {
    const selected = tasks.getSelected()
    if (!selected || selected.id !== ws.id) {
      browserUI.switchToTask(ws.id, { focusWebview: false })
    }
  }
  return getWorkspace(ws.id)
}

function listTabsPayload (workspaceId) {
  const ws = getWorkspace(workspaceId)
  if (!ws) return { ok: false, error: 'Workspace not found' }
  return {
    ok: true,
    workspaceId: ws.id,
    workspaceName: ws.name || null,
    tabs: ws.tabs.get().map(function (tab) { return tabPayload(ws, tab) }),
    selected: ws.tabs.getSelected() || null
  }
}

function resolveTab (payload) {
  payload = payload || {}
  const ws = payload.ensureView ? focusWorkspace(payload.workspaceId) : getWorkspace(payload.workspaceId)
  if (!ws) return { ok: false, error: 'Workspace not found' }
  if (payload.tabId && !ws.tabs.has(payload.tabId)) {
    return { ok: false, error: 'Tab is not in this workspace' }
  }
  let tabId = payload.tabId || ws.tabs.getSelected()
  if (!tabId && payload.ensureView) {
    const focused = focusWorkspace(ws.id)
    tabId = focused.tabs.getSelected()
  }
  if (!tabId) return { ok: false, error: 'No tab in this workspace' }
  const tab = ws.tabs.get(tabId)
  if (payload.ensureView) {
    const focused = focusWorkspace(ws.id)
    if (focused.tabs.getSelected() !== tabId) {
      browserUI.switchToTab(tabId, { focusWebview: false })
    } else if (!webviews.hasViewForTab(tabId)) {
      webviews.setSelected(tabId, { focus: false })
    }
  }
  return {
    ok: true,
    workspaceId: ws.id,
    tabId: tabId,
    url: tab ? tab.url : '',
    title: tab ? tab.title : '',
    selected: tabId === ws.tabs.getSelected()
  }
}

function handleBrowserControl (action, payload) {
  payload = payload || {}
  if (action === 'listTabs') {
    return listTabsPayload(payload.workspaceId)
  }
  if (action === 'resolveTab') {
    return resolveTab(payload)
  }
  if (action === 'newTab') {
    if (isRestrictedUrl(payload.url)) {
      return { ok: false, error: 'Browser tools cannot open settings or profile pages' }
    }
    const ws = focusWorkspace(payload.workspaceId)
    const newTab = ws.tabs.add({ url: payload.url || '' })
    browserUI.addTab(newTab, {
      enterEditMode: false,
      focusWebview: false
    })
    const tab = ws.tabs.get(newTab)
    return Object.assign({ ok: true, workspaceId: ws.id }, tabPayload(ws, tab))
  }
  if (action === 'closeTab') {
    const ws = focusWorkspace(payload.workspaceId)
    const tabId = payload.tabId || ws.tabs.getSelected()
    if (!tabId || !ws.tabs.has(tabId)) {
      return { ok: false, error: 'Tab not found in this workspace' }
    }
    browserUI.closeTab(tabId, { focusWebview: false })
    return {
      ok: true,
      id: tabId,
      workspaceId: ws.id,
      selected: ws.tabs.getSelected()
    }
  }
  if (action === 'selectTab') {
    const ws = focusWorkspace(payload.workspaceId)
    const tabId = payload.tabId
    if (!tabId || !ws.tabs.has(tabId)) {
      return { ok: false, error: 'Tab not found in this workspace' }
    }
    browserUI.switchToTab(tabId, { focusWebview: false })
    return { ok: true, id: tabId, workspaceId: ws.id }
  }
  throw new Error('Unknown browser-control action: ' + action)
}

const browserControlRenderer = {
  initialize: function () {
    ipc.on('browser-control', function (e, msg) {
      if (!msg || msg.id == null) return
      const keepChromeFocus = rememberChromeFocus()
      Promise.resolve().then(function () {
        return handleBrowserControl(msg.action, msg.payload)
      }).then(function (result) {
        result = result || { ok: true }
        result.keepChromeFocus = keepChromeFocus || !!result.keepChromeFocus
        result.restoreChromeFocus = keepChromeFocus
        ipc.send('browser-control-result', { id: msg.id, result: result })
        if (keepChromeFocus) restoreChromeFocus()
      }).catch(function (err) {
        ipc.send('browser-control-result', {
          id: msg.id,
          error: (err && err.message) || String(err),
          keepChromeFocus: keepChromeFocus,
          restoreChromeFocus: keepChromeFocus
        })
        if (keepChromeFocus) restoreChromeFocus()
      })
    })
    ipc.on('browser-control-restore-focus', function () {
      restoreChromeFocus()
    })
  }
}

module.exports = browserControlRenderer
