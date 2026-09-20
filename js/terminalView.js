/* Terminal tabs. Every terminal tab runs its own shell session (see
main/terminal.js), so opening this module more than once is the intended way
to get several independent shells. */

var browserUI = require('browserUI.js')

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
  forEachTerminalTab(function (task, tab) {
    ipc.invoke('terminal-get-state', tab.id).then(function (state) {
      if (!state) {
        return
      }
      const update = {}
      if (state.cwd && state.cwd !== tab.resource) {
        update.resource = state.cwd
      }
      if (typeof state.tail === 'string' && state.tail !== (tab.terminalScrollback || '')) {
        update.terminalScrollback = state.tail
      }
      if (state.shell && state.shell !== tab.terminalShell) {
        update.terminalShell = state.shell
      }
      if (Object.keys(update).length > 0) {
        task.tabs.update(tab.id, update)
      }
    }).catch(function () {})
  })
}

setInterval(refreshTerminalStates, TERMINAL_STATE_POLL_MS)

/* closing a terminal tab drops the main-process session record; destroying
the view alone (archive, task/workspace switch) must not, since the record
is what a later restore reads. The workspace store re-emits every task's
tab-destroyed, so one listener covers tab, task, and workspace teardown. */
if (typeof workspaces !== 'undefined' && workspaces.on) {
  workspaces.on('tab-destroyed', function (tabId) {
    ipc.send('terminal-tab-gone', tabId)
  })
}

module.exports = terminalView
