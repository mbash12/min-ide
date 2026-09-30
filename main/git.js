/* global fs, path, ipc, isPathInside, getViewResource, getViewIdForContents, maxEditorFileSize, getProviderApiKey, getAgentSetting, loadPiSdk, installProviderKeys, PROVIDER_LABELS */
/* git integration for the sidebar Source Control panel.
fs, path and ipc are provided by main.js (concatenated bundle).
Uses the system `git` binary via child_process.
*/

var gitCore = require(require('path').join(__dirname, 'main/lib/git/core.js'))({
  fs: fs,
  path: path,
  childProcess: require('child_process'),
  process: process,
  isPathInside: isPathInside
})
var isDirectoryPath = gitCore.isDirectoryPath
var sanitizeRepoFiles = gitCore.sanitizeRepoFiles
var resolveRepoFile = gitCore.resolveRepoFile
var isSafeGitRef = gitCore.isSafeGitRef
var runGit = gitCore.runGit
var resolveGitRoot = gitCore.resolveGitRoot
var gitDiscard = require(require('path').join(__dirname, 'main/lib/git/discard.js'))({
  fs: fs,
  path: path,
  runGit: runGit,
  isPathInside: isPathInside
})
var gitHistory = require(require('path').join(__dirname, 'main/lib/git/history.js'))(runGit, isDirectoryPath)

ipc.handle('gitIsRepo', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { isRepo: false }
  var gitRoot = await resolveGitRoot(cwd)
  return { isRepo: !!gitRoot, gitRoot: gitRoot }
})

ipc.handle('gitStatus', async function (e, cwd) {
  if (!isDirectoryPath(cwd)) return { error: 'Invalid path', isRepo: false }
  return gitCore.getRepositoryStatus(cwd)
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
  return gitDiscard.discardFiles(cwd, safe)
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

/* the repo a diff/editor view may touch: the git root of the workspace folder,
or a repository nested inside it (see isRepoAllowedForWorkspace), so a page
cannot read or write inside an unrelated repository or a folder above it */
async function repoAllowedForSender (sender, cwd) {
  if (!sender || sender.isDestroyed()) return false
  var view = getViewResource(getViewIdForContents(sender))
  return gitCore.isRepoAllowedForWorkspace(view && view.rootPath, cwd)
}

/* file content at a git ref ('HEAD', a commit hash, '' for the index).
Missing paths return an error; callers treat them as an empty side. */
ipc.handle('gitFileAtRef', async function (e, cwd, ref, relPath, binary) {
  if (!(await repoAllowedForSender(e.sender, cwd))) return { error: 'Invalid path' }
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
  if (!(await repoAllowedForSender(e.sender, cwd))) return { error: 'Invalid path' }
  var full = resolveRepoFile(cwd, relPath)
  if (!full) return { error: 'Invalid path' }
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
  if (!(await repoAllowedForSender(e.sender, cwd))) return 'Invalid path'
  var full = typeof content === 'string' ? resolveRepoFile(cwd, relPath) : null
  if (!full) return 'Invalid path'
  try {
    fs.writeFileSync(full, content, 'utf8')
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

ipc.handle('gitGraphData', async function (e, cwd, limit) {
  return gitHistory.getGraphData(cwd, limit)
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
