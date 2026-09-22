/* global fs, path, ipc, isPathInside, getViewResource, getViewIdForContents, maxEditorFileSize, getProviderApiKey, getAgentSetting, loadPiSdk, installProviderKeys, PROVIDER_LABELS */
/* git integration for the sidebar Source Control panel.
fs, path and ipc are provided by main.js (concatenated bundle).
Uses the system `git` binary via child_process.
*/

var childProcess
try { childProcess = require('child_process') } catch (e) { childProcess = null }

function isDirectoryPath (dirPath) {
  return typeof dirPath === 'string' && fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
}

/* keeps git file arguments inside cwd; rejects absolute paths and .. */
function sanitizeRepoFiles (cwd, files) {
  if (!Array.isArray(files) || files.length === 0) return null
  const root = path.resolve(cwd)
  const out = []
  for (var i = 0; i < files.length; i++) {
    if (typeof files[i] !== 'string' || !files[i] || files[i].indexOf('\0') !== -1) return null
    var full = path.resolve(root, files[i])
    if (!isPathInside(root, full)) return null
    var rel = path.relative(root, full)
    if (!rel || rel === '.') return null
    out.push(rel)
  }
  return out
}

function isSafeGitRef (value) {
  if (typeof value !== 'string' || !value || value[0] === '-' || value.indexOf('\0') !== -1) return false
  if (value.indexOf('..') !== -1 || value.indexOf(':') !== -1 || /\s/.test(value)) return false
  return true
}

/* Runs git without blocking the main process: spawn + kill-on-timeout.
GIT_TERMINAL_PROMPT=0 makes remote operations (pull/push/fetch) fail fast
instead of waiting on a credential prompt that can never be answered. */
var GIT_TIMEOUT_MS = 15000
var GIT_MAX_BUFFER = 10 * 1024 * 1024

function runGit (cwd, args, options) {
  options = options || {}
  return new Promise(function (resolve) {
    if (!childProcess) {
      resolve({ stdout: '', stderr: 'child_process not available', status: 1 })
      return
    }
    var proc
    try {
      proc = childProcess.spawn('git', args, {
        cwd: cwd,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, options.env || {})
      })
    } catch (err) {
      resolve({ stdout: '', stderr: err.message || String(err), status: 1, error: err })
      return
    }
    // collect raw buffers so binary output (image diffs) survives intact;
    // text callers get a utf8 string, binary callers get base64
    var stdoutChunks = []
    var stderrChunks = []
    var stdoutLength = 0
    var stderrLength = 0
    var settled = false
    var timedOut = false
    var finish = function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    var kill = function () {
      try { proc.kill('SIGKILL') } catch (e) {}
    }
    var timer = setTimeout(function () {
      timedOut = true
      kill()
    }, options.timeout || GIT_TIMEOUT_MS)
    proc.stdout.on('data', function (d) {
      if (stdoutLength >= GIT_MAX_BUFFER) return
      stdoutChunks.push(d)
      stdoutLength += d.length
      if (stdoutLength > GIT_MAX_BUFFER) {
        kill()
      }
    })
    proc.stderr.on('data', function (d) {
      if (stderrLength >= GIT_MAX_BUFFER) return
      stderrChunks.push(d)
      stderrLength += d.length
    })
    function stdoutText () {
      var buf = Buffer.concat(stdoutChunks)
      if (buf.length > GIT_MAX_BUFFER) buf = buf.subarray(0, GIT_MAX_BUFFER)
      return options.binary ? buf.toString('base64') : buf.toString('utf8')
    }
    function stderrText () {
      var buf = Buffer.concat(stderrChunks)
      if (buf.length > GIT_MAX_BUFFER) buf = buf.subarray(0, GIT_MAX_BUFFER)
      return buf.toString('utf8')
    }
    proc.on('error', function (err) {
      finish({ stdout: stdoutText(), stderr: stderrText() || err.message || String(err), status: 1, error: err })
    })
    proc.on('close', function (code) {
      finish({
        stdout: stdoutText(),
        stderr: timedOut ? (stderrText() + '\ngit timed out').trim() : stderrText(),
        status: timedOut ? 1 : code
      })
    })
  })
}

async function findGitRoot (startPath) {
  if (!isDirectoryPath(startPath)) return null
  var current = path.resolve(startPath)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current
    }
    var parent = path.dirname(current)
    if (parent === current) break
    // also ask git, but fs check is faster for normal repos
    current = parent
  }
  // fallback: ask git rev-parse
  var r = await runGit(startPath, ['rev-parse', '--show-toplevel'])
  if (r.status === 0) {
    var p = r.stdout.trim()
    if (p && isDirectoryPath(p)) return p
  }
  return null
}

function parsePorcelain (cwd, output) {
  var lines = output.split('\n')
  var branch = null
  var ahead = 0
  var behind = 0
  var staged = []
  var unstaged = []
  var untracked = []
  var conflicted = []

  // first line is branch info when using -b: "## master...origin/master [ahead 1, behind 2]"
  // or "## No commits yet on master" etc
  if (lines.length && lines[0].startsWith('##')) {
    var header = lines[0].slice(2).trim()
    // parse branch name
    // examples:
    // master
    // master...origin/master
    // master...origin/master [ahead 1, behind 2]
    // HEAD (no branch)
    // No commits yet on master
    var branchMatch = header.match(/^(?:No commits yet on )?([^\s.]+)/)
    if (branchMatch) {
      branch = branchMatch[1]
      if (branch === 'HEAD') branch = null
    }
    var aheadMatch = header.match(/ahead (\d+)/)
    var behindMatch = header.match(/behind (\d+)/)
    if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
    if (behindMatch) behind = parseInt(behindMatch[1], 10)
    lines = lines.slice(1)
  }

  lines.forEach(function (line) {
    if (!line) return
    // porcelain v1 format: XY <path>  or XY <path> -> <newpath> for renames
    // X = index, Y = working tree
    var x = line[0]
    var y = line[1]
    var filePart = line.slice(3)
    // handle renames: "R  original -> new"
    var arrowIdx = filePart.indexOf(' -> ')
    var filePath = arrowIdx !== -1 ? filePart.slice(arrowIdx + 4) : filePart
    var oldPath = arrowIdx !== -1 ? filePart.slice(0, arrowIdx).trim() : null
    filePath = filePath.trim()
    // strip quotes if git quoted
    if (filePath[0] === '"' && filePath[filePath.length - 1] === '"') {
      try { filePath = JSON.parse(filePath) } catch (e) {}
    }
    if (oldPath && oldPath[0] === '"' && oldPath[oldPath.length - 1] === '"') {
      try { oldPath = JSON.parse(oldPath) } catch (e) {}
    }
    var fullPath = path.join(cwd, filePath)

    // untracked
    if (x === '?' && y === '?') {
      untracked.push({ path: filePath, fullPath: fullPath, status: 'untracked', x: x, y: y, raw: line })
      return
    }
    // ignored !! - skip
    if (x === '!' && y === '!') return

    // conflicted: both modified or UU, AA, DD etc
    var conflictStatuses = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
    if (conflictStatuses.includes(x + y)) {
      conflicted.push({ path: filePath, fullPath: fullPath, status: 'conflicted', x: x, y: y, raw: line })
      return
    }

    var hasStaged = x !== ' ' && x !== '?' && x !== '!'
    var hasUnstaged = y !== ' ' && y !== '?' && y !== '!'

    if (hasStaged) {
      staged.push({ path: filePath, fullPath: fullPath, status: stagedStatus(x), oldPath: oldPath, x: x, y: y, raw: line })
    }
    if (hasUnstaged) {
      unstaged.push({ path: filePath, fullPath: fullPath, status: unstagedStatus(y), oldPath: oldPath, x: x, y: y, raw: line })
    }
    // If both staged and unstaged for same file, it will appear in both lists (VSCode does similar)
    // But if file is only staged or only unstaged, it goes to one list
  })

  return { branch: branch, ahead: ahead, behind: behind, staged: staged, unstaged: unstaged, untracked: untracked, conflicted: conflicted }
}

function stagedStatus (x) {
  if (x === 'M') return 'modified'
  if (x === 'A') return 'added'
  if (x === 'D') return 'deleted'
  if (x === 'R') return 'renamed'
  if (x === 'C') return 'copied'
  if (x === 'U') return 'unmerged'
  return x
}
function unstagedStatus (y) {
  if (y === 'M') return 'modified'
  if (y === 'D') return 'deleted'
  if (y === 'A') return 'added'
  return y
}

async function getStatus (cwd) {
  var r = await runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (r.status !== 0) {
    return { error: r.stderr || 'git status failed', raw: r.stdout + r.stderr }
  }
  var parsed = parsePorcelain(cwd, r.stdout)
  // get branch if not found via porcelain header, try rev-parse
  if (!parsed.branch) {
    var br = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (br.status === 0) {
      var b = br.stdout.trim()
      if (b && b !== 'HEAD') parsed.branch = b
    }
  }
  // recent commit message?
  var log = await runGit(cwd, ['log', '-1', '--pretty=%B'])
  if (log.status === 0) {
    parsed.lastCommitMessage = log.stdout.trim()
  }
  return parsed
}

ipc.handle('gitIsRepo', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { isRepo: false }
  var r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return { isRepo: r.status === 0 && r.stdout.trim() === 'true', gitRoot: await findGitRoot(cwd) }
})

ipc.handle('gitStatus', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) {
    return { error: 'Invalid path', isRepo: false }
  }
  var isRepoCheck = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (isRepoCheck.status !== 0 || isRepoCheck.stdout.trim() !== 'true') {
    return { isRepo: false }
  }
  var gitRoot = (await findGitRoot(cwd)) || cwd
  var status = await getStatus(gitRoot)
  if (status.error) return { isRepo: true, error: status.error, gitRoot: gitRoot }
  status.isRepo = true
  status.gitRoot = gitRoot
  // also fetch branch upstream info if possible
  return status
})

ipc.handle('gitInit', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['init'])
  if (r.status !== 0) return r.stderr || 'git init failed'
  return null
})

ipc.handle('gitStage', async function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  var r = await runGit(cwd, ['add', '--', ...safe])
  if (r.status !== 0) return r.stderr || 'git add failed'
  return null
})

ipc.handle('gitStageAll', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['add', '-A'])
  if (r.status !== 0) return r.stderr || 'git add failed'
  return null
})

ipc.handle('gitUnstage', async function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  // try git restore --staged, fallback to git reset
  var r = await runGit(cwd, ['restore', '--staged', '--', ...safe])
  if (r.status !== 0) {
    r = await runGit(cwd, ['reset', 'HEAD', '--', ...safe])
  }
  if (r.status !== 0) return r.stderr || 'git unstage failed'
  return null
})

ipc.handle('gitUnstageAll', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['reset', 'HEAD', '--', '.'])
  // if no commits yet, reset fails; try restore --staged
  if (r.status !== 0) {
    r = await runGit(cwd, ['restore', '--staged', '.'])
    if (r.status !== 0) return r.stderr || 'git reset failed'
  }
  return null
})

ipc.handle('gitDiscard', async function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  var root = path.resolve(cwd)
  // for untracked, remove file
  // for modified, restore
  var r = await runGit(cwd, ['restore', '--', ...safe])
  if (r.status !== 0) {
    r = await runGit(cwd, ['checkout', '--', ...safe])
  }
  if (r.status !== 0) {
    // fallback: checkout with HEAD
    r = await runGit(cwd, ['checkout', 'HEAD', '--', ...safe])
  }
  // Also need to handle untracked after discard failure - delete files
  // Try to remove untracked if still failing
  if (r.status !== 0) {
    // check if any file is untracked and delete
    var hadError = false
    for (var i = 0; i < safe.length; i++) {
      var f = safe[i]
      var full = path.resolve(root, f)
      if (!isPathInside(root, full)) {
        hadError = true
        continue
      }
      try {
        var stat = await fs.promises.lstat(full)
        if (stat.isDirectory()) {
          await fs.promises.rm(full, { recursive: true, force: true })
        } else {
          await fs.promises.unlink(full)
        }
      } catch (err) {
        // try git clean for untracked
        var cr = await runGit(cwd, ['clean', '-f', '--', f])
        if (cr.status !== 0) hadError = true
      }
    }
    if (hadError) return r.stderr || 'git discard failed'
    return null
  }
  return null
})

ipc.handle('gitDiscardAll', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  // discard all unstaged changes + remove untracked? VSCode discards unstaged, not untracked, but we can offer
  var r = await runGit(cwd, ['restore', '.'])
  if (r.status !== 0) {
    r = await runGit(cwd, ['checkout', '--', '.'])
  }
  if (r.status !== 0) return r.stderr || 'git discard failed'
  return null
})

ipc.handle('gitCommit', async function (e, cwd, message) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!message || !message.trim()) return 'Commit message required'
  var r = await runGit(cwd, ['commit', '-m', message.trim()])
  if (r.status !== 0) return r.stderr || r.stdout || 'git commit failed'
  return null
})

/* the repo a diff/editor view may touch: the git root has to be the
workspace folder or one of its ancestors/descendants, so a page cannot read
or write inside an unrelated repository */
function repoAllowedForSender (sender, cwd) {
  if (!sender || sender.isDestroyed() || !isDirectoryPath(cwd)) return false
  var view = getViewResource(getViewIdForContents(sender))
  var ws = view && view.rootPath
  if (!ws) return false
  var root = path.resolve(cwd)
  var work = path.resolve(ws)
  return root === work || isPathInside(root, work) || isPathInside(work, root)
}

/* file content at a git ref ('HEAD', a commit hash, '' for the index).
Missing paths return an error; callers treat them as an empty side. */
ipc.handle('gitFileAtRef', async function (e, cwd, ref, relPath, binary) {
  if (!repoAllowedForSender(e.sender, cwd)) return { error: 'Invalid path' }
  if (ref && !isSafeGitRef(ref)) return { error: 'Invalid ref' }
  var safe = sanitizeRepoFiles(cwd, [relPath])
  if (!safe) return { error: 'Invalid path' }
  var r = await runGit(cwd, ['show', (ref || '') + ':' + safe[0]], { binary: binary === true })
  if (r.status !== 0) return { error: r.stderr || 'git show failed' }
  if (binary === true) return { content: r.stdout, binary: true }
  if (r.stdout.indexOf('\0') !== -1) return { error: 'Binary file' }
  return { content: r.stdout }
})

/* working tree file inside the repo (may live outside the workspace root
when the repo root is an ancestor of it) */
ipc.handle('gitWorktreeRead', async function (e, cwd, relPath, binary) {
  if (!repoAllowedForSender(e.sender, cwd)) return { error: 'Invalid path' }
  var safe = sanitizeRepoFiles(cwd, [relPath])
  if (!safe) return { error: 'Invalid path' }
  var full = path.resolve(cwd, safe[0])
  try {
    var stat = fs.lstatSync(full)
    if (!stat.isFile()) return { error: 'Not a regular file' }
    if (stat.size > maxEditorFileSize) return { error: 'File is too large' }
    var buf = fs.readFileSync(full)
    if (binary === true) return { content: buf.toString('base64'), binary: true }
    var content = buf.toString('utf8')
    if (content.indexOf('\0') !== -1) return { error: 'Binary file' }
    return { content: content }
  } catch (err) {
    return { error: err.message || 'Failed to read file' }
  }
})

ipc.handle('gitWorktreeWrite', async function (e, cwd, relPath, content) {
  if (!repoAllowedForSender(e.sender, cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, [relPath])
  if (!safe || typeof content !== 'string') return 'Invalid path'
  try {
    fs.writeFileSync(path.resolve(cwd, safe[0]), content, 'utf8')
    return null
  } catch (err) {
    return err.message || 'Write failed'
  }
})

/* files changed by a commit: status letter + path (+ old path for renames),
drives the commit file list in the sidebar */
ipc.handle('gitCommitFiles', async function (e, cwd, hash) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  if (!isSafeGitRef(hash)) return { error: 'Commit hash required' }
  // -m --first-parent: merges otherwise produce no name-status output at
  // all; this lists files changed against the first parent, matching the
  // hash^ side the diff tab opens
  var r = await runGit(cwd, ['show', '--format=', '--name-status', '-M', '-m', '--first-parent', '--no-color', hash])
  if (r.status !== 0) return { error: r.stderr || 'git show failed' }
  var files = r.stdout.split('\n').filter(Boolean).map(function (line) {
    var parts = line.split('\t')
    var status = parts[0] || ''
    if ((status[0] === 'R' || status[0] === 'C') && parts.length >= 3) {
      return { status: status[0], path: parts[2], oldPath: parts[1] }
    }
    return { status: status[0], path: parts[1] }
  }).filter(function (f) { return f.path })
  return { files: files }
})

/* commit message generation goes through the pi SDK ModelRuntime so any
configured provider works. The 'commitModel' setting ('provider/model',
picked in Pro Settings) overrides the agent's own provider+model. */
ipc.handle('gitGenerateCommitMessage', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }

  var diffResult = await runGit(cwd, ['diff', '--staged', '--no-color', '--stat'])
  var patchResult = await runGit(cwd, ['diff', '--staged', '--no-color', '--unified=2'])
  if (patchResult.status !== 0) return { error: patchResult.stderr || 'Could not read staged changes.' }
  if (!patchResult.stdout.trim()) return { error: 'Stage changes before generating a commit message.' }

  var commitModel = getAgentSetting('commitModel')
  var provider = getAgentSetting('agentProvider') || 'openrouter'
  var modelId = getAgentSetting('agentModel') || 'anthropic/claude-3.5-sonnet'
  if (commitModel && commitModel.indexOf('/') !== -1) {
    provider = commitModel.slice(0, commitModel.indexOf('/'))
    modelId = commitModel.slice(commitModel.indexOf('/') + 1)
  }

  var promptText = [
    'Write one concise Git commit message for the staged changes below.',
    'Use an imperative subject, preferably Conventional Commits when appropriate.',
    'Return only the commit message. Keep the subject under 72 characters.',
    '',
    diffResult.stdout.trim(),
    '',
    patchResult.stdout.slice(0, 30000)
  ].join('\n')

  try {
    var sdk = await loadPiSdk()
    var modelRuntime = await sdk.ModelRuntime.create()
    await installProviderKeys(modelRuntime)

    var model = null
    if (getProviderApiKey(provider)) {
      try { model = modelRuntime.getModel(provider, modelId) } catch (modelErr) {}
    }
    if (!model && !commitModel) {
      // nothing explicitly picked and the preferred provider has no key —
      // use whichever configured provider actually has models available
      var available = (await modelRuntime.getAvailable()) || []
      model = available[0] || null
    }
    if (!model) {
      return { error: 'No usable AI model. Add a provider API key in Pro Settings, or pick a commit message model there.' }
    }
    provider = model.provider

    var response = await modelRuntime.completeSimple(model, {
      messages: [{ role: 'user', content: promptText, timestamp: Date.now() }]
    })
    if (response.errorMessage || response.stopReason === 'error') {
      return { error: (PROVIDER_LABELS[provider] || provider) + ': ' + (response.errorMessage || 'the model request failed.') }
    }
    var message = (response.content || []).filter(function (c) {
      return c && c.type === 'text'
    }).map(function (c) { return c.text }).join('\n')
    message = String(message || '').trim().replace(/^```(?:text)?\s*|\s*```$/g, '').trim()
    if (!message) return { error: 'The model returned an empty commit message.' }
    return { message: message }
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
})

ipc.handle('gitLog', async function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 20)
  var r = await runGit(cwd, ['log', '--oneline', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  return { log: r.stdout }
})

ipc.handle('gitBranch', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var r = await runGit(cwd, ['branch', '--show-current'])
  if (r.status === 0 && r.stdout.trim()) return { branch: r.stdout.trim() }
  var r2 = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r2.status === 0) return { branch: r2.stdout.trim() }
  return { error: r.stderr }
})

ipc.handle('gitBranches', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var r = await runGit(cwd, ['branch', '-a'])
  if (r.status !== 0) return { error: r.stderr || 'git branch failed' }
  var lines = r.stdout.split('\n').filter(Boolean)
  var branches = lines.map(function (line) {
    var isCurrent = line.trim().startsWith('*')
    var name = line.replace(/^[* ]\s*/, '').split(' ')[0]
    var isRemote = name.indexOf('remotes/') === 0
    var displayName = isRemote ? name.replace(/^remotes\//, '') : name
    return { name: name, displayName: displayName, isCurrent: isCurrent, isRemote: isRemote, raw: line }
  })
  var current = null
  branches.forEach(function (b) { if (b.isCurrent) current = b.name })
  if (!current) {
    var rc = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (rc.status === 0) current = rc.stdout.trim()
  }
  return { branches: branches, current: current }
})

ipc.handle('gitGraph', async function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 30)
  var r = await runGit(cwd, ['log', '--graph', '--oneline', '--all', '--decorate', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  return { graph: r.stdout }
})

ipc.handle('gitLogDetailed', async function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 20)
  // --topo-order keeps the same order as git log --graph, so graph rows can
  // be paired with commits by index
  var r = await runGit(cwd, ['log', '--topo-order', '--pretty=format:%H%x00%h%x00%s%x00%an%x00%at%x00%D', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  var commits = r.stdout.split('\n').filter(Boolean).map(function (line) {
    var parts = line.split('\x00')
    return { hash: parts[0], shortHash: parts[1], message: parts[2], author: parts[3], date: parts[4], refs: parts[5] }
  })
  return { commits: commits }
})

ipc.handle('gitPull', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['pull'], { timeout: 120000 })
  if (r.status !== 0) return r.stderr || r.stdout || 'git pull failed'
  return null
})

ipc.handle('gitPush', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['push'], { timeout: 120000 })
  if (r.status !== 0) return r.stderr || r.stdout || 'git push failed'
  return null
})

ipc.handle('gitFetch', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['fetch', '--all', '--prune'], { timeout: 120000 })
  if (r.status !== 0) return r.stderr || r.stdout || 'git fetch failed'
  return null
})

ipc.handle('gitSync', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r1 = await runGit(cwd, ['pull'], { timeout: 120000 })
  if (r1.status !== 0) return r1.stderr || r1.stdout || 'git pull failed'
  var r2 = await runGit(cwd, ['push'], { timeout: 120000 })
  if (r2.status !== 0) return r2.stderr || r2.stdout || 'git push failed'
  return null
})

ipc.handle('gitCheckout', async function (e, cwd, branch) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var r = await runGit(cwd, ['checkout', branch])
  if (r.status !== 0) return r.stderr || r.stdout || 'git checkout failed'
  return null
})

/* checks out a specific commit (detached HEAD) */
ipc.handle('gitCheckoutCommit', async function (e, cwd, hash) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(hash)) return 'Commit hash required'
  var r = await runGit(cwd, ['checkout', hash])
  if (r.status !== 0) return r.stderr || r.stdout || 'git checkout failed'
  return null
})

/* deletes the HEAD commit; its changes move back to the index (staged) */
ipc.handle('gitUndoCommit', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var hasParent = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^'])
  // a root commit has no parent to reset to; dropping the ref leaves the
  // index intact so the changes stay staged against an unborn HEAD
  var r = hasParent.status === 0
    ? await runGit(cwd, ['reset', '--soft', 'HEAD~1'])
    : await runGit(cwd, ['update-ref', '-d', 'HEAD'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git undo commit failed'
  return null
})

ipc.handle('gitCreateBranch', async function (e, cwd, branch) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var r = await runGit(cwd, ['checkout', '-b', branch])
  if (r.status !== 0) return r.stderr || r.stdout || 'git create branch failed'
  return null
})

/* creates a branch pointing at a specific commit without checking it out */
ipc.handle('gitCreateBranchAt', async function (e, cwd, branch, hash) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  if (!isSafeGitRef(hash)) return 'Commit hash required'
  var r = await runGit(cwd, ['branch', branch, hash])
  if (r.status !== 0) return r.stderr || r.stdout || 'git create branch failed'
  return null
})

ipc.handle('gitDeleteBranch', async function (e, cwd, branch, force) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var args = ['branch', force ? '-D' : '-d', branch]
  var r = await runGit(cwd, args)
  if (r.status !== 0) return r.stderr || r.stdout || 'git delete branch failed'
  return null
})

ipc.handle('gitStash', async function (e, cwd, message) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var args = ['stash', 'push', '-m', message || 'WIP']
  var r = await runGit(cwd, args)
  if (r.status !== 0) return r.stderr || r.stdout || 'git stash failed'
  return null
})

ipc.handle('gitStashPop', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = await runGit(cwd, ['stash', 'pop'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git stash pop failed'
  return null
})
