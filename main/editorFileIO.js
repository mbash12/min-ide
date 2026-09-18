/* global fs, path, ipc, isPathInside */
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

function getEditorPathFromSender (sender) {
  try {
    if (!sender || sender.isDestroyed()) return null
    const parsed = new URL(sender.getURL())
    return parsed.searchParams.get('path') || null
  } catch (err) {
    return null
  }
}

function getEditorWorkspaceFromSender (sender) {
  try {
    if (!sender || sender.isDestroyed()) return null
    const parsed = new URL(sender.getURL())
    return parsed.searchParams.get('workspace') || null
  } catch (err) {
    return null
  }
}

function isAllowedEditorPath (sender, filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.indexOf('\0') !== -1) {
    return false
  }
  const allowed = getEditorPathFromSender(sender)
  if (!allowed) return false
  if (path.resolve(allowed) !== path.resolve(filePath)) {
    return false
  }
  const workspace = getEditorWorkspaceFromSender(sender)
  if (workspace && !isPathInside(workspace, filePath)) {
    return false
  }
  return true
}

ipc.handle('editorReadImage', function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { error: 'Invalid path' }
    }
    const mimeType = getImageMimeType(filePath)
    if (!mimeType) {
      return { error: 'Not an image file' }
    }
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) {
      return { error: 'Not a regular file' }
    }
    if (stat.size > maxEditorFileSize) {
      return { error: 'File is too large to open' }
    }
    return {
      dataURL: 'data:' + mimeType + ';base64,' + fs.readFileSync(filePath).toString('base64')
    }
  } catch (err) {
    return { error: err.message || 'Failed to read image' }
  }
})

ipc.handle('editorReadFile', function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { error: 'Invalid path' }
    }
    if (isBinaryFilePath(filePath)) {
      return { error: 'Cannot open binary file' }
    }
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) {
      return { error: 'Not a regular file' }
    }
    if (stat.size > maxEditorFileSize) {
      return { error: 'File is too large to open' }
    }
    return { content: fs.readFileSync(filePath, 'utf8') }
  } catch (err) {
    return { error: err.message || 'Failed to read file' }
  }
})

/* writes content back to disk. Returns null on success or an
error message string on failure. */
ipc.handle('editorWriteFile', function (e, filePath, content) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return 'Invalid path'
    }
    if (typeof content !== 'string') {
      return 'Invalid content'
    }
    // ensure parent directory still exists (file may have been moved/deleted externally)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return 'Directory does not exist'
    }
    try {
      // prefer atomic write if available
      const wfa = require('write-file-atomic')
      if (wfa && wfa.sync) {
        wfa.sync(filePath, content, 'utf8')
      } else {
        fs.writeFileSync(filePath, content, 'utf8')
      }
    } catch (e) {
      // fallback to regular write
      fs.writeFileSync(filePath, content, 'utf8')
    }
    return null
  } catch (err) {
    return err.message || 'Failed to save file'
  }
})

/* returns basic metadata used for tab titles and dirty-state checks:
{ mtimeMs } */
ipc.handle('editorStatFile', function (e, filePath) {
  try {
    if (!isAllowedEditorPath(e.sender, filePath)) {
      return { mtimeMs: null }
    }
    const stat = fs.statSync(filePath)
    return { mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { mtimeMs: null }
  }
})
