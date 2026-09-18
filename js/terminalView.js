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

function getTerminalURL (cwd) {
  return TERMINAL_BASE + '?cwd=' + encodeURIComponent(cwd)
}

const terminalView = {
  /* opens a new terminal tab, rooted at cwd unless one is given */
  open: function (cwd) {
    const tabId = tabs.add({ url: getTerminalURL(cwd || getDefaultCwd()) })
    browserUI.addTab(tabId, { enterEditMode: false })
    return tabId
  }
}

module.exports = terminalView
