/* Terminal tabs. Every terminal tab runs its own shell session (see
main/terminal.js), so opening this module more than once is the intended way
to get several independent shells. */
/* global ipc */

var browserUI = require('browserUI.js')
var webviews = require('webviews.js')

const TERMINAL_BASE = 'min://terminal'

/* the directory a new terminal starts in: the selected workspace's folder, or
the home directory when the workspace has no path. The main process expands
'~' and falls back to the home directory if the path is unusable. */
function getDefaultCwd () {
  const ws = typeof workspaces !== 'undefined' && workspaces.getSelected ? workspaces.getSelected() : null
  return (ws && ws.path) || '~'
}

/* deliberately generic: the directory lives in the tab's `resource` and reaches
the page through the preload bridge, so no path ends up in the address bar */
function getTerminalURL () {
  return TERMINAL_BASE
}

const terminalView = {
  /* opens a new terminal tab, rooted at cwd unless one is given */
  open: function (cwd) {
    const resolvedCwd = cwd || getDefaultCwd()
    const tabId = tabs.add({
      url: getTerminalURL(),
      kind: 'terminal',
      resource: resolvedCwd
    })
    browserUI.addTab(tabId, { enterEditMode: false })
    return tabId
  }
}

/* Terminal persistence (HANDOVER §15): poll the main process for each
terminal tab's live cwd, output tail and shell, and write them onto the tab
record - which session restore already persists. After archive or restart a
new shell spawns in the last known directory with its scrollback redrawn.
The values refresh even for hidden or destroyed views, because main keeps a
session record per tab id. */

const TERMINAL_STATE_POLL_MS = 15000
/* Scrollback is large (up to 128 KB/tab) and ends up in the session blob
and cross-window sync, so it persists on a slower cadence than cwd/shell
and is capped tighter than the in-main tail. */
const TERMINAL_SCROLLBACK_EVERY = 4
const MAX_PERSISTED_SCROLLBACK = 64 * 1024
let scrollbackPollCounter = 0
let terminalStatePollTimer = null
let terminalPollSequence = 0
const terminalPollRequests = new Map()

function forEachTerminalTab (fn) {
  if (typeof workspaces === 'undefined' || !workspaces.forEach) {
    return
  }
  workspaces.forEach(function (ws) {
    ws.tasks.forEach(function (task) {
      task.tabs.get().forEach(function (tab) {
        if (tab.kind === 'terminal') {
          fn(task, tab)
        }
      })
    })
  })
}

function refreshTerminalStates () {
  const includeScrollback = (++scrollbackPollCounter % TERMINAL_SCROLLBACK_EVERY) === 0
  forEachTerminalTab(function (task, tab) {
    if (terminalPollRequests.has(tab.id)) return
    const requestId = ++terminalPollSequence
    terminalPollRequests.set(tab.id, requestId)
    ipc.invoke('terminal-get-state', tab.id, includeScrollback).then(function (state) {
      const current = webviews.getTabData(tab.id)
      if (terminalPollRequests.get(tab.id) !== requestId || !current || current.kind !== 'terminal' || !state) {
        return
      }
      const update = {}
      if (state.cwd && state.cwd !== current.resource) {
        update.resource = state.cwd
      }
      if (includeScrollback && typeof state.tail === 'string') {
        const tail = state.tail.length > MAX_PERSISTED_SCROLLBACK
          ? state.tail.slice(-MAX_PERSISTED_SCROLLBACK)
          : state.tail
        if (tail !== (current.terminalScrollback || '')) {
          update.terminalScrollback = tail
        }
      }
      if (state.shell && state.shell !== current.terminalShell) {
        update.terminalShell = state.shell
      }
      if (Object.keys(update).length > 0) {
        webviews.updateTabState(tab.id, update)
      }
    }).catch(function () {}).then(function () {
      if (terminalPollRequests.get(tab.id) === requestId) {
        terminalPollRequests.delete(tab.id)
      }
    })
  })
}

function countTerminalTabs () {
  let count = 0
  forEachTerminalTab(function () { count++ })
  return count
}

function syncTerminalStatePolling () {
  const hasTerminals = countTerminalTabs() > 0
  if (hasTerminals && !terminalStatePollTimer) {
    terminalStatePollTimer = setInterval(refreshTerminalStates, TERMINAL_STATE_POLL_MS)
  } else if (!hasTerminals && terminalStatePollTimer) {
    clearInterval(terminalStatePollTimer)
    terminalStatePollTimer = null
  }
}

/* closing a terminal tab drops the main-process session record; destroying
the view alone (archive, task/workspace switch) must not, since the record
is what a later restore reads. The workspace store re-emits every task's
tab-destroyed, so one listener covers tab, task, and workspace teardown. */
if (typeof workspaces !== 'undefined' && workspaces.on) {
  workspaces.on('tab-added', function (tabId, tab) {
    if (tab && tab.kind === 'terminal') syncTerminalStatePolling()
  })
  workspaces.on('tab-destroyed', function (tabId) {
    terminalPollRequests.delete(tabId)
    ipc.send('terminal-tab-gone', tabId)
    syncTerminalStatePolling()
    // Task/workspace teardown announces tab destruction before removing the
    // owner from the workspace store. Recheck after that synchronous teardown.
    setTimeout(syncTerminalStatePolling, 0)
  })
}

syncTerminalStatePolling()

module.exports = terminalView
