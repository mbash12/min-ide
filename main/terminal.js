/* terminal support: spawns shells in a pseudo-tty and streams them to the
min://terminal page over IPC */
/* global fs, path, ipc, settings, getViewIdForContents, viewMap */

const pty = require('node-pty')
const os = require('os')

/* fs and path are already provided by main.js (all main modules share one
scope in the concatenated bundle) */

const terminalProcesses = {} // webContents id: active pty record
/* per-tab session state kept for archive/restart restore (HANDOVER §15):
tail = rolling output buffer, cwd = last known shell directory, shell =
the spawned shell path. Survives view destruction; cleared on tab close. */
const terminalSessions = {} // tab id: {tail, cwd, shell}
const MAX_TERMINAL_TAIL = 128 * 1024
/* sender ids that already have a 'destroyed' listener attached - restart
re-enters terminal-create on the same view and must not stack listeners */
const terminalDestroyedListeners = new Set()
const terminalCreateVersions = new Map()

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
async function resolveCwd (dir) {
  let expanded = dir
  if (expanded && expanded.startsWith('~')) {
    expanded = path.join(os.homedir(), expanded.slice(1))
  }
  if (expanded) {
    try {
      const stat = await fs.promises.stat(expanded)
      if (stat.isDirectory()) return expanded
    } catch (e) {}
  }
  return os.homedir()
}

function destroyTerminal (senderId, invalidatePendingCreate = true) {
  if (invalidatePendingCreate) {
    terminalCreateVersions.set(senderId, (terminalCreateVersions.get(senderId) || 0) + 1)
  }
  const record = terminalProcesses[senderId]
  if (record) {
    record.active = false
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    record.pendingOutput = ''
    delete terminalProcesses[senderId]
    try {
      record.term.kill()
    } catch (e) {}
  }
}

function watchTerminalSender (sender) {
  const senderId = sender.id
  if (terminalDestroyedListeners.has(senderId)) return
  terminalDestroyedListeners.add(senderId)
  sender.once('destroyed', function () {
    terminalDestroyedListeners.delete(senderId)
    destroyTerminal(senderId)
    terminalCreateVersions.delete(senderId)
  })
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
  const senderId = e.sender.id
  if (e.sender.isDestroyed()) return
  watchTerminalSender(e.sender)
  const createVersion = (terminalCreateVersions.get(senderId) || 0) + 1
  terminalCreateVersions.set(senderId, createVersion)
  destroyTerminal(senderId, false)

  const tabId = getViewIdForContents(e.sender)
  ;(async function () {
    const cwd = await resolveCwd(data && data.cwd)
    if (terminalCreateVersions.get(senderId) !== createVersion || e.sender.isDestroyed()) return
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
      if (terminalCreateVersions.get(senderId) === createVersion && !e.sender.isDestroyed()) {
        e.sender.send('terminal-exit')
      }
      return
    }

    if (terminalCreateVersions.get(senderId) !== createVersion || e.sender.isDestroyed()) {
      try {
        term.kill()
      } catch (err) {}
      return
    }

    let session = null
    if (tabId) {
      /* the page hands back the scrollback it just redrew on restore, so the
      tail keeps the whole history instead of only this process's output */
      session = terminalSessions[tabId] = {
        tail: (data && typeof data.scrollback === 'string') ? data.scrollback.slice(-MAX_TERMINAL_TAIL) : '',
        cwd: cwd,
        shell: shell
      }
    }

    const record = {
      term: term,
      tabId: tabId,
      session: session,
      sender: e.sender,
      active: true,
      pendingOutput: '',
      flushTimer: null
    }
    terminalProcesses[senderId] = record

    const isCurrent = function () {
      return record.active && terminalProcesses[senderId] === record &&
        (!record.tabId || terminalSessions[record.tabId] === record.session)
    }
    const flushOutput = function () {
      record.flushTimer = null
      if (!record.pendingOutput) return
      const output = record.pendingOutput
      record.pendingOutput = ''
      if (isCurrent() && !record.sender.isDestroyed()) {
        record.sender.send('terminal-data', output)
      }
    }
    term.onData(function (output) {
      if (!isCurrent()) return
      if (record.session) {
        record.session.tail += output
        if (record.session.tail.length > MAX_TERMINAL_TAIL * 2) {
          record.session.tail = record.session.tail.slice(-MAX_TERMINAL_TAIL)
        }
      }
      record.pendingOutput += output
      if (!record.flushTimer) {
        record.flushTimer = setTimeout(flushOutput, 16)
        if (record.flushTimer.unref) record.flushTimer.unref()
      }
    })

    term.onExit(function () {
      /* killed/replaced ptys may deliver an exit after a new session has
      already started for the same view. Only the current record may report it. */
      if (!isCurrent()) return
      if (record.flushTimer) {
        clearTimeout(record.flushTimer)
        record.flushTimer = null
      }
      flushOutput()
      record.active = false
      delete terminalProcesses[senderId]
      if (record.session && record.session.tail.length > MAX_TERMINAL_TAIL) {
        record.session.tail = record.session.tail.slice(-MAX_TERMINAL_TAIL)
      }
      if (!record.sender.isDestroyed()) {
        record.sender.send('terminal-exit')
      }
    })
  })().catch(function (err) {
    console.warn('failed to start terminal:', err)
    if (terminalCreateVersions.get(senderId) === createVersion && !e.sender.isDestroyed()) {
      e.sender.send('terminal-exit')
    }
  })
})

ipc.on('terminal-write', function (e, data) {
  const record = terminalProcesses[e.sender.id]
  if (record && record.active && data && typeof data.data === 'string') {
    record.term.write(data.data)
  }
})

ipc.on('terminal-resize', function (e, data) {
  const record = terminalProcesses[e.sender.id]
  if (record && record.active && data && data.cols > 0 && data.rows > 0) {
    try {
      record.term.resize(Math.floor(data.cols), Math.floor(data.rows))
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
  let session = tabId && terminalSessions[tabId]
  if (!session) {
    return null
  }
  const view = viewMap[tabId]
  const record = view && terminalProcesses[view.webContents.id]
  if (record && record.active && record.session === session) {
    const cwd = await readPtyCwd(record.term.pid)
    // A view restart or tab close can replace this session while the OS cwd
    // lookup is pending. Only apply the result to the exact request snapshot.
    if (cwd && terminalSessions[tabId] === session &&
      terminalProcesses[view.webContents.id] === record && record.active) {
      session.cwd = cwd
    }
  }
  session = terminalSessions[tabId]
  if (!session) return null
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
    const view = viewMap[tabId]
    const record = view && terminalProcesses[view.webContents.id]
    if (record && record.tabId === tabId) {
      destroyTerminal(view.webContents.id)
    }
    delete terminalSessions[tabId]
  }
})
