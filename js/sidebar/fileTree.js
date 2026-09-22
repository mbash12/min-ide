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

const panel = document.getElementById('sidebar-panel-files')

let treeBody = null // the scrollable area that holds the tree rows

let renderToken = 0 // invalidates stale async renders after a re-render
let lastRenderedPath = null
const expandedPaths = new Set() // directories the user has expanded
let activeEditor = null // { input, commit } for the inline name editor

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

async function loadSavedState (workspaceId) {
  workspaceId = workspaceId || currentWorkspaceId
  if (!workspaceId) return
  try {
    const state = await uiStateDB.getFileTreeState('tree:' + workspaceId)
    // A second workspace can be selected while the state is being read. Do
    // not let the slower response overwrite the newly selected workspace.
    if (workspaceId !== currentWorkspaceId) return
    if (!state || !state.expandedPaths) return
    expandedPaths.clear()
    state.expandedPaths.forEach(function (p) { expandedPaths.add(p) })
  } catch (e) {
    // ignore: fall back to defaults
  }
}

async function persistState () {
  if (!currentWorkspaceId) return
  const state = {
    expandedPaths: Array.from(expandedPaths)
  }
  await uiStateDB.setFileTreeState('tree:' + currentWorkspaceId, state)
}

function persistStateSoon () {
  persistState().catch(function () {})
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
  if (nextWorkspaceId === currentWorkspaceId) return

  persistStateSoon()
  currentWorkspaceId = nextWorkspaceId
  expandedPaths.clear()
  loadSavedState(nextWorkspaceId).then(function () {
    if (nextWorkspaceId === currentWorkspaceId) render()
  })
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
        const tabId = editorView.findPinnedTab(fullPath) || editorView.findPreviewTab()
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
  return ipc.invoke('readDirectory', dirPath).then(function (entries) {
    if (token !== renderToken) return // the tree was re-rendered meanwhile
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
      if (token !== renderToken) return // a re-render invalidated this pass
      const end = Math.min(cursor + renderChunkSize, entries.length)
      for (let i = cursor; i < end; i++) {
        const entry = entries[i]
        const fullPath = dirPath.replace(/[\\/]+$/, '') + '/' + entry.name
        const row = createRow({ name: entry.name, type: entry.type }, fullPath, depth)
        children.appendChild(row)
        syncSelectionWithTab()
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
      cursor = end
      if (cursor < entries.length) {
        requestAnimationFrame(renderChunk)
      }
    }
    renderChunk()
  }).catch(function () {
    if (token === renderToken) {
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
  if (!treeBody) return
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
  editor.disabled = true
  activeEditor = null
  commit(value)
}

/* replaces the row's label with an inline input. Enter/Escape/blur finish
the edit; the commit callback handles the new value. */
function showEditor (row, initialValue, placeholder, commit) {
  if (activeEditor) {
    // cancel the previous editor: re-render restores its label
    render()
  }

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

  activeEditor = { input: input }
  const editor = input

  function handleEnter (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      finishEditor(editor, commit, editor.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      label.textContent = originalName
      editor.remove()
      activeEditor = null
    }
  }
  editor.addEventListener('keydown', handleEnter)
  editor.addEventListener('blur', function () {
    finishEditor(editor, commit, editor.value)
  })
}

/* starts an inline "new file/folder" editor inside parentPath's children.
Expands the parent first so the editor is visible. */
function startCreate (parentPath, depth, type) {
  expandedPaths.add(parentPath)
  render()
  // wait for the (async) child load, then insert the editor
  const tryInsert = function (attempt) {
    if (attempt > 30) return
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
        ipc.invoke('fileTreeCreate', getWorkspacePath(), parentPath, name, type).then(function (error) {
          if (error) {
            alert(error)
          }
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
  const label = row.querySelector('.file-tree-label')
  const originalName = label.textContent
  showEditor(row, originalName, '', function (value) {
    var name = value.trim()
    if (!name || name === originalName) {
      label.textContent = originalName
      return
    }
    ipc.invoke('fileTreeRename', getWorkspacePath(), oldPath, name).then(function (error) {
      if (error) {
        alert(error)
      }
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
  const parent = sourcePath.replace(/[\\/][^\\/]*$/, '')
  ipc.invoke('showOpenDialog', { properties: ['openDirectory'], defaultPath: parent })
    .then(function (dirs) {
      if (!dirs || !dirs[0]) return
      return ipc.invoke('fileTreeMove', getWorkspacePath(), sourcePath, dirs[0])
    })
    .then(function (error) {
      if (error) {
        alert(error)
      }
      render()
    })
}

function deleteEntry (entryPath, entryName) {
  if (!confirm(l('fileTreeDeleteConfirmation').replace('%s', entryName))) {
    return
  }
  ipc.invoke('fileTreeDelete', getWorkspacePath(), entryPath).then(function (error) {
    if (error) {
      alert(error)
    }
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
  const wsPath = getWorkspacePath()
  lastRenderedPath = wsPath
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
  rootChildren.dataset.loaded = 'true'
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
    loadSavedState().then(function () {
      render()
    })

    // re-render when the selected workspace changes or its path is updated
    workspaces.on('workspace-selected', onWorkspaceSelected)
    // task switches within a workspace share the same path/state; the
    // workspace-selected handler above covers re-renders
    workspaces.on('state-sync-change', function () {
      const wsPath = getWorkspacePath()
      if (wsPath !== lastRenderedPath) {
        render()
      }
    })
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
