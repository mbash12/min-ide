/* terminal support: spawns shells in a pseudo-tty and streams them to the
min://terminal page over IPC */

const pty = require('node-pty')
const os = require('os')

/* fs and path are already provided by main.js (all main modules share one
scope in the concatenated bundle) */

const terminalProcesses = {} // webContents id: pty process

function getShell () {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/* expands ~ and falls back to the home directory when the path isn't a usable directory */
function resolveCwd (dir) {
  let expanded = dir
  if (expanded && expanded.startsWith('~')) {
    expanded = path.join(os.homedir(), expanded.slice(1))
  }
  if (expanded && fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
    return expanded
  }
  return os.homedir()
}

function destroyTerminal (senderId) {
  const term = terminalProcesses[senderId]
  if (term) {
    try {
      term.kill()
    } catch (e) {}
    delete terminalProcesses[senderId]
  }
}

ipc.on('terminal-create', function (e, data) {
  destroyTerminal(e.sender.id)

  let term
  try {
    term = pty.spawn(getShell(), [], {
      name: 'xterm-color',
      cols: (data && data.cols) || 80,
      rows: (data && data.rows) || 24,
      cwd: resolveCwd(data && data.cwd),
      env: process.env
    })
  } catch (err) {
    console.warn('failed to start terminal:', err)
    if (!e.sender.isDestroyed()) {
      e.sender.send('terminal-exit')
    }
    return
  }

  terminalProcesses[e.sender.id] = term

  term.onData(function (output) {
    if (!e.sender.isDestroyed()) {
      e.sender.send('terminal-data', output)
    }
  })

  term.onExit(function () {
    /* only report the exit if this pty is still the active one for the view:
    a pty killed by destroyTerminal (e.g. replaced by a restart) must not
    trigger the "session ended" overlay over the new session */
    if (terminalProcesses[e.sender.id] === term) {
      delete terminalProcesses[e.sender.id]
      if (!e.sender.isDestroyed()) {
        e.sender.send('terminal-exit')
      }
    }
  })

  // clean up when the view (or the whole window) goes away
  e.sender.once('destroyed', function () {
    destroyTerminal(e.sender.id)
  })
})

ipc.on('terminal-write', function (e, data) {
  const term = terminalProcesses[e.sender.id]
  if (term && data && typeof data.data === 'string') {
    term.write(data.data)
  }
})

ipc.on('terminal-resize', function (e, data) {
  const term = terminalProcesses[e.sender.id]
  if (term && data && data.cols > 0 && data.rows > 0) {
    try {
      term.resize(Math.floor(data.cols), Math.floor(data.rows))
    } catch (err) {}
  }
})

ipc.on('terminal-destroy', function (e) {
  destroyTerminal(e.sender.id)
})
