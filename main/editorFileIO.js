/* global fs, path, ipc, isPathInside, getViewResource, getViewIdForContents */
/* file read/write support for the code editor page. fs and path are already
provided by main.js (all main modules share one scope in the concatenated
bundle) */

/* files larger than this are refused (the editor is not meant for huge
files, and reading them would freeze the UI) */
const maxEditorFileSize = 5 * 1024 * 1024

/* binary formats that should not be opened as text */
const binaryExtensions = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.wasm',
  '.mp3', '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wav', '.ogg', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.class', '.jar', '.pyc', '.pyo', '.db', '.sqlite'
]

const imageMimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

function isBinaryFilePath (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return binaryExtensions.includes(ext)
}

function getImageMimeType (filePath) {
  return imageMimeTypes[path.extname(filePath).toLowerCase()] || null
}

/* The file a view was opened for, and the workspace it has to stay inside.
Both come from the view's stored resource rather than its URL, which no longer
carries them (see getViewResource in main/viewManager.js). */
function getEditorViewResource (sender) {
  if (!sender || sender.isDestroyed()) return null
  return getViewResource(getViewIdForContents(sender))
}

function isAllowedEditorPath (sender, filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.indexOf('\0') !== -1) {
    return false
  }
  const view = getEditorViewResource(sender)
  const allowed = view && view.resource
  if (!allowed) return false
  if (path.resolve(allowed) !== path.resolve(filePath)) {
    return false
  }
  const workspace = view.rootPath
  if (workspace && !isPathInside(workspace, filePath)) {
    return false
  }
  return true
}

ipc.handle('editorReadImage', async function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { error: 'Invalid path' }
    }
    const mimeType = getImageMimeType(filePath)
    if (!mimeType) {
      return { error: 'Not an image file' }
    }
    const stat = await fs.promises.lstat(filePath)
    if (!stat.isFile()) {
      return { error: 'Not a regular file' }
    }
    if (stat.size > maxEditorFileSize) {
      return { error: 'File is too large to open' }
    }
    const image = await fs.promises.readFile(filePath)
    if (!isAllowedEditorPath(e.sender, filePath)) return { error: 'Invalid path' }
    return {
      dataURL: 'data:' + mimeType + ';base64,' + image.toString('base64')
    }
  } catch (err) {
    return { error: err.message || 'Failed to read image' }
  }
})

ipc.handle('editorReadFile', async function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { error: 'Invalid path' }
    }
    if (isBinaryFilePath(filePath)) {
      return { error: 'Cannot open binary file' }
    }
    const stat = await fs.promises.lstat(filePath)
    if (!stat.isFile()) {
      return { error: 'Not a regular file' }
    }
    if (stat.size > maxEditorFileSize) {
      return { error: 'File is too large to open' }
    }
    const content = await fs.promises.readFile(filePath, 'utf8')
    if (!isAllowedEditorPath(e.sender, filePath)) return { error: 'Invalid path' }
    // mtime comes from the stat taken before the read: if the file changes
    // mid-read the editor sees a newer mtime later and reconciles, instead of
    // recording a version it never saw.
    return { content: content, mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { error: err.message || 'Failed to read file' }
  }
})

/* writes content back to disk. Returns null on success or an error message
string on failure.

expectedMtimeMs is the modification time the editor last read or wrote. When it
is given and the file on disk has a different one, something else (an agent,
git, another editor) changed the file since, so nothing is written and
{ conflict: true, mtimeMs } comes back for the editor to resolve. Omit it (or
pass null) to write unconditionally. */
ipc.handle('editorWriteFile', async function (e, filePath, content, expectedMtimeMs) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return 'Invalid path'
    }
    if (typeof content !== 'string') {
      return 'Invalid content'
    }
    // ensure parent directory still exists (file may have been moved/deleted externally)
    const dir = path.dirname(filePath)
    let directory
    try {
      directory = await fs.promises.stat(dir)
    } catch (err) {
      return 'Directory does not exist'
    }
    if (!directory.isDirectory()) {
      return 'Directory does not exist'
    }
    // A preview editor can be repointed while this async directory check is
    // pending. Do not let its old save write after the view now represents a
    // different workspace file.
    if (!isAllowedEditorPath(e.sender, filePath)) return 'Invalid path'
    if (typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs)) {
      let currentMtimeMs = null
      try {
        currentMtimeMs = (await fs.promises.stat(filePath)).mtimeMs
      } catch (err) {
        // deleted or moved since it was opened: recreating it loses nothing
      }
      if (currentMtimeMs !== null && currentMtimeMs !== expectedMtimeMs) {
        return { conflict: true, mtimeMs: currentMtimeMs }
      }
      if (!isAllowedEditorPath(e.sender, filePath)) return 'Invalid path'
    }
    // The async API queues concurrent writes to the same path and renames a
    // complete temporary file into place. The synchronous variant blocked
    // the main process on every editor save.
    const writeFileAtomic = require('write-file-atomic')
    if (typeof writeFileAtomic === 'function') {
      await writeFileAtomic(filePath, content, { encoding: 'utf8' })
    } else {
      await fs.promises.writeFile(filePath, content, 'utf8')
    }
    return null
  } catch (err) {
    return err.message || 'Failed to save file'
  }
})

/* returns basic metadata used for tab titles and dirty-state checks:
{ mtimeMs } */
ipc.handle('editorStatFile', async function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { mtimeMs: null }
    }
    const stat = await fs.promises.stat(filePath)
    if (!isAllowedEditorPath(e.sender, filePath)) return { mtimeMs: null }
    return { mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { mtimeMs: null }
  }
})
