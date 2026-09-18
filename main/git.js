/* global fs, path, ipc, isPathInside, net, settings */
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

function runGit (cwd, args, options) {
  if (!childProcess) return { stdout: '', stderr: 'child_process not available', status: 1 }
  options = options || {}
  try {
    var result = childProcess.spawnSync('git', args, {
      cwd: cwd,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      env: Object.assign({}, process.env, options.env || {})
    })
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
      error: result.error || null
    }
  } catch (err) {
    return { stdout: '', stderr: err.message || String(err), status: 1, error: err }
  }
}

function findGitRoot (startPath) {
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
  var r = runGit(startPath, ['rev-parse', '--show-toplevel'])
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
    filePath = filePath.trim()
    // strip quotes if git quoted
    if (filePath[0] === '"' && filePath[filePath.length - 1] === '"') {
      try { filePath = JSON.parse(filePath) } catch (e) {}
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
      staged.push({ path: filePath, fullPath: fullPath, status: stagedStatus(x), x: x, y: y, raw: line })
    }
    if (hasUnstaged) {
      unstaged.push({ path: filePath, fullPath: fullPath, status: unstagedStatus(y), x: x, y: y, raw: line })
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

function getStatus (cwd) {
  var r = runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (r.status !== 0) {
    return { error: r.stderr || 'git status failed', raw: r.stdout + r.stderr }
  }
  var parsed = parsePorcelain(cwd, r.stdout)
  // get branch if not found via porcelain header, try rev-parse
  if (!parsed.branch) {
    var br = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (br.status === 0) {
      var b = br.stdout.trim()
      if (b && b !== 'HEAD') parsed.branch = b
    }
  }
  // recent commit message?
  var log = runGit(cwd, ['log', '-1', '--pretty=%B'])
  if (log.status === 0) {
    parsed.lastCommitMessage = log.stdout.trim()
  }
  return parsed
}

ipc.handle('gitIsRepo', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { isRepo: false }
  var r = runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return { isRepo: r.status === 0 && r.stdout.trim() === 'true', gitRoot: findGitRoot(cwd) }
})

ipc.handle('gitStatus', function (e, cwd) {
  if (!isDirectoryPath(cwd)) {
    return { error: 'Invalid path', isRepo: false }
  }
  var isRepoCheck = runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (isRepoCheck.status !== 0 || isRepoCheck.stdout.trim() !== 'true') {
    return { isRepo: false }
  }
  var gitRoot = findGitRoot(cwd) || cwd
  var status = getStatus(gitRoot)
  if (status.error) return { isRepo: true, error: status.error, gitRoot: gitRoot }
  status.isRepo = true
  status.gitRoot = gitRoot
  // also fetch branch upstream info if possible
  return status
})

ipc.handle('gitInit', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['init'])
  if (r.status !== 0) return r.stderr || 'git init failed'
  return null
})

ipc.handle('gitStage', function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  var r = runGit(cwd, ['add', '--', ...safe])
  if (r.status !== 0) return r.stderr || 'git add failed'
  return null
})

ipc.handle('gitStageAll', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['add', '-A'])
  if (r.status !== 0) return r.stderr || 'git add failed'
  return null
})

ipc.handle('gitUnstage', function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  // try git restore --staged, fallback to git reset
  var r = runGit(cwd, ['restore', '--staged', '--', ...safe])
  if (r.status !== 0) {
    r = runGit(cwd, ['reset', 'HEAD', '--', ...safe])
  }
  if (r.status !== 0) return r.stderr || 'git unstage failed'
  return null
})

ipc.handle('gitUnstageAll', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['reset', 'HEAD', '--', '.'])
  // if no commits yet, reset fails; try restore --staged
  if (r.status !== 0) {
    r = runGit(cwd, ['restore', '--staged', '.'])
    if (r.status !== 0) return r.stderr || 'git reset failed'
  }
  return null
})

ipc.handle('gitDiscard', function (e, cwd, files) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var safe = sanitizeRepoFiles(cwd, files)
  if (!safe) return 'Invalid path'
  var root = path.resolve(cwd)
  // for untracked, remove file
  // for modified, restore
  var r = runGit(cwd, ['restore', '--', ...safe])
  if (r.status !== 0) {
    r = runGit(cwd, ['checkout', '--', ...safe])
  }
  if (r.status !== 0) {
    // fallback: checkout with HEAD
    r = runGit(cwd, ['checkout', 'HEAD', '--', ...safe])
  }
  // Also need to handle untracked after discard failure - delete files
  // Try to remove untracked if still failing
  if (r.status !== 0) {
    // check if any file is untracked and delete
    var hadError = false
    safe.forEach(function (f) {
      var full = path.resolve(root, f)
      if (!isPathInside(root, full)) {
        hadError = true
        return
      }
      try {
        var stat = fs.lstatSync(full)
        if (stat.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true })
        } else {
          fs.unlinkSync(full)
        }
      } catch (err) {
        // try git clean for untracked
        var cr = runGit(cwd, ['clean', '-f', '--', f])
        if (cr.status !== 0) hadError = true
      }
    })
    if (hadError) return r.stderr || 'git discard failed'
    return null
  }
  return null
})

ipc.handle('gitDiscardAll', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  // discard all unstaged changes + remove untracked? VSCode discards unstaged, not untracked, but we can offer
  var r = runGit(cwd, ['restore', '.'])
  if (r.status !== 0) {
    r = runGit(cwd, ['checkout', '--', '.'])
  }
  if (r.status !== 0) return r.stderr || 'git discard failed'
  return null
})

ipc.handle('gitCommit', function (e, cwd, message) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!message || !message.trim()) return 'Commit message required'
  var r = runGit(cwd, ['commit', '-m', message.trim()])
  if (r.status !== 0) return r.stderr || r.stdout || 'git commit failed'
  return null
})

ipc.handle('gitDiff', function (e, cwd, filePath, staged) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var safe = sanitizeRepoFiles(cwd, [filePath])
  if (!safe) return { error: 'Invalid path' }
  var args = ['diff', '--no-color']
  if (staged) args.push('--staged')
  args.push('--', safe[0])
  var r = runGit(cwd, args)
  if (r.status !== 0) return { error: r.stderr || 'git diff failed' }
  return { diff: r.stdout }
})

ipc.handle('gitGenerateCommitMessage', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var key = settings.get('openrouterApiKey')
  if (!key) return { error: 'Set an OpenRouter API key in Pro Settings first.' }

  var diffResult = runGit(cwd, ['diff', '--staged', '--no-color', '--stat'])
  var patchResult = runGit(cwd, ['diff', '--staged', '--no-color', '--unified=2'])
  if (patchResult.status !== 0) return { error: patchResult.stderr || 'Could not read staged changes.' }
  if (!patchResult.stdout.trim()) return { error: 'Stage changes before generating a commit message.' }

  var model = settings.get('agentModel') || 'anthropic/claude-3.5-sonnet'
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
    var response = await net.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.2,
        max_tokens: 120
      })
    })
    var body = await response.json()
    if (!response.ok) {
      return { error: (body && body.error && body.error.message) || ('HTTP ' + response.status) }
    }
    var message = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content
    message = String(message || '').trim().replace(/^```(?:text)?\s*|\s*```$/g, '').trim()
    if (!message) return { error: 'The model returned an empty commit message.' }
    return { message: message }
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
})

/* full diff of a single commit (for the graph's detail view) */
ipc.handle('gitCommitDiff', function (e, cwd, hash) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  if (!isSafeGitRef(hash)) return { error: 'Commit hash required' }
  var r = runGit(cwd, ['show', '--no-color', '--format=', '--no-renames', hash])
  if (r.status !== 0) {
    // fall back to plain git show for root commits / exotic cases
    r = runGit(cwd, ['show', '--no-color', hash])
  }
  if (r.status !== 0) return { error: r.stderr || 'git show failed' }
  return { diff: r.stdout }
})

ipc.handle('gitLog', function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 20)
  var r = runGit(cwd, ['log', '--oneline', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  return { log: r.stdout }
})

ipc.handle('gitBranch', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var r = runGit(cwd, ['branch', '--show-current'])
  if (r.status === 0 && r.stdout.trim()) return { branch: r.stdout.trim() }
  var r2 = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r2.status === 0) return { branch: r2.stdout.trim() }
  return { error: r.stderr }
})

ipc.handle('gitBranches', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var r = runGit(cwd, ['branch', '-a'])
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
    var rc = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (rc.status === 0) current = rc.stdout.trim()
  }
  return { branches: branches, current: current }
})

ipc.handle('gitGraph', function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 30)
  var r = runGit(cwd, ['log', '--graph', '--oneline', '--all', '--decorate', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  return { graph: r.stdout }
})

ipc.handle('gitLogDetailed', function (e, cwd, limit) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
  var lim = String(limit || 20)
  // --topo-order keeps the same order as git log --graph, so graph rows can
  // be paired with commits by index
  var r = runGit(cwd, ['log', '--topo-order', '--pretty=format:%H%x00%h%x00%s%x00%an%x00%ar%x00%D', '-n', lim])
  if (r.status !== 0) return { error: r.stderr || 'git log failed' }
  var commits = r.stdout.split('\n').filter(Boolean).map(function (line) {
    var parts = line.split('\x00')
    return { hash: parts[0], shortHash: parts[1], message: parts[2], author: parts[3], date: parts[4], refs: parts[5] }
  })
  return { commits: commits }
})

ipc.handle('gitPull', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['pull'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git pull failed'
  return null
})

ipc.handle('gitPush', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['push'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git push failed'
  return null
})

ipc.handle('gitFetch', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['fetch', '--all', '--prune'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git fetch failed'
  return null
})

ipc.handle('gitSync', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r1 = runGit(cwd, ['pull'])
  if (r1.status !== 0) return r1.stderr || r1.stdout || 'git pull failed'
  var r2 = runGit(cwd, ['push'])
  if (r2.status !== 0) return r2.stderr || r2.stdout || 'git push failed'
  return null
})

ipc.handle('gitCheckout', function (e, cwd, branch) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var r = runGit(cwd, ['checkout', branch])
  if (r.status !== 0) return r.stderr || r.stdout || 'git checkout failed'
  return null
})

/* checks out a specific commit (detached HEAD) */
ipc.handle('gitCheckoutCommit', function (e, cwd, hash) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(hash)) return 'Commit hash required'
  var r = runGit(cwd, ['checkout', hash])
  if (r.status !== 0) return r.stderr || r.stdout || 'git checkout failed'
  return null
})

/* reverts a commit by creating a new commit with the inverse changes */
ipc.handle('gitRevertCommit', function (e, cwd, hash) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(hash)) return 'Commit hash required'
  var r = runGit(cwd, ['revert', '--no-edit', hash])
  if (r.status !== 0) return r.stderr || r.stdout || 'git revert failed'
  return null
})

ipc.handle('gitCreateBranch', function (e, cwd, branch) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var r = runGit(cwd, ['checkout', '-b', branch])
  if (r.status !== 0) return r.stderr || r.stdout || 'git create branch failed'
  return null
})

/* creates a branch pointing at a specific commit without checking it out */
ipc.handle('gitCreateBranchAt', function (e, cwd, branch, hash) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  if (!isSafeGitRef(hash)) return 'Commit hash required'
  var r = runGit(cwd, ['branch', branch, hash])
  if (r.status !== 0) return r.stderr || r.stdout || 'git create branch failed'
  return null
})

ipc.handle('gitDeleteBranch', function (e, cwd, branch, force) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  if (!isSafeGitRef(branch)) return 'Branch name required'
  var args = ['branch', force ? '-D' : '-d', branch]
  var r = runGit(cwd, args)
  if (r.status !== 0) return r.stderr || r.stdout || 'git delete branch failed'
  return null
})

ipc.handle('gitStash', function (e, cwd, message) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var args = ['stash', 'push', '-m', message || 'WIP']
  var r = runGit(cwd, args)
  if (r.status !== 0) return r.stderr || r.stdout || 'git stash failed'
  return null
})

ipc.handle('gitStashPop', function (e, cwd) {
  if (!isDirectoryPath(cwd)) return 'Invalid path'
  var r = runGit(cwd, ['stash', 'pop'])
  if (r.status !== 0) return r.stderr || r.stdout || 'git stash pop failed'
  return null
})
