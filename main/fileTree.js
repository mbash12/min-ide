/* global fs, path, ipc */
/* reads directories for the sidebar file tree. fs and path are already
provided by main.js (all main modules share one scope in the concatenated
bundle) */

/* true when candidate resolves inside root (or is root itself). Rejects
absolute-path join tricks and .. traversal. */
function isPathInside (root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) {
    return false
  }
  if (root.indexOf('\0') !== -1 || candidate.indexOf('\0') !== -1) {
    return false
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  const rel = path.relative(resolvedRoot, resolved)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function isSafeEntryName (name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    name.indexOf('/') === -1 &&
    name.indexOf('\\') === -1 &&
    name.indexOf('\0') === -1
}

function getDirectoryEntries (dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .map(function (entry) {
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file'
      }
    })
    .sort(function (a, b) {
      // directories first, then files; both alphabetical
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
}

/* true when the path exists and is a directory */
function isDirectoryPath (dirPath) {
  return typeof dirPath === 'string' && fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
}

ipc.handle('readDirectory', function (e, dirPath) {
  if (!isDirectoryPath(dirPath)) {
    return null
  }
  return getDirectoryEntries(dirPath)
})

/* Whether a workspace's stored folder is still usable. A path that is empty,
 * missing, or no longer a directory is reported as not ok; the renderer turns
 * that workspace into a browser-only one until the user picks a new path, and
 * the stored path itself is left alone. */
ipc.handle('workspacePathStatus', function (e, dirPath) {
  return { ok: isDirectoryPath(dirPath) }
})

/* creates an empty file or directory. Returns null on success, or an error
message string on failure. */
ipc.handle('fileTreeCreate', function (e, workspaceRoot, parentPath, name, type) {
  if (!isDirectoryPath(workspaceRoot) || !isDirectoryPath(parentPath) || !isSafeEntryName(name && name.trim())) {
    return 'Invalid name'
  }
  if (!isPathInside(workspaceRoot, parentPath)) {
    return 'Invalid destination'
  }
  const target = path.join(parentPath, name.trim())
  if (!isPathInside(workspaceRoot, target) || !isPathInside(parentPath, target)) {
    return 'Invalid name'
  }
  if (fs.existsSync(target)) {
    return 'Name already exists'
  }
  try {
    if (type === 'directory') {
      fs.mkdirSync(target)
    } else {
      fs.writeFileSync(target, '')
    }
    return null
  } catch (err) {
    return err.message || 'Failed to create'
  }
})

/* renames a file or directory. Returns null on success, or an error message
string on failure. */
ipc.handle('fileTreeRename', function (e, workspaceRoot, oldPath, newName) {
  const cleanName = typeof newName === 'string' ? newName.trim() : ''
  if (!isDirectoryPath(workspaceRoot) || !isSafeEntryName(cleanName) || !oldPath) {
    return 'Invalid name'
  }
  if (!isPathInside(workspaceRoot, oldPath)) {
    return 'Invalid path'
  }
  const newPath = path.join(path.dirname(oldPath), cleanName)
  if (!isPathInside(workspaceRoot, newPath)) {
    return 'Invalid name'
  }
  if (newPath === oldPath) {
    return null
  }
  if (fs.existsSync(newPath)) {
    return 'Name already exists'
  }
  try {
    fs.renameSync(oldPath, newPath)
    return null
  } catch (err) {
    return err.message || 'Failed to rename'
  }
})

/* moves a file or directory into a target directory. Returns null on
success, or an error message string on failure. */
ipc.handle('fileTreeMove', function (e, workspaceRoot, sourcePath, targetDir) {
  if (!isDirectoryPath(workspaceRoot) || !isDirectoryPath(targetDir) || !sourcePath) {
    return 'Invalid destination'
  }
  if (!isPathInside(workspaceRoot, sourcePath) || !isPathInside(workspaceRoot, targetDir)) {
    return 'Destination is outside the workspace'
  }
  const newPath = path.join(targetDir, path.basename(sourcePath))
  if (!isPathInside(workspaceRoot, newPath)) {
    return 'Invalid destination'
  }
  if (newPath === sourcePath) {
    return null
  }
  if (fs.existsSync(newPath)) {
    return 'Name already exists in destination'
  }
  try {
    fs.renameSync(sourcePath, newPath)
    return null
  } catch (err) {
    return err.message || 'Failed to move'
  }
})

/* deletes a file or directory (recursively). Returns null on success, or an
error message string on failure. */
ipc.handle('fileTreeDelete', function (e, workspaceRoot, targetPath) {
  if (!isDirectoryPath(workspaceRoot) || !targetPath || !isPathInside(workspaceRoot, targetPath)) {
    return 'Invalid path'
  }
  if (path.resolve(targetPath) === path.resolve(workspaceRoot)) {
    return 'Cannot delete the workspace folder'
  }
  try {
    const stat = fs.lstatSync(targetPath)
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(targetPath)
    }
    return null
  } catch (err) {
    return err.message || 'Failed to delete'
  }
})

/* searches a directory recursively for names containing the query. Returns
an array of { path, isDirectory } objects (limited to a few thousand
results). Well-known heavy directories are skipped so large workspaces
(e.g. node_modules) do not dominate the results. */
ipc.handle('fileTreeSearch', function (e, rootPath, query) {
  if (!isDirectoryPath(rootPath) || typeof query !== 'string' || !query.trim()) {
    return []
  }
  const searchRoot = path.resolve(rootPath)
  const needle = query.toLowerCase()
  const results = []
  const walk = function (dir, depth) {
    if (depth > 12 || results.length > 2000) {
      return
    }
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    entries.forEach(function (entry) {
      if (results.length > 2000) return
      const full = path.join(dir, entry.name)
      if (!isPathInside(searchRoot, full)) return
      if (entry.name.toLowerCase().includes(needle) && !entry.isDirectory()) {
        results.push({
          path: full,
          isDirectory: false
        })
      }
      if (entry.isDirectory() && !isSkippedDirectory(entry.name)) {
        walk(full, depth + 1)
      }
    })
  }
  walk(searchRoot, 0)
  return results
})

/* directories that are skipped by the recursive search: caches, build
output and dependency folders that are large and rarely useful */
function isSkippedDirectory (name) {
  const lower = name.toLowerCase()
  return lower === 'node_modules' ||
    lower === '.git' ||
    lower === 'dist' ||
    lower === 'build' ||
    lower === 'out' ||
    lower === 'coverage' ||
    lower === '.cache' ||
    lower === '__pycache__' ||
    lower === '.next' ||
    lower === '.nuxt' ||
    lower === 'vendor'
}
