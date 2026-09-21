/* terminal support: spawns shells in a pseudo-tty and streams them to the
min://terminal page over IPC */

const pty = require('node-pty')
const os = require('os')

/* fs and path are already provided by main.js (all main modules share one
scope in the concatenated bundle) */

const terminalProcesses = {} // webContents id: pty process
/* per-tab session state kept for archive/restart restore (HANDOVER §15):
tail = rolling output buffer, cwd = last known shell directory, shell =
the spawned shell path. Survives view destruction; cleared on tab close. */
const terminalSessions = {} // tab id: {tail, cwd, shell}
const MAX_TERMINAL_TAIL = 128 * 1024
/* sender ids that already have a 'destroyed' listener attached - restart
re-enters terminal-create on the same view and must not stack listeners */
const terminalDestroyedListeners = new Set()

function getShell () {
  const configured = settings.get('terminalShell')
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim()
  }
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/* agent.js redirects the embedded coding agent's data dirs through env vars
on the main process; strip them from spawned shells so user-run tools (a pi
CLI in the terminal) don't pick up Min's agent paths */
function cleanSpawnEnv () {
  const env = Object.assign({}, process.env)
  delete env.PI_CODING_AGENT_DIR
  delete env.PI_CODING_AGENT_SESSION_DIR
  delete env.PI_PACKAGE_DIR
  return env
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

/* reads the shell's live working directory: /proc on Linux, lsof on macOS.
Returns null elsewhere or once the process is gone - callers keep the last
recorded value then. */
async function readPtyCwd (pid) {
  try {
    if (process.platform === 'linux') {
      return (await fs.promises.readlink('/proc/' + pid + '/cwd')) || null
    }
    if (process.platform === 'darwin') {
      const out = await new Promise(function (resolve) {
        require('child_process').execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1000 }, function (err, stdout) {
          resolve(err ? '' : (stdout || '').toString())
        })
      })
      const match = out.match(/\nn(.+)/)
      return match ? match[1] : null
    }
  } catch (e) {}
  return null
}

ipc.on('terminal-create', function (e, data) {
  destroyTerminal(e.sender.id)

  const tabId = getViewIdForContents(e.sender)
  const cwd = resolveCwd(data && data.cwd)
  const shell = getShell()

  let term
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: (data && data.cols) || 80,
      rows: (data && data.rows) || 24,
      cwd: cwd,
      env: cleanSpawnEnv()
    })
  } catch (err) {
    console.warn('failed to start terminal:', err)
    if (!e.sender.isDestroyed()) {
      e.sender.send('terminal-exit')
    }
    return
  }

  terminalProcesses[e.sender.id] = term
  if (tabId) {
    /* the page hands back the scrollback it just redrew on restore, so the
    tail keeps the whole history instead of only this process's output */
    terminalSessions[tabId] = {
      tail: (data && typeof data.scrollback === 'string') ? data.scrollback.slice(-MAX_TERMINAL_TAIL) : '',
      cwd: cwd,
      shell: shell
    }
  }

  /* Output is batched into one IPC per tick (~16 ms): heavy output used to
  send a message per pty chunk, flooding the renderer and the IPC bridge.
  The tail only slices once it overshoots the cap, avoiding an O(tail)
  copy per chunk. */
  let pendingOutput = ''
  let flushTimer = null
  const flushOutput = function () {
    flushTimer = null
    if (!pendingOutput) return
    const data = pendingOutput
    pendingOutput = ''
    if (!e.sender.isDestroyed()) {
      e.sender.send('terminal-data', data)
    }
  }
  term.onData(function (output) {
    const session = tabId && terminalSessions[tabId]
    if (session) {
      session.tail += output
      if (session.tail.length > MAX_TERMINAL_TAIL * 2) {
        session.tail = session.tail.slice(-MAX_TERMINAL_TAIL)
      }
    }
    pendingOutput += output
    if (!flushTimer) {
      flushTimer = setTimeout(flushOutput, 16)
      if (flushTimer.unref) flushTimer.unref()
    }
  })

  term.onExit(function () {
    /* only report the exit if this pty is still the active one for the view:
    a pty killed by destroyTerminal (e.g. replaced by a restart) must not
    trigger the "session ended" overlay over the new session */
    if (terminalProcesses[e.sender.id] === term) {
      delete terminalProcesses[e.sender.id]
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushOutput()
      }
      const session = tabId && terminalSessions[tabId]
      if (session && session.tail.length > MAX_TERMINAL_TAIL) {
        session.tail = session.tail.slice(-MAX_TERMINAL_TAIL)
      }
      if (!e.sender.isDestroyed()) {
        e.sender.send('terminal-exit')
      }
    }
  })

  // clean up when the view (or the whole window) goes away
  if (!terminalDestroyedListeners.has(e.sender.id)) {
    terminalDestroyedListeners.add(e.sender.id)
    e.sender.once('destroyed', function () {
      terminalDestroyedListeners.delete(e.sender.id)
      destroyTerminal(e.sender.id)
    })
  }
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

/* the renderer polls this to persist terminal state onto the tab record.
Works even after the view is destroyed (archive) - the session record keeps
the last known cwd and the captured tail. */
ipc.handle('terminal-get-state', async function (e, tabId, includeTail) {
  const session = tabId && terminalSessions[tabId]
  if (!session) {
    return null
  }
  const view = viewMap[tabId]
  const term = view && terminalProcesses[view.webContents.id]
  if (term) {
    const cwd = await readPtyCwd(term.pid)
    if (cwd) {
      session.cwd = cwd
    }
  }
  /* the tail is large, so it only crosses IPC when the caller actually wants
  to persist it (default true for backwards compatibility) */
  if (includeTail === false) {
    return { cwd: session.cwd, shell: session.shell }
  }
  const tail = session.tail.length > MAX_TERMINAL_TAIL
    ? session.tail.slice(-MAX_TERMINAL_TAIL)
    : session.tail
  return { cwd: session.cwd, shell: session.shell, tail: tail }
})

/* a terminal tab being closed is the only thing that drops the session
record - view destruction (archive, task/workspace switch) must not */
ipc.on('terminal-tab-gone', function (e, tabId) {
  if (tabId) {
    delete terminalSessions[tabId]
  }
})
