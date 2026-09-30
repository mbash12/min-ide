/* global ipc, CSS */

/* VSCode-style file tree for the sidebar's Files panel. Shows the workspace
path of the currently selected task. Directories expand/collapse in place
(children load lazily). A right-click context menu offers create, rename,
move and delete actions; the header above the tree (like the git panel's)
adds refresh and collapse-all. Single-clicking a file opens it in a
temporary editor preview tab (reused for each new file); clicking it again
pins the tab. Expanded folders are persisted per workspace so the tree
survives restarts. */

const remoteMenu = require('remoteMenuRenderer.js')
const fileIcons = require('sidebar/fileIcons.js')
const uiStateDB = require('util/uiStateDB.js')
const sidebarUI = require('sidebar/ui.js')
const createDebouncedWriter = require('sidebar/lifecycle/debouncedWriter.js')

const panel = document.getElementById('sidebar-panel-files')

let treeBody = null // the scrollable area that holds the tree rows

let renderToken = 0 // invalidates stale async renders after a re-render
const expandedPaths = new Set() // directories the user has expanded
let activeEditor = null // { input, commit } for the inline name editor
let initialized = false
let stateMutationVersion = 0

/* the file path opened by the last file-row click, used to detect a second
click on the same row (pin) */
let lastOpenedFilePath = null

const rowHeight = 8 // px added per tree level

function getWorkspacePath () {
  const ws = workspaces.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = workspaces.getSelected()
  return ws && ws.id != null ? String(ws.id) : null
}

/* ----- per-workspace state persistence ----- */

let currentWorkspaceId = null
let currentWorkspacePath = null

const stateWriter = createDebouncedWriter(function (key, state) {
  return uiStateDB.setFileTreeState(key, state)
}, 40)

async function loadSavedState (workspaceId, workspacePath) {
  workspaceId = workspaceId || currentWorkspaceId
  workspacePath = workspacePath === undefined ? currentWorkspacePath : workspacePath
  if (!workspaceId) return
  const mutationVersion = stateMutationVersion
  try {
    const state = await uiStateDB.getFileTreeState('tree:' + workspaceId)
    // A second workspace can be selected while the state is being read. Do
    // not let the slower response overwrite the newly selected workspace.
    if (workspaceId !== currentWorkspaceId || workspacePath !== currentWorkspacePath) return
    // A user may expand or collapse a folder while IndexedDB is responding.
    // Keep that interaction instead of applying an older saved snapshot over it.
    if (mutationVersion !== stateMutationVersion) return
    if (!state || !state.expandedPaths) return
    expandedPaths.clear()
    state.expandedPaths.forEach(function (p) { expandedPaths.add(p) })
  } catch (e) {
    // ignore: fall back to defaults
  }
}

function persistStateSoon () {
  if (!currentWorkspaceId) return
  stateMutationVersion++
  stateWriter.schedule('tree:' + currentWorkspaceId, {
    expandedPaths: Array.from(expandedPaths)
  })
}

/* WorkspaceList emits both names for compatibility with older task-aware
 * consumers. They describe one selection, so handle the pair through one
 * idempotent handler rather than restoring and persisting twice. */
function onWorkspaceSelected (workspaceId) {
  const selectedWorkspaceId = getWorkspaceId()
  const nextWorkspaceId = workspaceId != null && workspaceId !== ''
    ? String(workspaceId)
    : selectedWorkspaceId
  // Ignore a queued compatibility event if another selection has already
  // superseded it before the deferred event callback ran.
  if (workspaceId != null && workspaceId !== '' && selectedWorkspaceId && nextWorkspaceId !== selectedWorkspaceId) return
  syncWorkspaceScope(nextWorkspaceId)
}

function syncWorkspaceScope (workspaceId) {
  const selectedWorkspaceId = getWorkspaceId()
  const nextWorkspaceId = workspaceId != null ? String(workspaceId) : selectedWorkspaceId
  const nextWorkspacePath = getWorkspacePath() || null
  if (nextWorkspaceId === currentWorkspaceId && nextWorkspacePath === currentWorkspacePath) return

  const workspaceChanged = nextWorkspaceId !== currentWorkspaceId
  // Save expansions for the workspace being left. When only the folder path
  // changes, its old absolute paths no longer describe the visible tree.
  if (workspaceChanged) persistStateSoon()
  currentWorkspaceId = nextWorkspaceId
  currentWorkspacePath = nextWorkspacePath
  updateDirWatcher()
  expandedPaths.clear()
  lastOpenedFilePath = null
  cancelActiveEditor()
  render()

  if (workspaceChanged) {
    loadSavedState(nextWorkspaceId, nextWorkspacePath).then(function () {
      if (nextWorkspaceId === currentWorkspaceId && nextWorkspacePath === currentWorkspacePath) render()
    })
  } else {
    // Do not restore folders from the previous path under the same workspace.
    persistStateSoon()
  }
}

/* ----- filesystem watching ----- */

/* chokidar watches the workspace folder so external changes (git checkout,
builds, other editors) refresh the visible tree without a manual reload.
Like userscripts.js the module is required lazily - if it cannot load, the
tree simply stays manual-refresh. */

let dirWatcher = null
const changedDirs = new Set() // directories whose listings need a reload
let watcherFlushTimer = null

/* events that alter a directory listing; content changes do not affect the
tree and file saves happen constantly */
const watchedEvents = { add: true, unlink: true, addDir: true, unlinkDir: true }

function stopDirWatcher () {
  if (dirWatcher) {
    dirWatcher.close()
    dirWatcher = null
  }
  if (watcherFlushTimer) {
    clearTimeout(watcherFlushTimer)
    watcherFlushTimer = null
  }
  changedDirs.clear()
}

/* converts a path reported by the watcher into the slash-joined form rows
keep in dataset.path (workspacePath + '/' + relative segments). Returns null
for paths outside the workspace. */
function treePathFor (absPath) {
  const path = require('path')
  const rel = path.relative(currentWorkspacePath, absPath)
  if (!rel) return currentWorkspacePath
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null
  return currentWorkspacePath.replace(/[\\/]+$/, '') + '/' + rel.split(path.sep).join('/')
}

function onWatchEvent (event, changedPath, root) {
  if (root !== currentWorkspacePath || !watchedEvents[event]) return
  const treePath = treePathFor(changedPath)
  if (!treePath) return
  if (treePath === currentWorkspacePath) {
    // the workspace folder itself was created or removed
    render()
    return
  }
  if (event === 'unlinkDir') {
    // drop saved expansion for the removed directory and its descendants
    const prefix = treePath + '/'
    let pruned = false
    expandedPaths.forEach(function (p) {
      if (p === treePath || p.indexOf(prefix) === 0) {
        expandedPaths.delete(p)
        pruned = true
      }
    })
    if (pruned) persistStateSoon()
  }
  const parent = treePathFor(require('path').dirname(changedPath))
  if (parent) {
    changedDirs.add(parent)
    if (watcherFlushTimer) clearTimeout(watcherFlushTimer)
    watcherFlushTimer = setTimeout(flushChangedDirs, 250)
  }
}

function flushChangedDirs () {
  watcherFlushTimer = null
  /* the inline name editor lives inside a children container; emptying it
  mid-typing would commit a partial name on blur. Poll until it closes. */
  if (activeEditor) {
    watcherFlushTimer = setTimeout(flushChangedDirs, 400)
    return
  }
  const dirs = Array.from(changedDirs)
  changedDirs.clear()
  dirs.forEach(reloadDir)
}

/* reloads one expanded directory's listing in place. Rows for vanished
entries disappear, new entries appear, and nested expansion restores itself
from expandedPaths. Directories that are not loaded yet are skipped - their
listing is read fresh the next time they expand. */
function reloadDir (dirPath) {
  if (!treeBody) return
  const row = treeBody.querySelector('.file-tree-row[data-path="' + CSS.escape(dirPath) + '"]')
  const children = row && row.nextElementSibling
  if (!children || !children.classList.contains('file-tree-children')) return
  if (children.dataset.loaded !== 'true' && children.dataset.loading !== 'true') return
  children.dataset.loading = 'false'
  children.dataset.loaded = 'false'
  // invalidate a chunked render or IPC read still in flight for this container
  children.dataset.loadGen = String((parseInt(children.dataset.loadGen) || 0) + 1)
  empty(children)
  loadChildren(dirPath, children, parseInt(children.dataset.depth) || 1, renderToken)
}

function updateDirWatcher () {
  stopDirWatcher()
  const root = currentWorkspacePath
  if (!root) return
  let chokidar
  try {
    chokidar = require('chokidar')
  } catch (e) {
    return
  }
  try {
    dirWatcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      disableGlobbing: true,
      ignored: function (watchPath) {
        if (watchPath === root) return false
        const name = watchPath.split(/[\\/]/).pop()
        // dependency and VCS folders flood the watcher with churn and file
        // descriptors without producing anything the user needs to see
        return name === '.git' || name === 'node_modules'
      }
    })
    dirWatcher.on('all', function (event, changedPath) {
      onWatchEvent(event, changedPath, root)
    })
    dirWatcher.on('error', function () {})
  } catch (e) {
    dirWatcher = null
  }
}

/* ----- row rendering ----- */

function createRow (entry, fullPath, depth) {
  const isDir = entry.type === 'directory'

  const row = document.createElement('div')
  row.className = 'file-tree-row' + (isDir ? ' directory' : ' file')
  row.dataset.path = fullPath
  row.dataset.type = entry.type
  row.style.paddingLeft = (depth * rowHeight + 3) + 'px'

  // the first slot holds the chevron (folders) or the file icon, so the
  // two columns align and labels start at the same x position
  if (isDir) {
    const chevron = document.createElement('span')
    chevron.className = 'codicon codicon-chevron-right file-tree-chevron'
    row.appendChild(chevron)
  } else {
    const icon = document.createElement('img')
    icon.className = 'file-tree-icon'
    icon.src = fileIcons.pathPrefix + fileIcons.getIcon(entry.name)
    icon.alt = ''
    icon.draggable = false
    row.appendChild(icon)
  }

  const label = document.createElement('span')
  label.className = 'file-tree-label'
  label.textContent = entry.name
  label.title = fullPath
  row.appendChild(label)

  return row
}

/* children container for a directory. Its --tree-depth custom property lets
the CSS draw the indentation guide line under the parent row's chevron. */
function createChildrenContainer (depth) {
  const children = document.createElement('div')
  children.className = 'file-tree-children'
  children.hidden = true
  children.dataset.depth = depth
  children.style.setProperty('--tree-depth', depth)
  return children
}

/* attaches the click behavior: directories toggle, files open in an editor
preview tab (clicking the same row again pins it) */
function attachClick (row, entry, children, fullPath, depth) {
  row.addEventListener('click', function (e) {
    e.stopPropagation()
    if (entry.type === 'directory') {
      toggleDirectory(row, children, fullPath, depth)
    } else {
      selectRow(row)
      const editorView = require('editorView.js')
      // clicking the same file row again pins its tab, matching
      // double-click-to-pin in VSCode
      if (fullPath === lastOpenedFilePath) {
        // only pin when the preview actually shows this file; it may be a
        // diff tab by now, which pins itself on double-click instead
        const previewId = editorView.findPreviewTab()
        const tabId = editorView.findPinnedTab(fullPath) ||
          (previewId && editorView.getFilePath(previewId) === fullPath ? previewId : null)
        if (tabId) {
          editorView.pinTab(tabId)
        }
        lastOpenedFilePath = null
      } else {
        editorView.openFile(fullPath)
        lastOpenedFilePath = fullPath
      }
    }
  })
}

function addErrorRow (message) {
  const error = document.createElement('div')
  error.className = 'file-tree-error'
  error.textContent = message
  treeBody.appendChild(error)
}

/* how many rows a directory may add to the DOM per animation frame while
expanding; large folders render in chunks so the UI stays responsive */
const renderChunkSize = 200

/* loads the entries of dirPath into the children container, rendering them
in chunks so a folder with thousands of entries (e.g. node_modules) does not
freeze the UI. Returns a promise; if the directory can't be read, an error
row is shown instead. */
function loadChildren (dirPath, children, depth, token) {
  if (children.dataset.loading === 'true' || children.dataset.loaded === 'true') return Promise.resolve()
  children.dataset.loading = 'true'
  /* a container can be reloaded while a chunked render or IPC read for it is
  still in flight; the generation marks the newest load so stale passes abort
  instead of appending outdated rows */
  const loadGen = String((parseInt(children.dataset.loadGen) || 0) + 1)
  children.dataset.loadGen = loadGen
  const isStale = function () {
    return token !== renderToken || children.dataset.loadGen !== loadGen
  }
  return ipc.invoke('readDirectory', dirPath).then(function (entries) {
    if (isStale()) return // the tree was re-rendered or the dir reloaded meanwhile
    children.dataset.loading = 'false'
    if (entries === null) {
      addErrorRow(l('folderReadError'))
      return
    }
    children.dataset.loaded = 'true'

    /* appends rows for entries from start onward, one chunk per frame. The
    container is populated progressively; everything else (click handlers,
    nested expansion restore) is created together with each row. */
    let cursor = 0
    const renderChunk = function () {
      if (isStale()) return // a re-render or reload invalidated this pass
      const end = Math.min(cursor + renderChunkSize, entries.length)
      for (let i = cursor; i < end; i++) {
        const entry = entries[i]
        const fullPath = dirPath.replace(/[\\/]+$/, '') + '/' + entry.name
        const row = createRow({ name: entry.name, type: entry.type }, fullPath, depth)
        children.appendChild(row)
        let rowChildren = null
        if (entry.type === 'directory') {
          rowChildren = createChildrenContainer(depth + 1)
          children.appendChild(rowChildren)
        }
        attachClick(row, entry, rowChildren, fullPath, depth + 1)

        // restore previously expanded folders when re-rendering
        if (expandedPaths.has(fullPath)) {
          expandDirectory(row, rowChildren, fullPath, depth + 1)
        }
      }
      syncSelectionWithTab()
      cursor = end
      if (cursor < entries.length) {
        requestAnimationFrame(renderChunk)
      }
    }
    renderChunk()
  }).catch(function () {
    if (!isStale()) {
      children.dataset.loading = 'false'
      addErrorRow(l('folderReadError'))
    }
  })
}

function expandDirectory (row, children, dirPath, depth) {
  children.hidden = false
  row.querySelector('.file-tree-chevron').classList.add('expanded')
  expandedPaths.add(dirPath)
  persistStateSoon()
  if (!children.dataset.loaded) {
    loadChildren(dirPath, children, depth, renderToken)
  }
}

function collapseDirectory (row, children, dirPath) {
  children.hidden = true
  row.querySelector('.file-tree-chevron').classList.remove('expanded')
  expandedPaths.delete(dirPath)
  persistStateSoon()
}

function toggleDirectory (row, children, dirPath, depth) {
  if (children.hidden) {
    expandDirectory(row, children, dirPath, depth)
  } else {
    collapseDirectory(row, children, dirPath)
  }
}

/* highlights the clicked file and clears the previous selection */
function selectRow (row) {
  const previous = treeBody.querySelector('.file-tree-row.selected')
  if (previous && previous !== row) {
    previous.classList.remove('selected')
  }
  row.classList.add('selected')
}
function syncSelectionWithTab (tabId) {
  if (!treeBody || !window.tabs) return
  const editorView = require('editorView.js')
  const filePath = editorView.getFilePath(tabId || tabs.getSelected())
  const selectedRow = treeBody.querySelector('.file-tree-row.selected')
  const matchingRow = filePath && treeBody.querySelector('.file-tree-row[data-path="' + CSS.escape(filePath) + '"]')
  if (selectedRow && selectedRow !== matchingRow) {
    selectedRow.classList.remove('selected')
  }
  if (matchingRow) {
    matchingRow.classList.add('selected')
  }
}

/* ----- inline name editor (create + rename) ----- */

function finishEditor (editor, commit, value) {
  // Enter fires keydown and the re-render then fires blur on the removed
  // input; guard so the commit runs exactly once
  if (editor.disabled || (activeEditor && activeEditor.input !== editor)) {
    return
  }
  const editorState = activeEditor
  editor.disabled = true
  activeEditor = null
  if (editorState && editorState.input === editor && editor.parentNode && editorState.label) {
    editor.parentNode.replaceChild(editorState.label, editor)
  }
  commit(value)
}

function cancelActiveEditor () {
  if (!activeEditor) return
  const editor = activeEditor
  activeEditor = null
  editor.input.disabled = true
  if (editor.input.parentNode && editor.label) {
    editor.label.textContent = editor.originalName
    editor.input.parentNode.replaceChild(editor.label, editor.input)
  }
}

/* replaces the row's label with an inline input. Enter/Escape/blur finish
the edit; the commit callback handles the new value. */
function showEditor (row, initialValue, placeholder, commit) {
  if (activeEditor) cancelActiveEditor()

  const label = row.querySelector('.file-tree-label')
  const originalName = label.textContent

  const input = document.createElement('input')
  input.className = 'file-tree-edit-input'
  input.value = initialValue
  input.placeholder = placeholder || ''
  input.spellcheck = false
  row.replaceChild(input, label)
  input.focus()
  input.select()

  const editor = input

  function handleEnter (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      finishEditor(editor, commit, editor.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editor.disabled = true
      label.textContent = originalName
      if (editor.parentNode) editor.parentNode.replaceChild(label, editor)
      else editor.remove()
      activeEditor = null
    }
  }
  editor.addEventListener('keydown', handleEnter)
  editor.addEventListener('blur', function () {
    finishEditor(editor, commit, editor.value)
  })
  activeEditor = { input: editor, label: label, originalName: originalName }
}

function isCurrentTreeScope (workspaceId, workspacePath) {
  return workspaceId === currentWorkspaceId &&
    workspacePath === currentWorkspacePath &&
    workspaceId === getWorkspaceId() &&
    workspacePath === (getWorkspacePath() || null)
}

/* starts an inline "new file/folder" editor inside parentPath's children.
Expands the parent first so the editor is visible. */
function startCreate (parentPath, depth, type) {
  const workspaceId = currentWorkspaceId
  const workspacePath = currentWorkspacePath
  expandedPaths.add(parentPath)
  persistStateSoon()
  render()
  const token = renderToken
  // wait for the (async) child load, then insert the editor
  const tryInsert = function (attempt) {
    if (attempt > 30 || token !== renderToken || !isCurrentTreeScope(workspaceId, workspacePath)) return
    const parentRow = treeBody.querySelector('.file-tree-row[data-path="' + CSS.escape(parentPath) + '"]')
    const children = parentRow && parentRow.nextElementSibling
    if (children) {
      children.hidden = false
      // build a temporary row, then replace its label with the editor
      const editorRow = createRow({ name: ' ', type: type }, parentPath + '/new-entry', depth)
      children.insertBefore(editorRow, children.firstChild)
      showEditor(editorRow, '', type === 'directory' ? l('fileTreeFolderName') : l('fileTreeFileName'), function (value) {
        var name = value.trim()
        if (!name) {
          render()
          return
        }
        if (!isCurrentTreeScope(workspaceId, workspacePath)) return
        ipc.invoke('fileTreeCreate', workspacePath, parentPath, name, type).then(function (error) {
          if (!isCurrentTreeScope(workspaceId, workspacePath)) return
          if (error) alert(error)
          render()
        }).catch(function (error) {
          if (!isCurrentTreeScope(workspaceId, workspacePath)) return
          alert(error && error.message ? error.message : String(error))
          render()
        })
      })
    } else {
      setTimeout(function () { tryInsert(attempt + 1) }, 50)
    }
  }
  tryInsert(0)
}

/* replaces a row's label with an inline rename editor */
function startRename (row, oldPath) {
  const workspaceId = currentWorkspaceId
  const workspacePath = currentWorkspacePath
  const label = row.querySelector('.file-tree-label')
  const originalName = label.textContent
  showEditor(row, originalName, '', function (value) {
    var name = value.trim()
    if (!name || name === originalName) {
      render()
      return
    }
    if (!isCurrentTreeScope(workspaceId, workspacePath)) return
    ipc.invoke('fileTreeRename', workspacePath, oldPath, name).then(function (error) {
      if (!isCurrentTreeScope(workspaceId, workspacePath)) return
      if (error) alert(error)
      render()
    }).catch(function (error) {
      if (!isCurrentTreeScope(workspaceId, workspacePath)) return
      alert(error && error.message ? error.message : String(error))
      render()
    })
  })
}

/* ----- context menu actions ----- */

function refreshTree () {
  expandedPaths.add(getWorkspacePath())
  persistStateSoon()
  render()
}

function collapseAll () {
  // keep only the root expanded
  const root = getWorkspacePath()
  expandedPaths.forEach(function (p) {
    if (p !== root) expandedPaths.delete(p)
  })
  persistStateSoon()
  render()
}

function moveEntry (sourcePath) {
  const workspaceId = currentWorkspaceId
  const workspacePath = currentWorkspacePath
  const parent = sourcePath.replace(/[\\/][^\\/]*$/, '')
  ipc.invoke('showOpenDialog', { properties: ['openDirectory'], defaultPath: parent })
    .then(function (dirs) {
      if (!dirs || !dirs[0] || !isCurrentTreeScope(workspaceId, workspacePath)) return null
      return ipc.invoke('fileTreeMove', workspacePath, sourcePath, dirs[0])
    })
    .then(function (error) {
      if (!isCurrentTreeScope(workspaceId, workspacePath)) return
      if (error) alert(error)
      render()
    }).catch(function (error) {
      if (!isCurrentTreeScope(workspaceId, workspacePath)) return
      alert(error && error.message ? error.message : String(error))
      render()
    })
}

function deleteEntry (entryPath, entryName) {
  if (!confirm(l('fileTreeDeleteConfirmation').replace('%s', entryName))) {
    return
  }
  const workspaceId = currentWorkspaceId
  const workspacePath = currentWorkspacePath
  ipc.invoke('fileTreeDelete', workspacePath, entryPath).then(function (error) {
    if (!isCurrentTreeScope(workspaceId, workspacePath)) return
    if (error) alert(error)
    render()
  }).catch(function (error) {
    if (!isCurrentTreeScope(workspaceId, workspacePath)) return
    alert(error && error.message ? error.message : String(error))
    render()
  })
}

/* opens the context menu at x,y. menuItems is an array of {label, click,
submenu} sections. */
function showContextMenu (sections, x, y) {
  remoteMenu.open(sections, x, y)
}

function showRowMenu (row, x, y) {
  const entryPath = row.dataset.path
  const entryName = entryPath.split(/[\\/]/).pop()
  const isDir = row.dataset.type === 'directory'
  const depth = parseInt(row.style.paddingLeft) / rowHeight

  const baseMenu = [
    [{
      label: l('fileTreeNewFile'),
      click: function () { startCreate(entryPath, depth + 1, 'file') }
    },
    {
      label: l('fileTreeNewFolder'),
      click: function () { startCreate(entryPath, depth + 1, 'directory') }
    }],
    [{
      label: l('fileTreeRename'),
      click: function () { startRename(row, entryPath) }
    },
    {
      label: l('fileTreeMove'),
      click: function () { moveEntry(entryPath) }
    }],
    [{
      label: l('fileTreeDelete'),
      click: function () { deleteEntry(entryPath, entryName) }
    }]
  ]

  if (isDir) {
    showContextMenu(baseMenu, x, y)
  } else {
    const fileMenu = [
      [{
        label: l('fileTreeRename'),
        click: function () { startRename(row, entryPath) }
      },
      {
        label: l('fileTreeMove'),
        click: function () { moveEntry(entryPath) }
      }],
      [{
        label: l('fileTreeDelete'),
        click: function () { deleteEntry(entryPath, entryName) }
      }]
    ]
    showContextMenu(fileMenu, x, y)
  }
}

function showBackgroundMenu (x, y) {
  const root = getWorkspacePath()
  showContextMenu([
    [{
      label: l('fileTreeNewFile'),
      click: function () { startCreate(root, 1, 'file') }
    },
    {
      label: l('fileTreeNewFolder'),
      click: function () { startCreate(root, 1, 'directory') }
    }],
    [{
      label: l('fileTreeRefresh'),
      click: refreshTree
    },
    {
      label: l('fileTreeCollapseAll'),
      click: collapseAll
    }]
  ], x, y)
}

/* ----- rendering ----- */

/* renders the tree for the given workspace path, or an empty state */
function render () {
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId()
  if (wsPath !== currentWorkspacePath || wsId !== currentWorkspaceId) {
    syncWorkspaceScope(wsId)
    return
  }
  cancelActiveEditor()
  renderToken++
  empty(treeBody)

  if (!wsPath) {
    const emptyState = document.createElement('div')
    emptyState.className = 'file-tree-empty'
    emptyState.textContent = l('noWorkspaceFolder')
    treeBody.appendChild(emptyState)
    return
  }

  const rootName = wsPath.split(/[\\/]/).filter(Boolean).pop() || wsPath
  const rootRow = createRow({ name: rootName, type: 'directory' }, wsPath, 0)
  treeBody.appendChild(rootRow)

  const rootChildren = createChildrenContainer(1)
  treeBody.appendChild(rootChildren)
  rootChildren.hidden = false
  attachClick(rootRow, { name: rootName, type: 'directory' }, rootChildren, wsPath, 1)
  rootRow.querySelector('.file-tree-chevron').classList.add('expanded')

  const token = renderToken
  loadChildren(wsPath, rootChildren, 1, token)
  syncSelectionWithTab()
}

/* ----- header (title bar, consistent with the git panel) ----- */

function buildHeader () {
  return sidebarUI.createPanelHeader({
    title: l('sidebarFileTree') || 'File Tree',
    actions: [{
      icon: 'codicon-refresh',
      label: l('fileTreeRefresh'),
      onClick: refreshTree
    }, {
      icon: 'codicon-collapse-all',
      label: l('fileTreeCollapseAll'),
      onClick: collapseAll
    }]
  })
}

const fileTree = {
  initialize: function () {
    if (!panel || initialized) return
    initialized = true
    // structure: [header] + [scrollable tree body] inside the panel
    panel.appendChild(buildHeader())

    treeBody = document.createElement('div')
    treeBody.className = 'file-tree-body'
    panel.appendChild(treeBody)

    // right-click: row menu or background menu
    treeBody.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      const row = e.target.closest('.file-tree-row')
      if (row) {
        showRowMenu(row, e.clientX, e.clientY)
      } else {
        showBackgroundMenu(e.clientX, e.clientY)
      }
    })

    // bind to the current workspace and restore its saved tree state
    currentWorkspaceId = getWorkspaceId()
    currentWorkspacePath = getWorkspacePath() || null
    updateDirWatcher()
    loadSavedState(currentWorkspaceId, currentWorkspacePath).then(function () {
      if (currentWorkspaceId === getWorkspaceId() && currentWorkspacePath === (getWorkspacePath() || null)) render()
    })

    // re-render when the selected workspace changes or its path is updated
    workspaces.on('workspace-selected', onWorkspaceSelected)
    workspaces.on('workspace-updated', function (workspaceId, key) {
      if (key !== 'path') return
      const selectedWorkspaceId = getWorkspaceId()
      if (selectedWorkspaceId && String(workspaceId) !== selectedWorkspaceId) return
      syncWorkspaceScope()
    })
    workspaces.on('workspace-destroyed', function (workspaceId) {
      if (workspaceId !== null && workspaceId !== undefined) {
        stateWriter.cancel('tree:' + String(workspaceId))
      }
    })
    // Covers synchronized workspace updates and task switches.
    workspaces.on('state-sync-change', function () { syncWorkspaceScope() })
    tasks.on('tab-selected', function (tabId, taskId) {
      const activeTask = window.tasks.getSelected()
      if (activeTask && taskId === activeTask.id) {
        syncSelectionWithTab(tabId)
      }
    })
  },

  /* used by the !file search bang to reveal a folder in the tree */
  getExpandedPaths: function () {
    return expandedPaths
  },
  rerender: render
}

module.exports = fileTree
