/* Monaco-based code editor page, opened as a tab via
min://app/pages/editor/index.html?path=<absolute file path>.
The page is sandboxed; all file IO goes through window.postMessage to the
preload bridge (js/preload/editor.js), which relays it to the main process.
The tab title follows document.title (the file name, with a dot when there
are unsaved changes) via the page-title-updated event. */

const editorParams = new URLSearchParams(window.location.search.replace('?', ''))
const editorFilePath = editorParams.get('path') || ''

/* resolved once the AMD loader has loaded the editor */
let monacoEditor = null

/* tracks whether content differs from what is on disk */
let dirty = false

/* mtime of the file when it was loaded or last saved */
let loadedMtimeMs = null

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

async function saveFile () {
  if (!monacoEditor || !editorFilePath) {
    return
  }
  try {
    // check if file changed on disk since load (external edit)
    const currentStat = await sendRequest('editor-stat', { path: editorFilePath })
    if (loadedMtimeMs !== null && currentStat && currentStat.mtimeMs !== null && currentStat.mtimeMs !== loadedMtimeMs && dirty) {
      // external change + local edits: warn but still save (last write wins)
      console.warn('File changed on disk since last load, overwriting')
    }
    const error = await sendRequest('editor-write', {
      path: editorFilePath,
      content: monacoEditor.getValue()
    })
    if (error) {
      throw new Error(error)
    }
    setDirty(false)
    const stat = await sendRequest('editor-stat', { path: editorFilePath })
    loadedMtimeMs = stat ? stat.mtimeMs : null
  } catch (err) {
    console.error('save failed:', err)
    showEditorError(err.message || l('editorSaveError'))
  }
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
      if (!result || !result.dataURL) {
        throw new Error(result && result.error ? result.error : 'Failed to read image')
      }
      showImage(result.dataURL)
      return
    }
    const result = await sendRequest('editor-read', { path: editorFilePath })
    const stat = await sendRequest('editor-stat', { path: editorFilePath })
    loadedMtimeMs = stat ? stat.mtimeMs : null
    createEditor(result.content)
    startExternalChangePolling()
  } catch (err) {
    showEditorError(err.message)
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
  // poll for external changes when editor is not dirty; if file changes on disk show indicator
  setInterval(async function () {
    if (dirty || !monacoEditor) return
    try {
      const stat = await sendRequest('editor-stat', { path: editorFilePath })
      if (stat && stat.mtimeMs !== null && stat.mtimeMs !== loadedMtimeMs) {
        // file changed externally and we have no unsaved edits: reload silently
        const result = await sendRequest('editor-read', { path: editorFilePath })
        loadedMtimeMs = stat.mtimeMs
        // preserve cursor position
        const pos = monacoEditor.getPosition()
        monacoEditor.setValue(result.content)
        if (pos) monacoEditor.setPosition(pos)
        setDirty(false)
      }
    } catch (e) {}
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
      fontSize: 13,
      renderWhitespace: 'selection',
      scrollBeyondLastLine: true,
      wordWrap: 'off',
      tabSize: 2
    })

    monacoEditor.onDidChangeModelContent(function () {
      setDirty(true)
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

// expose dirty state for main process tab close confirmation (via executeJavaScript)
window.editorIsDirty = function () { return dirty }

loadFile()
