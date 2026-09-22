/* global monaco */
/* Monaco diff editor page for git comparisons, opened as a tab via
min://app/pages/diff/index.html.
The comparison it shows is not in the URL: the host stores a descriptor on
the tab and the preload bridge hands it over as
window.minViewResource.extra.diff:
  { cwd, title, left: {type: 'ref'|'worktree'|'empty', ref, path},
    right: {...}, editable }
Each side's content is fetched lazily through window.postMessage to the
preload bridge (js/preload/editor.js), so a restored tab re-resolves the
files instead of keeping their contents in the saved session. */

const diffDesc =
  (window.minViewResource && window.minViewResource.extra && window.minViewResource.extra.diff) || null
/* user preferences from Pro Settings -> Editor, handed over with the view */
const editorPrefs = (window.minViewResource && window.minViewResource.extra) || {}

let diffEditor = null
let modifiedModel = null

/* tracks whether the editable side differs from what is on disk */
let dirty = false
let saving = false

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
    request.resolve(data.result)
  }
})

function basename (filePath) {
  return String(filePath || '').split(/[\\/]/).pop()
}

/* image formats render as side-by-side pictures instead of the text diff
editor (same table as main/editorFileIO.js) */
const imageMimeTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

function imageMimeForPath (filePath) {
  const fileName = basename(filePath).toLowerCase()
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  return imageMimeTypes[ext] || null
}

/* what to call a side on the image view: the descriptor may carry a label
('HEAD', 'Index', 'Working Tree', a short hash); otherwise derive one */
function sideLabel (side) {
  if (!side) return ''
  if (side.label) return side.label
  if (side.type === 'worktree') return 'Working Tree'
  if (side.ref === '') return 'Index'
  return side.ref || ''
}

function updateTitle () {
  document.title = ((diffDesc && diffDesc.title) || 'Diff') + (dirty ? ' •' : '')
}

/* maps file extensions/names to monaco language ids (same table as the
plain editor) */
function getLanguageForPath (filePath) {
  const fileName = basename(filePath).toLowerCase()
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''

  if (fileName === 'dockerfile') return 'dockerfile'
  if (fileName === 'makefile') return 'makefile'

  const languagesByExtension = {
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    html: 'html',
    htm: 'html',
    vue: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    dart: 'dart',
    php: 'php',
    pl: 'perl',
    pm: 'perl',
    lua: 'lua',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    bat: 'bat',
    cmd: 'bat',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    xml: 'xml',
    svg: 'xml',
    xsl: 'xml',
    r: 'r',
    jl: 'julia',
    clj: 'clojure',
    ex: 'elixir',
    txt: 'plaintext',
    log: 'plaintext'
  }
  return languagesByExtension[ext] || 'plaintext'
}

function showDiffError (message) {
  document.getElementById('diff-loading').hidden = true
  document.getElementById('diff-container').hidden = true
  const errorView = document.getElementById('diff-error')
  errorView.hidden = false
  document.getElementById('diff-error-text').textContent = message
}

function setDirty (value) {
  if (dirty !== value) {
    dirty = value
    updateTitle()
    // keep the host's close guard in sync (same channel as the editor page)
    window.postMessage({ message: 'editor-dirty', dirty: value }, window.location.toString())
  }
}

let autosaveTimer = null
const autosaveDelayMs = 700

function scheduleAutosave () {
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(flushAutosave, autosaveDelayMs)
}

async function flushAutosave () {
  clearTimeout(autosaveTimer)
  autosaveTimer = null
  if (!dirty || saving) return
  await saveFile()
}

/* only the worktree side of a working-tree diff is writable, matching
VSCode where the right editor of an unstaged diff is a normal editor */
async function saveFile () {
  if (!modifiedModel || !diffDesc || !diffDesc.editable || saving) return
  saving = true
  try {
    const error = await sendRequest('editor-git-write', {
      cwd: diffDesc.cwd,
      path: diffDesc.right.path,
      content: modifiedModel.getValue()
    })
    if (error) {
      throw new Error(error)
    }
    setDirty(false)
  } catch (err) {
    console.error('save failed:', err)
    showDiffError(err.message || l('editorSaveError'))
  } finally {
    saving = false
  }
}

/* called from the UI process (Ctrl+S / menu) via executeJavaScript */
window.editorSave = saveFile

/* one side of the comparison -> its text. Missing files (added/deleted on
either side) resolve to an empty model so the diff still renders. */
async function sideContent (side) {
  if (!side || side.type === 'empty') return ''
  try {
    if (side.type === 'worktree') {
      const result = await sendRequest('editor-git-read', { cwd: diffDesc.cwd, path: side.path })
      return (result && typeof result.content === 'string') ? result.content : ''
    }
    const result = await sendRequest('editor-git-show', { cwd: diffDesc.cwd, ref: side.ref || '', path: side.path })
    return (result && typeof result.content === 'string') ? result.content : ''
  } catch (err) {
    return ''
  }
}

/* one side of an image comparison -> a data: URL, or null when the file is
missing on that side (added/deleted) */
async function sideImage (side, mime) {
  if (!side || side.type === 'empty') return null
  try {
    let result
    if (side.type === 'worktree') {
      result = await sendRequest('editor-git-read', { cwd: diffDesc.cwd, path: side.path, binary: true })
    } else {
      result = await sendRequest('editor-git-show', { cwd: diffDesc.cwd, ref: side.ref || '', path: side.path, binary: true })
    }
    return (result && result.binary && result.content)
      ? 'data:' + mime + ';base64,' + result.content
      : null
  } catch (err) {
    return null
  }
}

function showImages (leftURL, rightURL) {
  document.getElementById('diff-loading').hidden = true
  document.getElementById('diff-container').hidden = true
  const wrap = document.getElementById('diff-images')
  wrap.hidden = false
  ;[[diffDesc.left, leftURL], [diffDesc.right, rightURL]].forEach(function (entry) {
    const pane = document.createElement('div')
    pane.className = 'diff-image-pane'
    const label = document.createElement('div')
    label.className = 'diff-image-label'
    label.textContent = sideLabel(entry[0])
    pane.appendChild(label)
    if (entry[1]) {
      const img = document.createElement('img')
      img.src = entry[1]
      img.alt = sideLabel(entry[0])
      pane.appendChild(img)
    } else {
      const missing = document.createElement('div')
      missing.className = 'diff-image-missing'
      missing.textContent = l('diffNoImage') || 'No image on this side'
      pane.appendChild(missing)
    }
    wrap.appendChild(pane)
  })
}

async function loadDiff () {
  updateTitle()
  if (!diffDesc || !diffDesc.cwd || !diffDesc.left || !diffDesc.right) {
    showDiffError('(no diff)')
    return
  }
  const mime = imageMimeForPath(diffDesc.right.path || diffDesc.left.path)
  if (mime) {
    const leftImg = await sideImage(diffDesc.left, mime)
    const rightImg = await sideImage(diffDesc.right, mime)
    showImages(leftImg, rightImg)
    return
  }
  const left = await sideContent(diffDesc.left)
  const right = await sideContent(diffDesc.right)
  createDiffEditor(left, right)
}

function createDiffEditor (leftContent, rightContent) {
  document.getElementById('diff-loading').hidden = true

  require.config({
    paths: { vs: '../editor/monaco/vs' },
    'vs/nls': { availableLanguages: { '*': 'en' } }
  })

  window.MonacoEnvironment = {
    getWorkerUrl: function (workerId, label) {
      if (label === 'json') {
        return '../editor/monaco/vs/assets/json.worker-CoJx_OPf.js'
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return '../editor/monaco/vs/assets/css.worker-URu8fCFR.js'
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return '../editor/monaco/vs/assets/html.worker-D1SL3iM8.js'
      }
      if (label === 'typescript' || label === 'javascript') {
        return '../editor/monaco/vs/assets/ts.worker-BWKtMYOk.js'
      }
      return '../editor/monaco/vs/assets/editor.worker-lj3bdIIn.js'
    }
  }

  require(['vs/editor/editor.main'], function () {
    const language = getLanguageForPath(diffDesc.right.path || diffDesc.left.path)
    const editable = diffDesc.editable === true && diffDesc.right.type === 'worktree'

    diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-container'), {
      theme: 'vs-dark',
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: !editable,
      minimap: { enabled: false },
      fontSize: editorPrefs.fontSize || 13,
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      wordWrap: editorPrefs.wordWrap === 'on' ? 'on' : 'off',
      tabSize: editorPrefs.tabSize || 2
    })

    const original = monaco.editor.createModel(leftContent, language)
    modifiedModel = monaco.editor.createModel(rightContent, language)
    diffEditor.setModel({ original: original, modified: modifiedModel })

    if (editable) {
      modifiedModel.onDidChangeContent(function () {
        setDirty(true)
        scheduleAutosave()
      })
    }

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
    here through menuRenderer.js for editor-like tabs */
    diffEditor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile)
  }, function (err) {
    showDiffError(err && err.message ? err.message : String(err))
  })
}

// warn on close if there are unsaved changes
let allowUnload = false

// Called by the browser UI after the user confirms that unsaved changes may
// be discarded.
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

/* the pending autosave should not sit in a timer while the page is going
away, so write it out as soon as the page loses focus or is hidden */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    flushAutosave()
  }
})
window.addEventListener('blur', flushAutosave)

// expose dirty state for main process tab close confirmation
window.editorIsDirty = function () { return dirty }

loadDiff()
