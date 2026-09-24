/* global ipc, l, empty, MutationObserver, prompt, electron */
/* Source Control (git) panel for the sidebar.
   Shows git status for the current workspace path, mirroring VSCode's
   Source Control view: branch header, commit box, and grouped file lists
   (Staged, Changes, Untracked) with stage/unstage/discard actions.
   Panel state (collapsed sections, commit message draft, scroll offset) is
   persisted per workspace through uiStateDB so it survives restarts.
*/

const fileIcons = require('sidebar/fileIcons.js')
const uiStateDB = require('util/uiStateDB.js')
const createGitGraphView = require('sidebar/gitGraphView.js')
const createGitRefreshGate = require('sidebar/gitRefreshGate.js')
const createGitStatePersistence = require('sidebar/gitStatePersistence.js')

const panel = document.getElementById('sidebar-panel-git')

let currentWorkspacePath = null
let currentGitRoot = null
let currentStatus = null
let isLoading = false
let commitMessage = ''

let currentGraph = null
let currentLogDetailed = null

const collapsedSections = new Set()
const graphState = { scrollTop: 0, viewHeight: 0, expandedCommit: null }
const refreshGate = createGitRefreshGate()
let renderToken = 0 // invalidates stale async renders (diff loading)
let lastRenderKey = null // data signature of the last render; skips no-op re-renders

/* identifies what the panel would render right now; the periodic refresh
   only rebuilds the DOM when this changes, so open diffs, scroll positions
   and the commit box aren't torn down by a no-op poll */
function renderKey () {
  const statusKey = currentStatus && currentStatus.signature != null
    ? currentStatus.signature
    : JSON.stringify(currentStatus)
  return JSON.stringify([currentWorkspaceId, currentWorkspacePath, statusKey, currentGraph, currentLogDetailed])
}

let currentWorkspaceId = null

const graphViewModule = createGitGraphView({
  document: document,
  ipc: ipc,
  l: l,
  fileIcons: fileIcons,
  electron: electron,
  empty: empty,
  panel: panel,
  collapsedSections: collapsedSections,
  graphState: graphState,
  persistStateSoon: persistStateSoon,
  statusLetterColor: statusLetterColor,
  getGraphData: function () { return { graph: currentGraph, commits: currentLogDetailed } },
  getGitRoot: function () { return currentGitRoot },
  getWorkspacePath: function () { return currentWorkspacePath },
  getRenderToken: function () { return renderToken },
  refresh: refresh
})

function getWorkspacePath () {
  const ws = workspaces.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = workspaces.getSelected()
  return ws && ws.id != null ? String(ws.id) : null
}

function isWorkspaceSelectionCurrent (workspaceId, workspacePath) {
  return workspaceId === currentWorkspaceId && workspacePath === currentWorkspacePath &&
    getWorkspaceId() === workspaceId && (getWorkspacePath() || null) === workspacePath
}

/* ----- per-workspace state persistence ----- */

/* sections collapsed by default on first run (Branches, Graph) */
const defaultCollapsedSections = ['branches', 'graph']

const statePersistence = createGitStatePersistence({
  uiStateDB: uiStateDB,
  workspaces: workspaces,
  getCurrentWorkspaceId: function () { return currentWorkspaceId }
})

function snapshotState () {
  return {
    collapsedSections: Array.from(collapsedSections),
    commitMessage: commitMessage,
    graphScrollTop: graphState.scrollTop,
    graphViewHeight: graphState.viewHeight,
    graphExpandedCommit: graphState.expandedCommit
  }
}

async function loadSavedState (workspaceId) {
  workspaceId = workspaceId || currentWorkspaceId
  const workspacePath = currentWorkspacePath
  const revision = statePersistence.getRevision()
  const key = workspaceId ? 'git:' + workspaceId : null
  if (!key) return
  try {
    const state = await uiStateDB.getGitPanelState(key)
    // A later selection may have happened while the state was loading. Do
    // not apply the old workspace's draft or graph state to the new one.
    if (workspaceId !== currentWorkspaceId || workspacePath !== currentWorkspacePath || revision !== statePersistence.getRevision()) return
    collapsedSections.clear()
    if (state && state.collapsedSections) {
      ;(state.collapsedSections || []).forEach(function (s) { collapsedSections.add(s) })
      commitMessage = state.commitMessage || ''
      graphState.scrollTop = state.graphScrollTop || 0
      graphState.viewHeight = state.graphViewHeight || 0
      graphState.expandedCommit = state.graphExpandedCommit || null
    } else {
      // first run for this workspace: Branches & Graph start collapsed
      defaultCollapsedSections.forEach(function (s) { collapsedSections.add(s) })
    }
  } catch (e) {
    // ignore: fall back to defaults
  }
}

/* Keep only the latest snapshot for each workspace and serialize writes.
   Scrolling the graph and typing a draft can otherwise enqueue many writes,
   and overlapping IndexedDB requests can let an older snapshot win. */
function persistStateSoon () {
  if (!statePersistence.isWritable(currentWorkspaceId)) return
  statePersistence.persist(currentWorkspaceId, snapshotState())
}

function onWorkspaceDestroyed (workspaceId) {
  statePersistence.invalidateWorkspace(workspaceId)
}

function onWorkspaceAdded (workspaceId) {
  statePersistence.workspaceAdded(workspaceId)
}

/* WorkspaceList emits both names for compatibility with older task-aware
 * consumers. They describe one selection, so process the pair only once. */
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
  refreshGate.invalidate()
  isLoading = false
  currentWorkspaceId = nextWorkspaceId
  currentWorkspacePath = getWorkspacePath() || null
  currentGitRoot = null
  currentStatus = null
  currentGraph = null
  currentLogDetailed = null
  commitMessage = ''
  collapsedSections.clear()
  defaultCollapsedSections.forEach(function (section) { collapsedSections.add(section) })
  graphState.scrollTop = 0
  graphState.viewHeight = 0
  graphState.expandedCommit = null
  lastRenderKey = null
  updateBadge(0)
  render()
  loadSavedState(nextWorkspaceId).then(function () {
    if (nextWorkspaceId === currentWorkspaceId) render()
  })
}

function syncWorkspacePath () {
  const workspaceId = getWorkspaceId()
  const workspacePath = getWorkspacePath() || null
  if (workspaceId !== currentWorkspaceId) {
    onWorkspaceSelected(workspaceId)
    return
  }
  if (workspacePath === currentWorkspacePath) return

  // Drop path-scoped status immediately. The next render starts a fresh read;
  // old git status/graph data must not remain visible while it is in flight.
  refreshGate.invalidate()
  isLoading = false
  currentWorkspacePath = workspacePath
  currentGitRoot = null
  currentStatus = null
  currentGraph = null
  currentLogDetailed = null
  commitMessage = ''
  graphState.expandedCommit = null
  graphState.scrollTop = 0
  lastRenderKey = null
  persistStateSoon()
  updateBadge(0)
  render()
}

function statusLetterColor (status) {
  if (status === 'modified' || status === 'M') return 'var(--git-modified, #cca700)'
  if (status === 'added' || status === 'A') return 'var(--git-added, #73c991)'
  if (status === 'deleted' || status === 'D') return 'var(--git-deleted, #f85149)'
  if (status === 'untracked' || status === '?') return 'var(--git-untracked, #73c991)'
  if (status === 'renamed' || status === 'R') return 'var(--git-renamed, #73c991)'
  return 'inherit'
}

function shortStatusLabel (entry) {
  const s = entry.status
  if (s === 'modified') return 'M'
  if (s === 'added') return 'A'
  if (s === 'deleted') return 'D'
  if (s === 'renamed') return 'R'
  if (s === 'untracked') return 'U'
  if (s === 'conflicted') return 'C'
  return entry.x || entry.status[0].toUpperCase()
}

function buildEmptyState (message, actionLabel, actionFn) {
  const wrap = document.createElement('div')
  wrap.className = 'git-empty-state'
  const p = document.createElement('div')
  p.className = 'git-empty-message'
  p.textContent = message
  wrap.appendChild(p)
  if (actionLabel && actionFn) {
    const btn = document.createElement('button')
    btn.className = 'git-action-button primary'
    btn.textContent = actionLabel
    btn.addEventListener('click', actionFn)
    wrap.appendChild(btn)
  }
  return wrap
}

function buildCommitBox () {
  const box = document.createElement('div')
  box.className = 'git-commit-box'

  const textarea = document.createElement('textarea')
  textarea.className = 'git-commit-input'
  const branch = currentStatus && currentStatus.branch
  textarea.placeholder = branch
    ? 'Message (Ctrl+Enter to commit on "' + branch + '")'
    : (l('gitCommitMessage') || 'Message (Ctrl+Enter to commit)')
  textarea.rows = 2
  textarea.value = commitMessage
  textarea.addEventListener('input', function () {
    commitMessage = textarea.value
    updateCommitButtonState()
    persistStateSoon()
  })
  textarea.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      commitOrStageAll()
    }
  })
  const inputWrap = document.createElement('div')
  inputWrap.className = 'git-commit-input-wrap'
  inputWrap.appendChild(textarea)

  const generateBtn = document.createElement('button')
  generateBtn.type = 'button'
  generateBtn.className = 'git-generate-message codicon codicon-sparkle'
  generateBtn.title = 'Generate Commit Message'
  generateBtn.setAttribute('aria-label', generateBtn.title)
  generateBtn.addEventListener('click', async function () {
    const workspaceId = currentWorkspaceId
    const workspacePath = currentWorkspacePath
    const cwd = currentGitRoot || currentWorkspacePath
    generateBtn.disabled = true
    generateBtn.classList.add('codicon-loading', 'codicon-modifier-spin')
    generateBtn.classList.remove('codicon-sparkle')
    try {
      const result = await ipc.invoke('gitGenerateCommitMessage', cwd)
      if (!isWorkspaceSelectionCurrent(workspaceId, workspacePath)) return
      if (!result || result.error) {
        alert((result && result.error) || 'Could not generate a commit message.')
      } else {
        commitMessage = result.message
        textarea.value = result.message
        textarea.focus()
        updateCommitButtonState()
        persistStateSoon()
      }
    } catch (e) {
      if (isWorkspaceSelectionCurrent(workspaceId, workspacePath)) alert(e.message || 'Could not generate a commit message.')
    } finally {
      generateBtn.classList.remove('codicon-loading', 'codicon-modifier-spin')
      generateBtn.classList.add('codicon-sparkle')
      if (isWorkspaceSelectionCurrent(workspaceId, workspacePath)) {
        generateBtn.disabled = !(currentStatus && currentStatus.staged && currentStatus.staged.length > 0)
      }
    }
  })
  inputWrap.appendChild(generateBtn)
  box.appendChild(inputWrap)

  const actions = document.createElement('div')
  actions.className = 'git-commit-actions'

  const commitBtn = document.createElement('button')
  commitBtn.className = 'git-commit-button'
  commitBtn.textContent = l('gitCommit') || 'Commit'
  commitBtn.addEventListener('click', commitOrStageAll)
  actions.appendChild(commitBtn)

  box.appendChild(actions)

  // expose for update
  box._textarea = textarea
  box._commitBtn = commitBtn

  function updateCommitButtonState () {
    const hasMessage = commitMessage.trim().length > 0
    const hasStaged = currentStatus && currentStatus.staged && currentStatus.staged.length > 0
    const hasUnstaged = currentStatus &&
      ((currentStatus.unstaged && currentStatus.unstaged.length > 0) ||
      (currentStatus.untracked && currentStatus.untracked.length > 0) ||
      (currentStatus.conflicted && currentStatus.conflicted.length > 0))
    // with nothing staged, the button stages everything instead of committing
    commitBtn.textContent = hasStaged
      ? (l('gitCommit') || 'Commit')
      : (l('gitStageAll') || 'Stage All')
    commitBtn.disabled = hasStaged ? !hasMessage : !hasUnstaged
    generateBtn.disabled = !hasStaged
  }
  box._updateState = updateCommitButtonState
  // initial
  setTimeout(updateCommitButtonState, 0)

  return box
}

async function doCommit () {
  const workspaceId = currentWorkspaceId
  const workspacePath = currentWorkspacePath
  const message = commitMessage.trim()
  if (!message) {
    alert(l('gitCommitMessageRequired') || 'Commit message required')
    return
  }
  const cwd = currentGitRoot || currentWorkspacePath
  const commitBtn = panel.querySelector('.git-commit-button')
  if (commitBtn) commitBtn.disabled = true
  const err = await ipc.invoke('gitCommit', cwd, message)
  if (err) {
    alert(err)
  } else if (isWorkspaceSelectionCurrent(workspaceId, workspacePath)) {
    commitMessage = ''
    const ta = panel.querySelector('.git-commit-input')
    if (ta) ta.value = ''
    persistStateSoon()
    await refresh()
  }
  if (commitBtn && isWorkspaceSelectionCurrent(workspaceId, workspacePath)) commitBtn.disabled = false
}

async function doStageAll () {
  const cwd = currentGitRoot || currentWorkspacePath
  const err = await ipc.invoke('gitStageAll', cwd)
  if (err) {
    alert(err)
    return
  }
  await refresh()
}

/* the commit button stages all changes when nothing is staged yet */
function commitOrStageAll () {
  const hasStaged = currentStatus && currentStatus.staged && currentStatus.staged.length > 0
  if (hasStaged) {
    doCommit()
  } else {
    doStageAll()
  }
}

function buildSection (title, entries, sectionKey, actions, emptyText) {
  const section = document.createElement('div')
  section.className = 'git-section'
  section.dataset.section = sectionKey

  const header = document.createElement('div')
  header.className = 'git-section-header'
  header.addEventListener('click', function () {
    if (collapsedSections.has(sectionKey)) {
      collapsedSections.delete(sectionKey)
    } else {
      collapsedSections.add(sectionKey)
    }
    section.classList.toggle('collapsed', collapsedSections.has(sectionKey))
    persistStateSoon()
  })

  const chevron = document.createElement('span')
  chevron.className = 'codicon codicon-chevron-down git-section-chevron'
  if (collapsedSections.has(sectionKey)) {
    section.classList.add('collapsed')
  }
  header.appendChild(chevron)

  const titleEl = document.createElement('span')
  titleEl.className = 'git-section-title'
  titleEl.textContent = title + ' (' + entries.length + ')'
  header.appendChild(titleEl)

  const headerActions = document.createElement('div')
  headerActions.className = 'git-section-header-actions'
  actions.forEach(function (a) {
    const btn = document.createElement('button')
    btn.className = 'codicon ' + a.icon + ' git-icon-button small'
    btn.title = a.title
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      a.onClick()
    })
    headerActions.appendChild(btn)
  })
  header.appendChild(headerActions)

  section.appendChild(header)

  const body = document.createElement('div')
  body.className = 'git-section-body'

  if (entries.length === 0) {
    if (emptyText) {
      const empty = document.createElement('div')
      empty.className = 'git-section-empty'
      empty.textContent = emptyText
      body.appendChild(empty)
    }
  } else {
    entries.forEach(function (entry) {
      body.appendChild(buildFileRow(entry, sectionKey))
    })
  }

  section.appendChild(body)
  return section
}

function buildFileRow (entry, sectionKey) {
  const row = document.createElement('div')
  row.className = 'git-file-row'
  row.dataset.path = entry.path

  const icon = document.createElement('img')
  icon.className = 'file-tree-icon'
  // use file icon mapping; for deleted file, keep generic
  const iconName = fileIcons.getIcon(entry.path.split('/').pop() || entry.path)
  icon.src = fileIcons.pathPrefix + iconName
  icon.alt = ''
  icon.draggable = false
  row.appendChild(icon)

  const label = document.createElement('span')
  label.className = 'git-file-label'
  label.title = entry.path + ' (' + entry.status + ')'
  const pathParts = entry.path.split(/[\\/]/)
  const fileName = document.createElement('span')
  fileName.className = 'git-file-name'
  fileName.textContent = pathParts.pop() || entry.path
  label.appendChild(fileName)
  if (pathParts.length) {
    const parentPath = document.createElement('span')
    parentPath.className = 'git-file-path'
    parentPath.textContent = pathParts.join('/')
    label.appendChild(parentPath)
  }
  row.appendChild(label)

  const statusBadge = document.createElement('span')
  statusBadge.className = 'git-status-badge'
  statusBadge.textContent = shortStatusLabel(entry)
  statusBadge.style.color = statusLetterColor(entry.status)
  statusBadge.title = entry.status
  row.appendChild(statusBadge)

  const actions = document.createElement('div')
  actions.className = 'git-file-actions'

  if (sectionKey === 'staged') {
    const unstageBtn = document.createElement('button')
    unstageBtn.className = 'codicon codicon-remove git-file-action-btn'
    unstageBtn.title = l('gitUnstage') || 'Unstage'
    unstageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      unstageFiles([entry.path])
    })
    actions.appendChild(unstageBtn)
  } else if (sectionKey === 'unstaged') {
    const stageBtn = document.createElement('button')
    stageBtn.className = 'codicon codicon-add git-file-action-btn'
    stageBtn.title = l('gitStage') || 'Stage'
    stageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      stageFiles([entry.path])
    })
    actions.appendChild(stageBtn)

    const discardBtn = document.createElement('button')
    discardBtn.className = 'codicon codicon-discard git-file-action-btn'
    discardBtn.title = l('gitDiscard') || 'Discard changes'
    discardBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      discardFiles([entry.path])
    })
    actions.appendChild(discardBtn)
  } else if (sectionKey === 'untracked') {
    const stageBtn = document.createElement('button')
    stageBtn.className = 'codicon codicon-add git-file-action-btn'
    stageBtn.title = l('gitStage') || 'Stage'
    stageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      stageFiles([entry.path])
    })
    actions.appendChild(stageBtn)

    const discardBtn = document.createElement('button')
    discardBtn.className = 'codicon codicon-trash git-file-action-btn'
    discardBtn.title = l('gitDiscard') || 'Delete file'
    discardBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (confirm((l('gitDiscardUntrackedConfirm') || 'Delete %s?').replace('%s', entry.path))) {
        discardFiles([entry.path])
      }
    })
    actions.appendChild(discardBtn)
  } else if (sectionKey === 'conflicted') {
    const stageBtn = document.createElement('button')
    stageBtn.className = 'codicon codicon-add git-file-action-btn'
    stageBtn.title = l('gitStage') || 'Stage'
    stageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      stageFiles([entry.path])
    })
    actions.appendChild(stageBtn)
  }

  row.appendChild(actions)

  // click opens the change in a diff tab, like the VS Code source control
  // list. The row menu still opens the file itself.
  row.addEventListener('click', function () {
    openEntryDiff(entry, sectionKey)
  })

  // context menu: stage/unstage/discard/open
  row.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    const remoteMenu = require('remoteMenuRenderer.js')
    // one flat section: remoteMenu separates top-level arrays with dividers
    const menu = []
    if (sectionKey === 'staged') {
      menu.push({ label: l('gitUnstage') || 'Unstage', click: function () { unstageFiles([entry.path]) } })
    } else {
      menu.push({ label: l('gitStage') || 'Stage', click: function () { stageFiles([entry.path]) } })
    }
    menu.push({ label: l('gitDiscard') || 'Discard', click: function () { discardFiles([entry.path]) } })
    menu.push({
      label: l('gitOpenFile') || 'Open File',
      click: function () {
        const editorView = require('editorView.js')
        editorView.openFile(entry.fullPath)
      }
    })
    remoteMenu.open([menu], e.clientX, e.clientY)
  })

  return row
}

/* clicking a changed file opens it in a diff tab, like VS Code's source
control view: HEAD vs working tree for unstaged changes, HEAD vs index for
staged ones. Untracked and conflicted files have no committed counterpart,
so they open the file itself instead */
function openEntryDiff (entry, sectionKey) {
  const editorView = require('editorView.js')
  const gitRoot = currentGitRoot || currentWorkspacePath
  const name = entry.path.split(/[\\/]/).pop()

  if (sectionKey === 'untracked' || sectionKey === 'conflicted') {
    editorView.openFile(entry.fullPath)
    return
  }

  if (sectionKey === 'staged') {
    editorView.openDiff({
      cwd: gitRoot,
      resource: entry.fullPath,
      title: name + ' (Index)',
      left: { type: 'ref', ref: 'HEAD', path: entry.oldPath || entry.path, label: 'HEAD' },
      right: { type: 'ref', ref: '', path: entry.path, label: 'Index' }
    })
    return
  }

  editorView.openDiff({
    cwd: gitRoot,
    resource: entry.fullPath,
    title: name + ' (Working Tree)',
    left: { type: 'ref', ref: 'HEAD', path: entry.path, label: 'HEAD' },
    right: { type: 'worktree', path: entry.path, label: 'Working Tree' },
    editable: true
  })
}

async function stageFiles (files) {
  const cwd = currentGitRoot || currentWorkspacePath
  const err = await ipc.invoke('gitStage', cwd, files)
  if (err) alert(err)
  await refresh()
}
async function unstageFiles (files) {
  const cwd = currentGitRoot || currentWorkspacePath
  const err = await ipc.invoke('gitUnstage', cwd, files)
  if (err) alert(err)
  await refresh()
}
async function discardFiles (files) {
  if (!confirm(l('gitDiscardConfirm') || 'Discard changes? This cannot be undone.')) {
    return
  }
  const cwd = currentGitRoot || currentWorkspacePath
  const err = await ipc.invoke('gitDiscard', cwd, files)
  if (err) alert(err)
  await refresh()
}

async function fetchGraph (gitRoot) {
  if (!gitRoot) return { graph: null, commits: null }
  try {
    const result = await ipc.invoke('gitGraphData', gitRoot, 30)
    return {
      graph: result && !result.error ? result.graph : null,
      commits: result && !result.error && result.commits ? result.commits : null
    }
  } catch (e) {
    return { graph: null, commits: null }
  }
}

function buildTitleBar () {
  const bar = document.createElement('div')
  bar.className = 'git-title-bar'
  const title = document.createElement('div')
  title.className = 'git-title'
  title.textContent = l('sourceControl') || 'Source Control'
  bar.appendChild(title)
  const actions = document.createElement('div')
  actions.className = 'git-title-actions'
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'codicon codicon-refresh git-icon-button'
  refreshBtn.title = l('gitRefresh') || 'Refresh'
  refreshBtn.addEventListener('click', refresh)
  actions.appendChild(refreshBtn)
  const moreBtn = document.createElement('button')
  moreBtn.className = 'codicon codicon-ellipsis git-icon-button'
  moreBtn.title = l('gitMoreActions') || 'More Actions'
  moreBtn.addEventListener('click', function (e) { showMoreActions(e) })
  actions.appendChild(moreBtn)
  bar.appendChild(actions)
  return bar
}

function showMoreActions (e) {
  if (e) e.stopPropagation()
  const remoteMenu = require('remoteMenuRenderer.js')
  const cwd = currentGitRoot || currentWorkspacePath
  const menu = []
  menu.push({ label: l('gitFetch') || 'Fetch', click: async function () { const err = await ipc.invoke('gitFetch', cwd); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitPull') || 'Pull', click: async function () { const err = await ipc.invoke('gitPull', cwd); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitPush') || 'Push', click: async function () { const err = await ipc.invoke('gitPush', cwd); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitSync') || 'Sync', click: async function () { const err = await ipc.invoke('gitSync', cwd); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitStash') || 'Stash', click: async function () { const msg = prompt(l('gitStashMessage') || 'Stash message', 'WIP'); if (msg === null) return; const err = await ipc.invoke('gitStash', cwd, msg); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitStashPop') || 'Stash Pop', click: async function () { const err = await ipc.invoke('gitStashPop', cwd); if (err) alert(err); await refresh() } })
  menu.push({ label: l('gitCreateBranch') || 'Create Branch', click: function () { const name = prompt(l('gitBranchName') || 'Branch name'); if (name) { ipc.invoke('gitCreateBranch', cwd, name).then(function (err) { if (err) alert(err); refresh() }) } } })
  const x = e ? e.clientX : 0
  const y = e ? e.clientY : 0
  remoteMenu.open([menu], x, y)
}

async function showBranchSwitcher (event) {
  if (event) event.stopPropagation()
  const cwd = currentGitRoot || currentWorkspacePath
  const result = await ipc.invoke('gitBranches', cwd)
  if (!result || result.error || !Array.isArray(result.branches)) {
    alert((result && result.error) || 'Could not load branches.')
    return
  }
  const localBranches = result.branches.filter(function (branch) { return !branch.isRemote })
  const items = localBranches.map(function (branch) {
    return {
      label: (branch.isCurrent ? '✓ ' : '') + branch.displayName,
      click: branch.isCurrent
        ? function () {}
        : async function () {
          const err = await ipc.invoke('gitCheckout', cwd, branch.name)
          if (err) alert(err)
          await refresh()
        }
    }
  })
  const remoteMenu = require('remoteMenuRenderer.js')
  remoteMenu.open([items], event ? event.clientX : 0, event ? event.clientY : 0)
}

function buildBranchesSection () {
  const sectionKey = 'branches'
  const section = document.createElement('div')
  section.className = 'git-section git-repo-section'
  section.dataset.section = sectionKey

  const header = document.createElement('div')
  header.className = 'git-section-header'
  header.addEventListener('click', function () {
    if (collapsedSections.has(sectionKey)) collapsedSections.delete(sectionKey)
    else collapsedSections.add(sectionKey)
    section.classList.toggle('collapsed', collapsedSections.has(sectionKey))
    persistStateSoon()
  })
  const chevron = document.createElement('span')
  chevron.className = 'codicon codicon-chevron-down git-section-chevron'
  if (collapsedSections.has(sectionKey)) section.classList.add('collapsed')
  header.appendChild(chevron)
  const titleEl = document.createElement('span')
  titleEl.className = 'git-section-title'
  titleEl.textContent = l('gitRepositories') || 'Repositories'
  header.appendChild(titleEl)
  section.appendChild(header)

  const body = document.createElement('div')
  body.className = 'git-section-body git-repository-list'

  const row = document.createElement('div')
  row.className = 'git-repository-row'
  const repoIcon = document.createElement('span')
  repoIcon.className = 'codicon codicon-repo'
  row.appendChild(repoIcon)

  const repositoryName = document.createElement('span')
  repositoryName.className = 'git-repository-name'
  const root = currentGitRoot || currentWorkspacePath || ''
  repositoryName.textContent = root.split(/[\\/]/).filter(Boolean).pop() || root
  repositoryName.title = root
  row.appendChild(repositoryName)

  const branchIcon = document.createElement('span')
  branchIcon.className = 'codicon codicon-git-branch git-repository-branch-icon'
  row.appendChild(branchIcon)
  const branchName = document.createElement('button')
  branchName.type = 'button'
  branchName.className = 'git-repository-branch'
  branchName.textContent = (currentStatus && currentStatus.branch) || l('gitNoBranch') || 'no branch'
  branchName.title = l('gitCheckout') || 'Switch Branch'
  branchName.addEventListener('click', showBranchSwitcher)
  row.appendChild(branchName)

  if (currentStatus && (currentStatus.ahead || currentStatus.behind)) {
    const syncInfo = document.createElement('span')
    syncInfo.className = 'git-sync-info'
    const parts = []
    if (currentStatus.behind) parts.push('↓' + currentStatus.behind)
    if (currentStatus.ahead) parts.push('↑' + currentStatus.ahead)
    syncInfo.textContent = parts.join(' ')
    row.appendChild(syncInfo)
  }

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'codicon codicon-ellipsis git-icon-button git-repository-more'
  more.title = l('gitMoreActions') || 'More Actions'
  more.addEventListener('click', showMoreActions)
  row.appendChild(more)
  body.appendChild(row)
  section.appendChild(body)
  return section
}

async function refresh () {
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId()
  if (wsPath !== currentWorkspacePath || wsId !== currentWorkspaceId) {
    syncWorkspacePath()
    return
  }
  if (!wsPath) {
    refreshGate.invalidate()
    currentGitRoot = null
    currentStatus = null
    currentGraph = null
    currentLogDetailed = null
    isLoading = false
    updateBadge(0)
    if (renderKey() !== lastRenderKey) render()
    return
  }
  const key = JSON.stringify([wsId, wsPath])
  return refreshGate.run(key, async function (isGateCurrent) {
    const isCurrentRequest = function () {
      return isGateCurrent() &&
        getWorkspacePath() === wsPath &&
        getWorkspaceId() === wsId &&
        currentWorkspacePath === wsPath &&
        currentWorkspaceId === wsId
    }
    isLoading = true
    const loadingEl = panel.querySelector('.git-loading')
    if (loadingEl) loadingEl.hidden = false
    try {
      const status = await ipc.invoke('gitStatus', wsPath)
      if (!isCurrentRequest()) return
      if (status && status.isRepo) {
        const gitRoot = status.gitRoot || wsPath
        currentStatus = status
        const graph = await fetchGraph(gitRoot)
        if (!isCurrentRequest()) return
        currentGitRoot = gitRoot
        currentGraph = graph.graph
        currentLogDetailed = graph.commits
      } else if (status && status.isRepo === false) {
        currentGitRoot = null
        currentStatus = { isRepo: false }
        currentGraph = null
        currentLogDetailed = null
      } else {
        currentGitRoot = null
        currentStatus = status
        currentGraph = null
        currentLogDetailed = null
      }
    } catch (e) {
      if (!isCurrentRequest()) return
      currentGitRoot = null
      currentGraph = null
      currentLogDetailed = null
      currentStatus = { error: e.message }
    } finally {
      if (isCurrentRequest()) {
        isLoading = false
      }
    }
    if (isCurrentRequest() && renderKey() !== lastRenderKey) render()
  })
}

function render () {
  renderToken++
  lastRenderKey = renderKey()
  empty(panel)

  const wsPath = getWorkspacePath()

  if (!wsPath) {
    panel.appendChild(buildEmptyState(l('noWorkspaceFolder') || 'No workspace folder', null, null))
    updateBadge(0)
    return
  }

  if (!currentStatus) {
    const loading = document.createElement('div')
    loading.className = 'git-loading'
    loading.textContent = l('gitLoading') || 'Loading…'
    panel.appendChild(loading)
    // trigger fetch
    refresh()
    return
  }

  if (currentStatus.error && !currentStatus.isRepo) {
    const err = document.createElement('div')
    err.className = 'git-error'
    err.textContent = currentStatus.error
    panel.appendChild(err)
    return
  }

  if (currentStatus.isRepo === false) {
    const wrap = document.createElement('div')
    wrap.className = 'git-not-repo'
    const msg = document.createElement('div')
    msg.className = 'git-empty-message'
    msg.textContent = l('gitNotRepo') || 'The workspace folder is not a git repository.'
    wrap.appendChild(msg)
    const initBtn = document.createElement('button')
    initBtn.className = 'git-action-button primary'
    initBtn.textContent = l('gitInitRepo') || 'Initialize Repository'
    initBtn.addEventListener('click', async function () {
      initBtn.disabled = true
      const err = await ipc.invoke('gitInit', wsPath)
      if (err) alert(err)
      await refresh()
      initBtn.disabled = false
    })
    wrap.appendChild(initBtn)
    panel.appendChild(wrap)
    updateBadge(0)
    return
  }

  if (currentStatus.error) {
    const err = document.createElement('div')
    err.className = 'git-error'
    err.textContent = currentStatus.error
    panel.appendChild(err)
    const retryBtn = document.createElement('button')
    retryBtn.className = 'git-action-button'
    retryBtn.textContent = l('gitRefresh') || 'Refresh'
    retryBtn.addEventListener('click', refresh)
    panel.appendChild(retryBtn)
    return
  }

  // VSCode-like title (actions live in the More menu)
  panel.appendChild(buildTitleBar())
  panel.appendChild(buildBranchesSection())

  // VS Code keeps the commit input and resource groups together as the
  // repository view. Branches and Graph are separate views below it.
  const repositoryView = document.createElement('div')
  repositoryView.className = 'git-repository-view git-changes-view'

  const totalChanges = (currentStatus.staged?.length || 0) + (currentStatus.unstaged?.length || 0) + (currentStatus.untracked?.length || 0) + (currentStatus.conflicted?.length || 0)
  const viewHeader = document.createElement('div')
  viewHeader.className = 'git-section-header git-view-header'
  const changesViewCollapsed = collapsedSections.has('changesView')
  repositoryView.classList.toggle('collapsed', changesViewCollapsed)
  viewHeader.setAttribute('aria-expanded', String(!changesViewCollapsed))
  viewHeader.addEventListener('click', function () {
    const collapsed = repositoryView.classList.toggle('collapsed')
    if (collapsed) collapsedSections.add('changesView')
    else collapsedSections.delete('changesView')
    viewHeader.setAttribute('aria-expanded', String(!collapsed))
    persistStateSoon()
  })
  const viewChevron = document.createElement('span')
  viewChevron.className = 'codicon codicon-chevron-down git-section-chevron'
  viewHeader.appendChild(viewChevron)
  const viewTitle = document.createElement('span')
  viewTitle.className = 'git-section-title'
  viewTitle.textContent = l('gitChanges') || 'Changes'
  viewHeader.appendChild(viewTitle)
  if (totalChanges > 0) {
    const count = document.createElement('span')
    count.className = 'git-view-count'
    count.textContent = String(totalChanges)
    viewHeader.appendChild(count)
  }
  repositoryView.appendChild(viewHeader)

  const commitBox = buildCommitBox()
  repositoryView.appendChild(commitBox)

  // the changes area (file sections) fills the remaining panel height and
  // scrolls on its own; Branches/Graph stay pinned at the bottom
  const changesBody = document.createElement('div')
  changesBody.className = 'git-changes-body'

  if (totalChanges === 0) {
    const clean = document.createElement('div')
    clean.className = 'git-clean-message'
    clean.textContent = l('gitNoChanges') || 'No changes'
    changesBody.appendChild(clean)
    updateBadge(0)
  } else {
    updateBadge(totalChanges)

    // sections
    if (currentStatus.conflicted && currentStatus.conflicted.length > 0) {
      changesBody.appendChild(buildSection(l('gitConflicts') || 'Merge Conflicts', currentStatus.conflicted, 'conflicted', [], null))
    }

    if (currentStatus.staged && currentStatus.staged.length > 0) {
      changesBody.appendChild(buildSection(l('gitStaged') || 'Staged Changes', currentStatus.staged, 'staged', [
        {
          icon: 'codicon-remove',
          title: l('gitUnstageAll') || 'Unstage All',
          onClick: async function () {
            const cwd = currentGitRoot || wsPath
            const err = await ipc.invoke('gitUnstageAll', cwd)
            if (err) alert(err)
            await refresh()
          }
        },
        { icon: 'codicon-check', title: l('gitCommit') || 'Commit', onClick: doCommit }
      ], null))
    }

    if (currentStatus.unstaged && currentStatus.unstaged.length > 0) {
      changesBody.appendChild(buildSection(l('gitChanges') || 'Changes', currentStatus.unstaged, 'unstaged', [
        {
          icon: 'codicon-add',
          title: l('gitStageAll') || 'Stage All',
          onClick: async function () {
            const cwd = currentGitRoot || wsPath
            const err = await ipc.invoke('gitStageAll', cwd)
            if (err) alert(err)
            await refresh()
          }
        },
        {
          icon: 'codicon-discard',
          title: l('gitDiscardAll') || 'Discard All',
          onClick: async function () {
            if (!confirm(l('gitDiscardAllConfirm') || 'Discard all changes?')) return
            const cwd = currentGitRoot || wsPath
            const err = await ipc.invoke('gitDiscardAll', cwd)
            if (err) alert(err)
            await refresh()
          }
        }
      ], null))
    }

    if (currentStatus.untracked && currentStatus.untracked.length > 0) {
      changesBody.appendChild(buildSection(l('gitUntracked') || 'Untracked', currentStatus.untracked, 'untracked', [
        {
          icon: 'codicon-add',
          title: l('gitStageAll') || 'Stage All',
          onClick: async function () {
            const cwd = currentGitRoot || wsPath
            const err = await ipc.invoke('gitStage', cwd, currentStatus.untracked.map(function (f) { return f.path }))
            if (err) alert(err)
            await refresh()
          }
        }
      ], null))
    }
  }

  repositoryView.appendChild(changesBody)
  panel.appendChild(repositoryView)

  // Changes and Graph are sibling views separated by a draggable split bar.
  if (currentStatus && currentStatus.isRepo && !currentStatus.error) {
    const graphView = graphViewModule.buildGraphSection()
    graphView.classList.add('git-split-view')
    const splitter = graphViewModule.buildViewSplitter(graphView)
    panel.appendChild(splitter)
    panel.appendChild(graphView)
  }

  // update commit box state after rendering
  commitBox._updateState()

  // show unstaged+untracked count as changes if no staged?
  // badge already set
}

function updateBadge (count) {
  const tab = document.getElementById('sidebar-tab-git')
  if (!tab) return
  let badge = tab.querySelector('.activity-bar-badge')
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'activity-bar-badge'
      tab.appendChild(badge)
    }
    badge.textContent = count > 99 ? '99+' : String(count)
    badge.hidden = false
  } else {
    if (badge) badge.hidden = true
  }
}

const gitPanel = {
  initialize: function () {
    // initial workspace path
    currentWorkspacePath = getWorkspacePath() || null
    currentWorkspaceId = getWorkspaceId()
    loadSavedState().then(function () {
      render()
    })
    // re-render on workspace change (both event names are retained for
    // compatibility; onWorkspaceSelected de-duplicates their pair)
    workspaces.on('workspace-selected', onWorkspaceSelected)
    workspaces.on('workspace-destroyed', onWorkspaceDestroyed)
    workspaces.on('workspace-added', onWorkspaceAdded)
    // task switches within a workspace share the same repo/state; the
    // workspace-selected handler above covers re-renders
    workspaces.on('state-sync-change', function () {
      syncWorkspacePath()
    })
    workspaces.on('workspace-updated', function (workspaceId, key) {
      if (key !== 'path') return
      const selectedWorkspaceId = getWorkspaceId()
      if (selectedWorkspaceId && String(workspaceId) !== selectedWorkspaceId) return
      syncWorkspacePath()
    })
    // auto refresh when panel becomes visible
    const observer = new MutationObserver(function () {
      const isActive = panel.classList.contains('active')
      if (isActive) refresh()
    })
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] })
    // periodic poll while visible
    setInterval(function () {
      if (panel.classList.contains('active') && !isLoading) {
        refresh()
      }
    }, 5000)

    // expose for debugging
    window.gitPanel = gitPanel
  },
  refresh: refresh,
  render: render,
  getStatus: function () { return currentStatus }
}

module.exports = gitPanel
