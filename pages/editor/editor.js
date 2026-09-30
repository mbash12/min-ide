/* global monaco */

/* Monaco-based code editor page, opened as a tab via
min://app/pages/editor/index.html.
The file it shows is not in the URL: the host puts it on the tab and the
preload bridge hands it over as window.minViewResource. The page is sandboxed;
all file IO goes through window.postMessage to the preload bridge
(js/preload/editor.js), which relays it to the main process.
The tab title follows document.title (the file name, with a dot when there
are unsaved changes) via the page-title-updated event. */

const editorParams = new URLSearchParams(window.location.search.replace('?', ''))
/* the query parameter is still read for editor tabs that were opened before
the resource moved onto the tab */
const editorFilePath =
  (window.minViewResource && window.minViewResource.resource) || editorParams.get('path') || ''
/* user preferences from Pro Settings -> Editor, handed over with the view */
const editorPrefs = (window.minViewResource && window.minViewResource.extra) || {}

/* resolved once the AMD loader has loaded the editor */
let monacoEditor = null

/* tracks whether content differs from what is on disk */
let dirty = false
let editRevision = 0
let savedRevision = 0
let applyingExternalContent = false
let pageDisposed = false

/* mtime of the file when it was loaded or last saved */
let loadedMtimeMs = null

/* Set while the file on disk changed under unsaved edits. Autosave stays off
until the user picks a side, so a background write can never replace someone
else's change. */
let conflict = null
/* bumped whenever this page reconciles with the disk (save or reload), so a
poll that started before it cannot judge the new state by the old mtime */
let syncEpoch = 0

/* Autosave: write shortly after the last edit instead of keeping changes only
in memory. The manual save (Ctrl/Cmd+S and the app menu) still works. */
const autosaveDelayMs = 700
let autosaveTimer = null
let saving = false
let saveAgainRequested = false
let externalPollTimer = null
let externalPollInFlight = false

/* pending requests to the preload bridge: id -> { resolve, reject } */
const pendingRequests = {}
let requestCounter = 0

function sendRequest (message, extraData) {
  return new Promise(function (resolve, reject) {
    const requestId = ++requestCounter
    pendingRequests[requestId] = { resolve, reject }
    window.postMessage(Object.assign({ message: message }, extraData, { requestId }), window.location.toString())
  })
}

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }
  const data = e.data
  if (data && data.message === 'editor-result' && pendingRequests[data.requestId]) {
    const request = pendingRequests[data.requestId]
    delete pendingRequests[data.requestId]
    if (data.originalMessage === 'editor-read' && data.result && data.result.error) {
      request.reject(new Error(data.result.error))
    } else {
      request.resolve(data.result)
    }
  }
})

function basename (filePath) {
  return filePath.split(/[\\/]/).pop()
}

function isImagePath (filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(filePath)
}

/* keeps the window (and therefore the tab) title up to date */
function updateTitle () {
  document.title = basename(editorFilePath) + (dirty ? ' •' : '')
}

/* maps file extensions/names to monaco language ids */
function getLanguageForPath (filePath) {
  const fileName = basename(filePath).toLowerCase()
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''

  if (fileName === 'dockerfile') return 'dockerfile'
  if (fileName === 'makefile') return 'makefile'

  const languagesByExtension = {
    js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html', vue: 'html',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', dart: 'dart',
    php: 'php', pl: 'perl', pm: 'perl', lua: 'lua',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', bat: 'bat', cmd: 'bat',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
    xml: 'xml', svg: 'xml', xsl: 'xml',
    r: 'r', jl: 'julia', clj: 'clojure', ex: 'elixir',
    txt: 'plaintext', log: 'plaintext'
  }
  return languagesByExtension[ext] || 'plaintext'
}

/* shows an error screen in place of the editor */
function showEditorError (message) {
  document.getElementById('editor-loading').hidden = true
  document.getElementById('editor-container').hidden = true
  const errorView = document.getElementById('editor-error')
  errorView.hidden = false
  document.getElementById('editor-error-text').textContent =
    l('editorOpenError').replace('%s', message)
}

function setDirty (value) {
  if (dirty !== value) {
    dirty = value
    updateTitle()
    // Keep the browser UI's close guard in sync in both directions. The
    // editor page can be destroyed directly by the host, so its own
    // beforeunload handler is not sufficient on its own.
    window.postMessage({ message: 'editor-dirty', dirty: value }, window.location.toString())
  }
}

function scheduleAutosave () {
  if (pageDisposed || conflict) return
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(flushAutosave, autosaveDelayMs)
}

/* Writes the pending edit, if there is one. A timer or manual save that lands
while a previous write is running is remembered and drained afterwards. */
async function flushAutosave () {
  clearTimeout(autosaveTimer)
  autosaveTimer = null
  if (!dirty || pageDisposed || conflict) return
  if (saving) {
    saveAgainRequested = true
    return
  }
  await saveFile()
}

function showConflictBar (message) {
  document.getElementById('editor-conflict-text').textContent = message || l('editorConflictMessage')
  document.getElementById('editor-conflict').hidden = false
  document.body.classList.add('has-conflict')
}

function hideConflictBar () {
  document.getElementById('editor-conflict').hidden = true
  document.body.classList.remove('has-conflict')
}

function enterConflict (diskMtimeMs) {
  if (conflict || pageDisposed) return
  conflict = { diskMtimeMs: diskMtimeMs }
  clearTimeout(autosaveTimer)
  autosaveTimer = null
  saveAgainRequested = false
  showConflictBar()
}

function leaveConflict () {
  conflict = null
  hideConflictBar()
}

async function saveFile () {
  return writeToDisk(false)
}

/* force skips the disk-changed check; only the conflict bar's Overwrite uses it */
async function writeToDisk (force) {
  if (!monacoEditor || !editorFilePath || pageDisposed) return
  if (saving) {
    saveAgainRequested = true
    return
  }
  const revision = editRevision
  const content = monacoEditor.getValue()
  saving = true
  try {
    // The main process compares the file's mtime with the one this page last
    // saw, right before writing, and refuses if they differ (external edit).
    const result = await sendRequest('editor-write', {
      path: editorFilePath,
      content: content,
      expectedMtimeMs: force ? null : loadedMtimeMs
    })
    if (pageDisposed) return
    if (result && result.conflict) {
      enterConflict(result.mtimeMs)
      return
    }
    if (result) {
      throw new Error(result)
    }
    const stat = await sendRequest('editor-stat', { path: editorFilePath })
    if (pageDisposed) return
    loadedMtimeMs = stat ? stat.mtimeMs : null
    syncEpoch++
    savedRevision = revision
    if (conflict) leaveConflict()
    setDirty(editRevision !== savedRevision)
  } catch (err) {
    console.error('save failed:', err)
    // An older snapshot can fail after a newer edit has arrived. Keep the
    // current editor visible and retry that newer revision instead of
    // replacing it with an error screen for an obsolete save.
    if (!pageDisposed && editRevision === revision) {
      showEditorError(err.message || l('editorSaveError'))
    }
  } finally {
    saving = false
    if (!pageDisposed && saveAgainRequested && dirty && !conflict) {
      saveAgainRequested = false
      clearTimeout(autosaveTimer)
      autosaveTimer = setTimeout(flushAutosave, 0)
    } else if (!pageDisposed && !dirty) {
      saveAgainRequested = false
    }
  }
}

/* Conflict bar, "Reload from disk": replaces the editor text with the file's.
It goes through an edit operation, so Ctrl+Z brings the local text back. */
async function reloadFromDisk () {
  if (!conflict || !monacoEditor || pageDisposed || saving) return
  const revision = editRevision
  try {
    const result = await sendRequest('editor-read', { path: editorFilePath })
    if (pageDisposed || !conflict) return
    // typing during the read means the user is still working: leave the bar up
    if (revision !== editRevision) return
    const mtimeMs = result.mtimeMs != null
      ? result.mtimeMs
      : ((await sendRequest('editor-stat', { path: editorFilePath })) || {}).mtimeMs
    if (pageDisposed || revision !== editRevision) return
    const model = monacoEditor.getModel()
    applyingExternalContent = true
    try {
      monacoEditor.pushUndoStop()
      monacoEditor.executeEdits('min-external-reload', [{ range: model.getFullModelRange(), text: result.content }])
      monacoEditor.pushUndoStop()
    } finally {
      applyingExternalContent = false
    }
    loadedMtimeMs = mtimeMs != null ? mtimeMs : null
    syncEpoch++
    savedRevision = editRevision
    leaveConflict()
    setDirty(false)
  } catch (err) {
    if (!pageDisposed && conflict) showConflictBar(err.message || l('editorSaveError'))
  }
}

async function overwriteDisk () {
  if (!conflict || saving) return
  await writeToDisk(true)
}

/* called from the UI process (Ctrl+S / menu) via executeJavaScript */
window.editorSave = saveFile

async function loadFile () {
  if (!editorFilePath) {
    showEditorError('(no file)')
    return
  }
  updateTitle()
  try {
    if (isImagePath(editorFilePath)) {
      const result = await sendRequest('editor-read-image', { path: editorFilePath })
      if (pageDisposed) return
      if (!result || !result.dataURL) {
        throw new Error(result && result.error ? result.error : 'Failed to read image')
      }
      showImage(result.dataURL)
      return
    }
    const result = await sendRequest('editor-read', { path: editorFilePath })
    const stat = result.mtimeMs != null ? null : await sendRequest('editor-stat', { path: editorFilePath })
    if (pageDisposed) return
    loadedMtimeMs = result.mtimeMs != null ? result.mtimeMs : (stat ? stat.mtimeMs : null)
    createEditor(result.content)
    startExternalChangePolling()
  } catch (err) {
    if (!pageDisposed) showEditorError(err.message)
  }
}

function showImage (dataURL) {
  document.getElementById('editor-loading').hidden = true
  const image = document.createElement('img')
  image.id = 'editor-image-preview'
  image.src = dataURL
  image.alt = basename(editorFilePath)
  document.getElementById('editor-container').appendChild(image)
}

function startExternalChangePolling () {
  if (externalPollTimer) return
  // Poll for changes made outside the editor. Without local edits the new text
  // is picked up silently; with local edits it is a conflict, raised now so
  // autosave does not have to run into it.
  externalPollTimer = setInterval(async function () {
    if (!monacoEditor || pageDisposed || externalPollInFlight || saving || conflict) return
    externalPollInFlight = true
    const revision = editRevision
    const epoch = syncEpoch
    try {
      const stat = await sendRequest('editor-stat', { path: editorFilePath })
      if (pageDisposed || saving || conflict || revision !== editRevision || epoch !== syncEpoch) return
      if (!stat || stat.mtimeMs === null || stat.mtimeMs === loadedMtimeMs) return
      if (dirty) {
        enterConflict(stat.mtimeMs)
        return
      }
      // file changed externally and we have no unsaved edits: reload silently
      const result = await sendRequest('editor-read', { path: editorFilePath })
      if (pageDisposed || dirty || saving || revision !== editRevision || epoch !== syncEpoch) return
      // preserve cursor position
      const pos = monacoEditor.getPosition()
      applyingExternalContent = true
      try {
        monacoEditor.setValue(result.content)
        if (pos) monacoEditor.setPosition(pos)
      } finally {
        applyingExternalContent = false
      }
      loadedMtimeMs = result.mtimeMs != null ? result.mtimeMs : stat.mtimeMs
      syncEpoch++
      savedRevision = editRevision
      setDirty(false)
    } catch (e) {} finally {
      externalPollInFlight = false
    }
  }, 2000)
}

function createEditor (content) {
  document.getElementById('editor-loading').hidden = true

  require.config({
    paths: { vs: 'monaco/vs' },
    'vs/nls': { availableLanguages: { '*': 'en' } }
  })

  window.MonacoEnvironment = {
    getWorkerUrl: function (workerId, label) {
      if (label === 'json') {
        return 'monaco/vs/assets/json.worker-CoJx_OPf.js'
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return 'monaco/vs/assets/css.worker-URu8fCFR.js'
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return 'monaco/vs/assets/html.worker-D1SL3iM8.js'
      }
      if (label === 'typescript' || label === 'javascript') {
        return 'monaco/vs/assets/ts.worker-BWKtMYOk.js'
      }
      return 'monaco/vs/assets/editor.worker-lj3bdIIn.js'
    }
  }

  require(['vs/editor/editor.main'], function () {
    // Emmet support for HTML/CSS/JSX — must be registered before first editor instance
    try {
      if (window.emmetMonaco) {
        window.emmetMonaco.emmetHTML(monaco, ['html', 'php', 'vue', 'handlebars', 'razor']);
        window.emmetMonaco.emmetCSS(monaco, ['css', 'scss', 'less']);
        window.emmetMonaco.emmetJSX(monaco, ['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
      }
    } catch (e) { console.warn('emmet init failed', e) }

    monacoEditor = monaco.editor.create(document.getElementById('editor-container'), {
      value: content,
      language: getLanguageForPath(editorFilePath),
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: editorPrefs.fontSize || 13,
      renderWhitespace: 'selection',
      scrollBeyondLastLine: true,
      wordWrap: editorPrefs.wordWrap === 'on' ? 'on' : 'off',
      tabSize: editorPrefs.tabSize || 2
    })

    monacoEditor.onDidChangeModelContent(function () {
      if (applyingExternalContent || pageDisposed) return
      editRevision++
      setDirty(true)
      scheduleAutosave()
    })

    // follow system theme
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    function updateTheme () {
      monaco.editor.setTheme(mediaQuery.matches ? 'vs-dark' : 'vs')
    }
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', updateTheme)
    }
    updateTheme()

    /* Ctrl/Cmd+S inside the page; the app menu accelerator also routes
    here through menuRenderer.js for editor tabs */
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile)
  }, function (err) {
    showEditorError(err && err.message ? err.message : String(err))
  })
}

// warn on close if there are unsaved changes
let allowUnload = false

// Called by the browser UI after the user confirms that unsaved changes may
// be discarded. This lets an intentional tab close/navigation pass through
// the page's beforeunload handler as well.
window.editorAllowUnload = function () {
  allowUnload = true
  setDirty(false)
}

window.addEventListener('beforeunload', function (e) {
  if (dirty && !allowUnload) {
    e.preventDefault()
    e.returnValue = ''
  }
})

window.addEventListener('pagehide', function () {
  pageDisposed = true
  clearTimeout(autosaveTimer)
  autosaveTimer = null
  clearInterval(externalPollTimer)
  externalPollTimer = null
})

/* the pending autosave should not sit in a timer while the page is going away,
so write it out as soon as the page loses focus or is hidden */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    flushAutosave()
  }
})
window.addEventListener('blur', flushAutosave)

document.getElementById('editor-conflict-overwrite').addEventListener('click', overwriteDisk)
document.getElementById('editor-conflict-reload').addEventListener('click', reloadFromDisk)

// expose dirty state for main process tab close confirmation (via executeJavaScript)
window.editorIsDirty = function () { return dirty }

loadFile()
