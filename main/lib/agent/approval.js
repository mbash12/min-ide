/* Asks the user before the AI assistant reaches outside its workspace.

The agent runs shell commands and writes files with the user's own rights and
no sandbox, and it reads untrusted text (web pages, files, tool output) that
can try to steer it. Inside the workspace it works freely. It has to ask first
when it would:
  - write or edit a file that resolves outside the workspace folder, or
  - run a shell command that names a place outside the workspace, escalates
    privileges (sudo, su, ...) or pipes downloaded text into an interpreter.

The shell check is a tripwire against accidents and blatant injected commands,
not a sandbox: a command can build a path at run time or hide it in a script,
and nothing here would notice. Dependencies are injected so the assessment can
be tested on its own (the main bundle shares one scope). */

module.exports = function createAgentApproval (deps) {
  var fs = deps.fs
  var path = deps.path
  var os = deps.os
  var platform = deps.platform || process.platform
  var homeDir = deps.homeDir || os.homedir()
  var tmpDir = deps.tmpDir || os.tmpdir()

  var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
  var SAFE_DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']
  /* read-mostly system folders: anything that could change them needs sudo,
  which is flagged on its own */
  var SYSTEM_PREFIXES = ['/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/opt/', '/proc/', '/sys/']
  var INTERPRETERS = 'sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby|php'
  /* an interpreter that reads its program from a pipe (no script argument),
  or one handed a downloader's output, or eval of a command substitution.
  `... | node script.js` reads data, not a program, and is not matched. */
  var RUNS_PIPED_TEXT = [
    new RegExp('\\|\\s*(sudo\\s+)?(' + INTERPRETERS + ')(\\s+-s\\b[^\\n;&|]*|\\s+-)?\\s*($|[;&|)\\n])'),
    new RegExp('(^|[;&|(\\s])(' + INTERPRETERS + ')\\s+(-[a-z]+\\s+)?["\']?(\\$\\(|<\\()\\s*(curl|wget)\\b'),
    /(^|[;&|(\s])(eval|source)\s+["']?\$\(/
  ]

  /* the nearest existing ancestor resolved through symlinks, with the rest
  appended: a link inside the workspace that points elsewhere is "outside" */
  function canonical (target) {
    var rest = []
    var current = path.resolve(target)
    while (true) {
      try {
        var real = fs.realpathSync(current)
        return rest.length ? path.join.apply(path, [real].concat(rest.reverse())) : real
      } catch (e) {
        var parent = path.dirname(current)
        if (parent === current) return path.resolve(target)
        rest.push(path.basename(current))
        current = parent
      }
    }
  }

  function isInside (parent, child) {
    var relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  }

  function outsideWorkspace (resolved, cwd) {
    return !isInside(canonical(cwd), canonical(resolved))
  }

  /* how the file tools read a path: unicode spaces, a leading @, ~ and file: */
  function resolveToolPath (raw, cwd) {
    var value = String(raw == null ? '' : raw).replace(UNICODE_SPACES, ' ')
    if (value.startsWith('@')) value = value.slice(1)
    if (/^file:\/\//.test(value)) {
      try { value = require('url').fileURLToPath(value) } catch (e) {}
    }
    if (value === '~') value = homeDir
    else if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) value = path.join(homeDir, value.slice(2))
    return path.resolve(cwd, value)
  }

  function assessFileTool (toolName, input, cwd) {
    var target = input && typeof input.path === 'string' ? input.path : null
    if (!target) return null
    var resolved = resolveToolPath(target, cwd)
    if (!outsideWorkspace(resolved, cwd)) return null
    return {
      reasons: [(toolName === 'edit' ? 'Edits' : 'Writes') + ' a file outside the workspace'],
      detail: resolved,
      key: 'path:' + resolved
    }
  }

  function pathCandidateOutside (candidate, cwd) {
    var value = candidate
    if (value.indexOf('$') !== -1) {
      value = value.replace(/^\$\{HOME\}|^\$HOME\b/, homeDir)
      if (value.indexOf('$') !== -1) return null // built at run time: cannot be judged
    }
    var resolved
    if (value.startsWith('~')) {
      if (value !== '~' && !value.startsWith('~/')) return null // ~user or a stray tilde
      resolved = value === '~' ? homeDir : path.join(homeDir, value.slice(2))
    } else if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
      if (value.startsWith('//')) return null // a URL, not a path
      if (platform !== 'win32') {
        if (SAFE_DEVICES.indexOf(value) !== -1) return null
        if (SYSTEM_PREFIXES.some(function (prefix) { return value.startsWith(prefix) })) return null
        // /pattern/d in a sed script is not a folder: require the top level to exist
        var top = '/' + value.split('/')[1]
        try { fs.accessSync(top) } catch (e) { return null }
      }
      resolved = path.resolve(value)
    } else {
      resolved = path.resolve(cwd, value)
    }
    if (isInside(canonical(tmpDir), canonical(resolved))) return null
    return outsideWorkspace(resolved, cwd) ? resolved : null
  }

  /* runs of path characters in the raw command, quotes and all, so a path
  inside python -c "open('/etc/hosts')" is seen too */
  function pathCandidates (command) {
    var found = []
    // ${HOME} would be split at its braces below; $HOME reads the same
    command = command.replace(/\$\{HOME\}/g, '$HOME')
    var runs = command.match(/[^\s'";|&<>()`=,:{}]+/g) || []
    runs.forEach(function (run) {
      if (/^(\/|~|\$HOME|\$\{HOME\})/.test(run) || run === '..' || run.startsWith('../') || run.indexOf('/../') !== -1 || run.endsWith('/..')) {
        found.push(run)
      }
    })
    if (platform === 'win32') {
      ;(command.match(/[A-Za-z]:[\\/][^\s'";|&<>()`]*/g) || []).forEach(function (drivePath) { found.push(drivePath) })
    }
    return found
  }

  function assessBash (input, cwd) {
    var command = input && typeof input.command === 'string' ? input.command : null
    if (!command) return null
    var reasons = []
    var details = []

    var seen = {}
    pathCandidates(command).forEach(function (candidate) {
      var resolved = pathCandidateOutside(candidate, cwd)
      if (resolved && !seen[resolved]) {
        seen[resolved] = true
        details.push(resolved)
      }
    })
    if (details.length) reasons.push('Names a location outside the workspace: ' + details.slice(0, 3).join(', ') + (details.length > 3 ? ' and ' + (details.length - 3) + ' more' : ''))

    if (/(^|[;&|(`\s])(sudo|su|doas|pkexec)(\s|$)/.test(command)) reasons.push('Runs with elevated privileges')
    if (RUNS_PIPED_TEXT.some(function (pattern) { return pattern.test(command) })) {
      reasons.push('Runs text produced by another command as a program')
    }
    if (!reasons.length) return null
    return { reasons: reasons, detail: command, key: 'bash:' + command.trim() }
  }

  /* null when the call may go ahead; otherwise { reasons, detail, key } */
  function assess (toolName, input, cwd) {
    if (!cwd) return null
    if (toolName === 'write' || toolName === 'edit') return assessFileTool(toolName, input, cwd)
    if (toolName === 'bash') return assessBash(input, cwd)
    return null
  }

  /* Wraps agent.beforeToolCall. ask(request, signal) resolves true to allow.
  An approval covers the same file or the same command for the rest of the
  session; anything that fails to ask, or is refused, blocks the call with a
  message the model can act on. */
  function guard (agent, options) {
    var approved = new Set()
    var previous = agent.beforeToolCall
    agent.beforeToolCall = async function (context, signal) {
      var toolName = context && context.toolCall && context.toolCall.name
      var verdict = assess(toolName, context && context.args, options.cwd)
      if (verdict && !approved.has(verdict.key)) {
        var allowed = false
        try {
          allowed = (await options.ask({ toolName: toolName, reasons: verdict.reasons, detail: verdict.detail }, signal)) === true
        } catch (e) {
          allowed = false
        }
        if (!allowed) {
          return {
            block: true,
            reason: 'The user did not allow this action (' + verdict.reasons.join('; ') + '). Do not try it again or work around it; continue inside the workspace or ask the user what they want.'
          }
        }
        approved.add(verdict.key)
      }
      return previous ? previous.call(agent, context, signal) : undefined
    }
  }

  /* Tracks the questions that are waiting for an answer from a window.
  pickSender() returns the webContents to ask (or null when no window can be
  asked, which counts as a refusal). Each question is answered once, only by
  the window it was sent to; an abort of the turn, the end of the session or a
  vanished window all resolve it as refused, and the window is told to close
  its dialog. */
  function createBroker (brokerDeps) {
    var pending = new Map()
    var sequence = 0

    function notifyCancel (entry, requestId) {
      try {
        if (entry.sender && !entry.sender.isDestroyed()) entry.sender.send('agent-approval-cancel', { requestId: requestId })
      } catch (e) {}
    }

    function settle (requestId, allowed, tellWindow) {
      var entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
      if (tellWindow) notifyCancel(entry, requestId)
      entry.resolve(allowed)
    }

    function ask (scope, request, signal) {
      return new Promise(function (resolve) {
        var sender = brokerDeps.pickSender()
        if (!sender || sender.isDestroyed() || (signal && signal.aborted)) {
          resolve(false)
          return
        }
        var requestId = ++sequence
        var entry = { resolve: resolve, sender: sender, sessionKey: scope.sessionKey, signal: signal || null, onAbort: null }
        entry.onAbort = function () { settle(requestId, false, true) }
        if (signal) signal.addEventListener('abort', entry.onAbort, { once: true })
        pending.set(requestId, entry)
        try {
          sender.send('agent-approval-request', {
            requestId: requestId,
            sessionKey: scope.sessionKey,
            taskId: scope.taskId,
            workspaceId: scope.workspaceId,
            toolName: request.toolName,
            reasons: request.reasons,
            detail: request.detail
          })
        } catch (e) {
          settle(requestId, false, false)
        }
      })
    }

    return {
      ask: ask,
      /* the window's answer; ignored unless it comes from the window asked */
      respond: function (sender, data) {
        var entry = data && pending.get(data.requestId)
        if (!entry || entry.sender !== sender) return
        settle(data.requestId, data.allow === true, false)
      },
      cancelSession: function (sessionKey) {
        Array.from(pending.keys()).forEach(function (requestId) {
          if (pending.get(requestId).sessionKey === sessionKey) settle(requestId, false, true)
        })
      },
      pendingCount: function () { return pending.size }
    }
  }

  return { assess: assess, guard: guard, createBroker: createBroker }
}
