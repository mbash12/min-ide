/* Git process and repository helpers shared by the main-process IPC handlers.
   Dependencies are injected because the main bundle is concatenated and the
   same functions are exercised directly by the git state tests. */

module.exports = function createGitCore (deps) {
  var fs = deps.fs
  var path = deps.path
  var childProcess = deps.childProcess
  var process = deps.process
  var isPathInside = deps.isPathInside

  var GIT_TIMEOUT_MS = 15000
  var GIT_MAX_BUFFER = 10 * 1024 * 1024

  function isDirectoryPath (dirPath) {
    if (typeof dirPath !== 'string' || !dirPath) return false
    try { return fs.statSync(dirPath).isDirectory() } catch (e) { return false }
  }

  /* keeps git file arguments inside cwd; rejects absolute paths and .. */
  function sanitizeRepoFiles (cwd, files) {
    if (!Array.isArray(files) || files.length === 0) return null
    var root = path.resolve(cwd)
    var out = []
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
  GIT_TERMINAL_PROMPT=0 makes remote operations fail fast instead of waiting
  on a credential prompt that cannot be answered. */
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
      proc.stdout.on('data', function (data) {
        if (stdoutLength >= GIT_MAX_BUFFER) return
        stdoutChunks.push(data)
        stdoutLength += data.length
        if (stdoutLength > GIT_MAX_BUFFER) kill()
      })
      proc.stderr.on('data', function (data) {
        if (stderrLength >= GIT_MAX_BUFFER) return
        stderrChunks.push(data)
        stderrLength += data.length
      })
      function stdoutText () {
        var buffer = Buffer.concat(stdoutChunks)
        if (buffer.length > GIT_MAX_BUFFER) buffer = buffer.subarray(0, GIT_MAX_BUFFER)
        return options.binary ? buffer.toString('base64') : buffer.toString('utf8')
      }
      function stderrText () {
        var buffer = Buffer.concat(stderrChunks)
        if (buffer.length > GIT_MAX_BUFFER) buffer = buffer.subarray(0, GIT_MAX_BUFFER)
        return buffer.toString('utf8')
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

  async function resolveGitRoot (startPath) {
    if (!isDirectoryPath(startPath)) return null
    var result = await runGit(startPath, ['rev-parse', '--show-toplevel'])
    if (result.status !== 0) return null
    var root = result.stdout.trim()
    return root && isDirectoryPath(root) ? path.resolve(root) : null
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

  function parsePorcelain (cwd, output) {
    var lines = output.split('\n')
    var branch = null
    var ahead = 0
    var behind = 0
    var staged = []
    var unstaged = []
    var untracked = []
    var conflicted = []

    if (lines.length && lines[0].startsWith('##')) {
      var header = lines[0].slice(2).trim()
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
      var x = line[0]
      var y = line[1]
      var filePart = line.slice(3)
      var arrowIndex = filePart.indexOf(' -> ')
      var filePath = arrowIndex !== -1 ? filePart.slice(arrowIndex + 4) : filePart
      var oldPath = arrowIndex !== -1 ? filePart.slice(0, arrowIndex).trim() : null
      filePath = filePath.trim()
      if (filePath[0] === '"' && filePath[filePath.length - 1] === '"') {
        try { filePath = JSON.parse(filePath) } catch (e) {}
      }
      if (oldPath && oldPath[0] === '"' && oldPath[oldPath.length - 1] === '"') {
        try { oldPath = JSON.parse(oldPath) } catch (e) {}
      }
      var fullPath = path.join(cwd, filePath)
      if (x === '?' && y === '?') {
        untracked.push({ path: filePath, fullPath: fullPath, status: 'untracked', x: x, y: y, raw: line })
        return
      }
      if (x === '!' && y === '!') return
      if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y)) {
        conflicted.push({ path: filePath, fullPath: fullPath, status: 'conflicted', x: x, y: y, raw: line })
        return
      }
      var hasStaged = x !== ' ' && x !== '?' && x !== '!'
      var hasUnstaged = y !== ' ' && y !== '?' && y !== '!'
      if (hasStaged) staged.push({ path: filePath, fullPath: fullPath, status: stagedStatus(x), oldPath: oldPath, x: x, y: y, raw: line })
      if (hasUnstaged) unstaged.push({ path: filePath, fullPath: fullPath, status: unstagedStatus(y), oldPath: oldPath, x: x, y: y, raw: line })
    })

    return { branch: branch, ahead: ahead, behind: behind, staged: staged, unstaged: unstaged, untracked: untracked, conflicted: conflicted }
  }

  async function getStatus (cwd) {
    var result = await runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
    if (result.status !== 0) return { error: result.stderr || 'git status failed', raw: result.stdout + result.stderr }
    var parsed = parsePorcelain(cwd, result.stdout)
    parsed.signature = result.stdout
    if (!parsed.branch) {
      var branchResult = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (branchResult.status === 0) {
        var branch = branchResult.stdout.trim()
        if (branch && branch !== 'HEAD') parsed.branch = branch
      }
    }
    return parsed
  }

  async function getRepositoryStatus (cwd) {
    var gitRoot = await resolveGitRoot(cwd)
    if (!gitRoot) return { isRepo: false }
    var status = await getStatus(gitRoot)
    if (status.error) return { isRepo: true, error: status.error, gitRoot: gitRoot }
    status.signature = gitRoot + '\0' + status.signature
    status.isRepo = true
    status.gitRoot = gitRoot
    return status
  }

  return {
    isDirectoryPath: isDirectoryPath,
    sanitizeRepoFiles: sanitizeRepoFiles,
    isSafeGitRef: isSafeGitRef,
    runGit: runGit,
    resolveGitRoot: resolveGitRoot,
    parsePorcelain: parsePorcelain,
    getStatus: getStatus,
    getRepositoryStatus: getRepositoryStatus
  }
}
