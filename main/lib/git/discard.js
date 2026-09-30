/* Discarding working-tree changes from the Source Control panel.

The panel offers two different actions through one IPC call: reverting a
tracked file and deleting an untracked one. What each path is comes from git
itself, never from a failed restore: a tracked file whose restore failed (a
held index.lock, a merge in progress) must not be deleted as if it were
untracked, and only files git reports as untracked and not ignored are ever
removed. Dependencies are injected like the rest of main/lib/git. */

module.exports = function createGitDiscard (deps) {
  var fs = deps.fs
  var path = deps.path
  var runGit = deps.runGit
  var isPathInside = deps.isPathInside

  // File names are literal here: without this a file called "[a].js" or "*.md"
  // would be matched as a glob and could select other files.
  var LITERAL = { env: { GIT_LITERAL_PATHSPECS: '1' } }

  function listFiles (cwd, args, files) {
    return runGit(cwd, ['ls-files', '-z'].concat(args, ['--'], files), LITERAL).then(function (result) {
      if (result.status !== 0) return { error: result.stderr || 'git ls-files failed' }
      return { paths: result.stdout.split('\0').filter(Boolean) }
    })
  }

  /* files are relative to cwd and already checked by sanitizeRepoFiles. Returns
  null on success or an error message. */
  async function discardFiles (cwd, files) {
    var root = path.resolve(cwd)
    var tracked = await listFiles(cwd, [], files)
    if (tracked.error) return tracked.error
    var untracked = await listFiles(cwd, ['--others', '--exclude-standard'], files)
    if (untracked.error) return untracked.error

    // a requested path is tracked when git lists it or anything under it
    // (git prints "/" separators; sanitizeRepoFiles yields the platform's)
    var revert = files.filter(function (file) {
      var normalized = file.split(path.sep).join('/')
      return tracked.paths.some(function (listed) {
        return listed === normalized || listed.startsWith(normalized + '/')
      })
    })

    var failure = null
    if (revert.length > 0) {
      var result = await runGit(cwd, ['restore', '--'].concat(revert), LITERAL)
      if (result.status !== 0) {
        // git older than 2.23 has no `restore`
        result = await runGit(cwd, ['checkout', '--'].concat(revert), LITERAL)
      }
      if (result.status !== 0) failure = result.stderr || 'git discard failed'
    }

    for (var i = 0; i < untracked.paths.length; i++) {
      var full = path.resolve(root, untracked.paths[i])
      if (!isPathInside(root, full)) continue
      try {
        // lstat + unlink never follow a symlink out of the repository
        await fs.promises.unlink(full)
      } catch (err) {
        if (err.code !== 'ENOENT') failure = failure || err.message || 'Could not delete ' + untracked.paths[i]
      }
    }

    if (!failure && revert.length === 0 && untracked.paths.length === 0) {
      return 'Nothing to discard'
    }
    return failure
  }

  return { discardFiles: discardFiles }
}
