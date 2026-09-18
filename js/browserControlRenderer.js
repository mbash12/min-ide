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

function getTaskContext (taskId) {
  if (!taskId) return null
  const home = workspaces.findWorkspaceContainingTask(taskId)
  if (!home) return null
  const task = home.tasks.get(taskId)
  if (!task) return null
  return { workspace: home, task: task }
}

function tabPayload (ctx, tab) {
  return {
    id: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    selected: tab.id === ctx.task.tabs.getSelected(),
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

function focusTask (taskId) {
  const ctx = getTaskContext(taskId)
  if (!ctx) {
    throw new Error('Task not found')
  }
  if (ctx.workspace.archived) {
    browserUI.restoreWorkspace(ctx.workspace.id, { focusWebview: false })
  } else {
    const selectedWs = workspaces.getSelected()
    if (!selectedWs || selectedWs.id !== ctx.workspace.id) {
      browserUI.switchToWorkspace(ctx.workspace.id, { focusWebview: false })
    }
  }
  const selected = tasks.getSelected()
  if (!selected || selected.id !== ctx.task.id) {
    browserUI.switchToTask(ctx.task.id, { focusWebview: false })
  }
  return getTaskContext(ctx.task.id)
}

function listTabsPayload (taskId) {
  const ctx = getTaskContext(taskId)
  if (!ctx) return { ok: false, error: 'Task not found' }
  return {
    ok: true,
    taskId: ctx.task.id,
    workspaceId: ctx.workspace.id,
    workspaceName: ctx.workspace.name || null,
    tabs: ctx.task.tabs.get().map(function (tab) { return tabPayload(ctx, tab) }),
    selected: ctx.task.tabs.getSelected() || null
  }
}

function resolveTab (payload) {
  payload = payload || {}
  const taskId = payload.taskId || payload.workspaceId
  const ctx = payload.ensureView ? focusTask(taskId) : getTaskContext(taskId)
  if (!ctx) return { ok: false, error: 'Task not found' }
  if (payload.tabId && !ctx.task.tabs.has(payload.tabId)) {
    return { ok: false, error: 'Tab is not in this task' }
  }
  let tabId = payload.tabId || ctx.task.tabs.getSelected()
  if (!tabId && payload.ensureView) {
    const focused = focusTask(ctx.task.id)
    tabId = focused.task.tabs.getSelected()
  }
  if (!tabId) return { ok: false, error: 'No tab in this task' }
  const tab = ctx.task.tabs.get(tabId)
  if (payload.ensureView) {
    const focused = focusTask(ctx.task.id)
    if (focused.task.tabs.getSelected() !== tabId) {
      browserUI.switchToTab(tabId, { focusWebview: false })
    } else if (!webviews.hasViewForTab(tabId)) {
      webviews.setSelected(tabId, { focus: false })
    }
  }
  return {
    ok: true,
    taskId: ctx.task.id,
    workspaceId: ctx.workspace.id,
    tabId: tabId,
    url: tab ? tab.url : '',
    title: tab ? tab.title : '',
    selected: tabId === ctx.task.tabs.getSelected()
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
    const ctx = focusTask(payload.taskId || payload.workspaceId)
    const newTab = ctx.task.tabs.add({ url: payload.url || '' })
    browserUI.addTab(newTab, {
      enterEditMode: false,
      focusWebview: false
    })
    const tab = ctx.task.tabs.get(newTab)
    return Object.assign({ ok: true, taskId: ctx.task.id, workspaceId: ctx.workspace.id }, tabPayload(ctx, tab))
  }
  if (action === 'closeTab') {
    const ctx = focusTask(payload.taskId || payload.workspaceId)
    const tabId = payload.tabId || ctx.task.tabs.getSelected()
    if (!tabId || !ctx.task.tabs.has(tabId)) {
      return { ok: false, error: 'Tab not found in this task' }
    }
    browserUI.closeTab(tabId, { focusWebview: false })
    return {
      ok: true,
      id: tabId,
      taskId: ctx.task.id,
      workspaceId: ctx.workspace.id,
      selected: ctx.task.tabs.getSelected()
    }
  }
  if (action === 'selectTab') {
    const ctx = focusTask(payload.taskId || payload.workspaceId)
    const tabId = payload.tabId
    if (!tabId || !ctx.task.tabs.has(tabId)) {
      return { ok: false, error: 'Tab not found in this task' }
    }
    browserUI.switchToTab(tabId, { focusWebview: false })
    return { ok: true, id: tabId, taskId: ctx.task.id, workspaceId: ctx.workspace.id }
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
