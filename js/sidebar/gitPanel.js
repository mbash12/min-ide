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

const panel = document.getElementById('sidebar-panel-git')

let currentWorkspacePath = null
let currentGitRoot = null
let currentStatus = null
let isLoading = false
let loadingWorkspacePath = null
let refreshGeneration = 0
let commitMessage = ''

let currentGraph = null
let currentLogDetailed = null

const collapsedSections = new Set()
let graphScrollTop = 0
let graphViewHeight = 0 // splitter-dragged height; 0 = CSS default
let graphExpandedCommit = null // hash of the commit whose diff is shown
let renderToken = 0 // invalidates stale async renders (diff loading)
let lastRenderKey = null // data signature of the last render; skips no-op re-renders

/* identifies what the panel would render right now; the periodic refresh
   only rebuilds the DOM when this changes, so open diffs, scroll positions
   and the commit box aren't torn down by a no-op poll */
function renderKey () {
  return currentWorkspaceId + '|' + JSON.stringify([currentStatus, currentGraph, currentLogDetailed])
}

let currentWorkspaceId = null

function getWorkspacePath () {
  const ws = workspaces.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = workspaces.getSelected()
  return ws && ws.id != null ? String(ws.id) : null
}

/* ----- per-workspace state persistence ----- */

function getStateKey () {
  return currentWorkspaceId ? 'git:' + currentWorkspaceId : null
}

/* sections collapsed by default on first run (Branches, Graph) */
const defaultCollapsedSections = ['branches', 'graph']

async function loadSavedState (workspaceId) {
  workspaceId = workspaceId || currentWorkspaceId
  const key = workspaceId ? 'git:' + workspaceId : null
  if (!key) return
  try {
    const state = await uiStateDB.getGitPanelState(key)
    // A later selection may have happened while the state was loading. Do
    // not apply the old workspace's draft or graph state to the new one.
    if (workspaceId !== currentWorkspaceId) return
    collapsedSections.clear()
    if (state && state.collapsedSections) {
      ;(state.collapsedSections || []).forEach(function (s) { collapsedSections.add(s) })
      commitMessage = state.commitMessage || ''
      graphScrollTop = state.graphScrollTop || 0
      graphViewHeight = state.graphViewHeight || 0
      graphExpandedCommit = state.graphExpandedCommit || null
    } else {
      // first run for this workspace: Branches & Graph start collapsed
      defaultCollapsedSections.forEach(function (s) { collapsedSections.add(s) })
    }
  } catch (e) {
    // ignore: fall back to defaults
  }
}

async function persistState () {
  const key = getStateKey()
  if (!key) return
  const state = {
    collapsedSections: Array.from(collapsedSections),
    commitMessage: commitMessage,
    graphScrollTop: graphScrollTop,
    graphViewHeight: graphViewHeight,
    graphExpandedCommit: graphExpandedCommit
  }
  await uiStateDB.setGitPanelState(key, state)
}

/* saves the panel's state without awaiting; used by fire-and-forget callers */
function persistStateSoon () {
  persistState().catch(function () {})
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
  refreshGeneration++
  isLoading = false
  loadingWorkspacePath = null
  currentWorkspaceId = nextWorkspaceId
  currentWorkspacePath = null
  currentGitRoot = null
  currentStatus = null
  currentGraph = null
  currentLogDetailed = null
  commitMessage = ''
  collapsedSections.clear()
  defaultCollapsedSections.forEach(function (section) { collapsedSections.add(section) })
  graphScrollTop = 0
  graphViewHeight = 0
  graphExpandedCommit = null
  loadSavedState(nextWorkspaceId).then(function () {
    if (nextWorkspaceId === currentWorkspaceId) refresh()
  })
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

/* turns a unix-seconds timestamp into a compact relative time like
5m, 3h, 2d, 1w, 6mo or 2y */
function compactDate (timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h'
  const days = Math.floor(hours / 24)
  if (days < 7) return days + 'd'
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return weeks + 'w'
  const months = Math.floor(days / 30)
  if (months < 12) return months + 'mo'
  return Math.floor(days / 365) + 'y'
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
    const cwd = currentGitRoot || currentWorkspacePath
    generateBtn.disabled = true
    generateBtn.classList.add('codicon-loading', 'codicon-modifier-spin')
    generateBtn.classList.remove('codicon-sparkle')
    const result = await ipc.invoke('gitGenerateCommitMessage', cwd)
    generateBtn.classList.remove('codicon-loading', 'codicon-modifier-spin')
    generateBtn.classList.add('codicon-sparkle')
    if (!result || result.error) {
      alert((result && result.error) || 'Could not generate a commit message.')
    } else {
      commitMessage = result.message
      textarea.value = result.message
      textarea.focus()
      updateCommitButtonState()
      persistStateSoon()
    }
    generateBtn.disabled = !(currentStatus && currentStatus.staged && currentStatus.staged.length > 0)
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
  } else {
    commitMessage = ''
    const ta = panel.querySelector('.git-commit-input')
    if (ta) ta.value = ''
    persistStateSoon()
    await refresh()
  }
  if (commitBtn) commitBtn.disabled = false
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
      left: { type: 'ref', ref: 'HEAD', path: entry.oldPath || entry.path },
      right: { type: 'ref', ref: '', path: entry.path }
    })
    return
  }

  editorView.openDiff({
    cwd: gitRoot,
    resource: entry.fullPath,
    title: name + ' (Working Tree)',
    left: { type: 'ref', ref: 'HEAD', path: entry.path },
    right: { type: 'worktree', path: entry.path },
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
    const [graphResult, logResult] = await Promise.all([
      ipc.invoke('gitGraph', gitRoot, 30),
      ipc.invoke('gitLogDetailed', gitRoot, 30)
    ])
    return {
      graph: graphResult && !graphResult.error ? (graphResult.graph || graphResult) : null,
      commits: logResult && !logResult.error && logResult.commits ? logResult.commits : null
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

/* Graph lane colors, cycled per active lane (like VSCode's graph) */
const graphLaneColors = ['#0e639c', '#cca700', '#73c991', '#f85149', '#9b59b6', '#e67e22', '#1abc9c', '#c0392b']

/* SVG symbols used to draw the graph: commit dot, straight vertical line,
   branch corner, and the merge "T" shape */
const graphSvgNs = 'http://www.w3.org/2000/svg'

function laneSymbol (color, kind) {
  const svg = document.createElementNS(graphSvgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.classList.add('git-graph-lane-svg')
  const path = document.createElementNS(graphSvgNs, 'path')
  path.setAttribute('stroke', color)
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  if (kind === 'dot') {
    path.setAttribute('d', 'M8 8 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0')
    path.setAttribute('fill', color)
  } else if (kind === 'vline') {
    path.setAttribute('d', 'M8 0 L8 16')
  } else if (kind === 'corner') {
    // branch turns right: enter from the left, then continue down
    path.setAttribute('d', 'M2 8 L8 8 L8 16')
  } else if (kind === 'merge') {
    // merge from the right: come down, then turn left
    path.setAttribute('d', 'M8 0 L8 8 L2 8')
  } else if (kind === 'elbow') {
    // horizontal connector
    path.setAttribute('d', 'M2 8 L14 8')
  } else if (kind === 'diag-r') {
    // '\' connector: from the left column down to the right column
    path.setAttribute('d', 'M4 2 L12 14')
  } else if (kind === 'diag-l') {
    // '/' connector: from the right column down to the left column
    path.setAttribute('d', 'M12 2 L4 14')
  }
  svg.appendChild(path)
  return svg
}

/* The graph is drawn from git's --graph ASCII output, which is a sequence of
   "lane columns". Each column is 2 chars wide (a lane char + a space). A
   state machine walks the columns row by row: '|' keeps the lane open,
   '*' places the commit dot, '\' opens a new lane to the right, '/' closes a
   lane from the right, '-' draws a horizontal connector (branch/merge). Each
   lane gets a stable color that follows it down the graph. */
function buildGraphRows (graphLines) {
  const rows = []
  // laneStates[idx] = color of the lane currently passing through column idx
  let laneStates = []
  let nextColorIndex = 0

  const newLaneColor = function () {
    const color = graphLaneColors[nextColorIndex % graphLaneColors.length]
    nextColorIndex++
    return color
  }

  graphLines.forEach(function (line) {
    const laneMatch = line.match(/^([*|\\/\-\s]+)/)
    const prefix = laneMatch ? laneMatch[1] : ''
    const rest = line.slice(prefix.length).trim()

    // git writes one 2-char column per lane: position 2i holds the lane char,
    // position 2i+1 holds a connector ('\', '/' or ' ')
    const cols = []
    for (let i = 0; i < prefix.length; i += 2) {
      cols.push({ lane: prefix[i] || ' ', conn: prefix[i + 1] || ' ' })
    }

    const symbols = []
    const nextLaneStates = []
    let hasCommit = false

    cols.forEach(function (col, idx) {
      const ch = col.lane
      const conn = col.conn
      const prev = laneStates[idx] || null

      if (ch === '*') {
        hasCommit = true
        const color = prev || newLaneColor()
        symbols.push({ kind: 'dot', color: color, col: idx })
        if (conn === '\\') {
          // branch splits off to the right
          const branchColor = newLaneColor()
          symbols.push({ kind: 'diag-r', color: branchColor, col: idx })
          nextLaneStates[idx + 1] = branchColor
          nextLaneStates[idx] = color
        } else if (conn === '/') {
          // a lane merges in from the right
          const mergedColor = laneStates[idx + 1] || newLaneColor()
          symbols.push({ kind: 'diag-l', color: mergedColor, col: idx })
          nextLaneStates[idx] = color
        } else {
          // the lane continues straight down
          nextLaneStates[idx] = color
        }
      } else if (ch === '|') {
        const color = prev || newLaneColor()
        symbols.push({ kind: 'vline', color: color, col: idx })
        nextLaneStates[idx] = color
        if (conn === '\\') {
          // a new branch lane starts here
          const branchColor = newLaneColor()
          symbols.push({ kind: 'diag-r', color: branchColor, col: idx })
          nextLaneStates[idx + 1] = branchColor
        } else if (conn === '/') {
          // the lane from the right merges into this one
          const mergedColor = laneStates[idx + 1] || newLaneColor()
          symbols.push({ kind: 'diag-l', color: mergedColor, col: idx })
        }
      } else if (ch === '-') {
        // horizontal connector
        const color = prev || laneStates[idx - 1] || newLaneColor()
        symbols.push({ kind: 'elbow', color: color, col: idx })
        nextLaneStates[idx] = color
      } else if (ch === '\\') {
        // rare: backslash as the lane char itself
        const color = prev || newLaneColor()
        symbols.push({ kind: 'corner', color: color, col: idx })
        nextLaneStates[idx + 1] = color
      } else if (ch === '/') {
        const color = prev || laneStates[idx + 1] || newLaneColor()
        symbols.push({ kind: 'merge', color: color, col: idx })
        nextLaneStates[idx - 1] = color
      }
      // ' ' closes any lane at this column
    })

    laneStates = nextLaneStates
    rows.push({ symbols: symbols, rest: rest, hasCommit: hasCommit })
  })

  return rows
}

function buildGraphDetail (commit) {
  const detail = document.createElement('div')
  detail.className = 'git-graph-detail'

  const meta = document.createElement('div')
  meta.className = 'git-graph-detail-meta'
  const hash = document.createElement('span')
  hash.className = 'git-graph-detail-hash'
  hash.textContent = commit.shortHash
  meta.appendChild(hash)
  const author = document.createElement('span')
  author.className = 'git-graph-detail-author'
  author.textContent = commit.author + ' · ' + compactDate(commit.date)
  meta.appendChild(author)
  if (commit.refs) {
    const refs = document.createElement('span')
    refs.className = 'git-graph-detail-refs'
    refs.textContent = commit.refs
    meta.appendChild(refs)
  }
  detail.appendChild(meta)

  const message = document.createElement('div')
  message.className = 'git-graph-detail-message'
  message.textContent = commit.message
  detail.appendChild(message)

  const files = document.createElement('div')
  files.className = 'git-commit-files'
  detail.appendChild(files)
  loadCommitFiles(commit, files)

  return detail
}

/* the list of files a commit touched, shown in the graph's detail view;
clicking one opens it as a diff tab against the commit's parent */
async function loadCommitFiles (commit, container) {
  const loading = document.createElement('div')
  loading.className = 'git-commit-files-empty'
  loading.textContent = l('gitLoadingFiles') || 'Loading files…'
  container.appendChild(loading)

  const token = renderToken
  const cwd = currentGitRoot || currentWorkspacePath
  try {
    const result = await ipc.invoke('gitCommitFiles', cwd, commit.hash)
    // the panel may have been re-rendered while the list was loading
    if (token !== renderToken || !container.isConnected) return
    empty(container)
    if (!result || result.error || !result.files || result.files.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'git-commit-files-empty'
      emptyEl.textContent = (result && result.error) || l('gitNoFiles') || 'No files'
      container.appendChild(emptyEl)
      return
    }
    result.files.forEach(function (file) {
      container.appendChild(buildCommitFileRow(commit, file, cwd))
    })
  } catch (e) {
    if (token !== renderToken || !container.isConnected) return
    empty(container)
    const errEl = document.createElement('div')
    errEl.className = 'git-commit-files-empty'
    errEl.textContent = e.message || 'Failed to load files'
    container.appendChild(errEl)
  }
}

function buildCommitFileRow (commit, file, cwd) {
  const row = document.createElement('div')
  row.className = 'git-file-row git-commit-file-row'

  const name = file.path.split(/[\\/]/).pop()
  const icon = document.createElement('img')
  icon.className = 'file-tree-icon'
  icon.src = fileIcons.pathPrefix + fileIcons.getIcon(name)
  icon.alt = ''
  icon.draggable = false
  row.appendChild(icon)

  const label = document.createElement('span')
  label.className = 'git-file-label'
  label.title = file.oldPath ? file.oldPath + ' → ' + file.path : file.path
  const fileName = document.createElement('span')
  fileName.className = 'git-file-name'
  fileName.textContent = name
  label.appendChild(fileName)
  const dirPart = file.path.split(/[\\/]/)
  dirPart.pop()
  if (dirPart.length) {
    const parentPath = document.createElement('span')
    parentPath.className = 'git-file-path'
    parentPath.textContent = dirPart.join('/')
    label.appendChild(parentPath)
  }
  row.appendChild(label)

  const statusBadge = document.createElement('span')
  statusBadge.className = 'git-status-badge'
  statusBadge.textContent = file.status
  statusBadge.style.color = statusLetterColor(file.status)
  row.appendChild(statusBadge)

  row.addEventListener('click', function () {
    openCommitFileDiff(commit, file, cwd)
  })

  return row
}

/* a file inside a commit opens as a diff against the commit's parent; for
root commits or files added/deleted by it, the missing side renders empty */
function openCommitFileDiff (commit, file, cwd) {
  const editorView = require('editorView.js')
  const name = file.path.split(/[\\/]/).pop()
  editorView.openDiff({
    cwd: cwd,
    resource: cwd + '/' + file.path,
    title: name + ' (' + commit.shortHash + ')',
    left: { type: 'ref', ref: commit.hash + '^', path: file.oldPath || file.path },
    right: { type: 'ref', ref: commit.hash, path: file.path }
  })
}

function buildGraphSection () {
  const sectionKey = 'graph'
  const section = document.createElement('div')
  section.className = 'git-section git-graph-section'
  section.dataset.section = sectionKey
  // re-apply the splitter-dragged height; renders rebuild this element, so
  // without this the view snaps back to the CSS default on every refresh
  if (graphViewHeight > 0 && !collapsedSections.has(sectionKey)) {
    section.style.flexBasis = graphViewHeight + 'px'
  }

  const header = document.createElement('div')
  header.className = 'git-section-header'
  header.addEventListener('click', function () {
    if (collapsedSections.has(sectionKey)) collapsedSections.delete(sectionKey)
    else collapsedSections.add(sectionKey)
    const collapsed = collapsedSections.has(sectionKey)
    section.classList.toggle('collapsed', collapsed)
    // a splitter-dragged flexBasis would keep the collapsed view tall;
    // drop it so the section shrinks to just its header
    if (collapsed) {
      section.style.flexBasis = ''
    } else if (graphViewHeight > 0) {
      section.style.flexBasis = graphViewHeight + 'px'
    }
    persistStateSoon()
  })
  const chevron = document.createElement('span')
  chevron.className = 'codicon codicon-chevron-down git-section-chevron'
  if (collapsedSections.has(sectionKey)) section.classList.add('collapsed')
  header.appendChild(chevron)
  const titleEl = document.createElement('span')
  titleEl.className = 'git-section-title'
  const count = currentLogDetailed ? currentLogDetailed.length : 0
  titleEl.textContent = (l('gitGraph') || 'Graph') + (count ? ' (' + count + ')' : '')
  header.appendChild(titleEl)
  section.appendChild(header)

  const body = document.createElement('div')
  body.className = 'git-section-body git-graph'

  if (currentLogDetailed && currentLogDetailed.length > 0) {
    const container = document.createElement('div')
    container.className = 'git-graph-container'

    // build the full lane layout once, then pair commit rows with commits by
    // index (connector-only rows like "|\" are skipped)
    const rawLines = (currentGraph && typeof currentGraph === 'string')
      ? currentGraph.split('\n').filter(Boolean)
      : []
    const graphRows = buildGraphRows(rawLines).filter(function (r) { return r.hasCommit })

    currentLogDetailed.forEach(function (commit, index) {
      const row = document.createElement('div')
      row.className = 'git-graph-row'
      row.dataset.hash = commit.hash
      row.title = commit.hash + ' ' + commit.message

      const lane = document.createElement('span')
      lane.className = 'git-graph-lane'
      const parsed = graphRows[index] || { symbols: [], rest: '' }
      if (parsed.symbols.length) {
        parsed.symbols.forEach(function (sym) {
          const icon = laneSymbol(sym.color, sym.kind)
          icon.style.marginLeft = (sym.col * 14) + 'px'
          lane.appendChild(icon)
        })
      } else {
        lane.appendChild(laneSymbol(graphLaneColors[0], 'dot'))
      }
      row.appendChild(lane)

      const hashEl = document.createElement('span')
      hashEl.className = 'git-graph-hash'
      hashEl.textContent = commit.shortHash
      row.appendChild(hashEl)

      const msgEl = document.createElement('span')
      msgEl.className = 'git-graph-message'
      msgEl.textContent = commit.message
      if (commit.refs) {
        const refsEl = document.createElement('span')
        refsEl.className = 'git-graph-refs'
        refsEl.textContent = commit.refs
        msgEl.appendChild(refsEl)
      }
      row.appendChild(msgEl)

      const authorEl = document.createElement('span')
      authorEl.className = 'git-graph-author'
      authorEl.textContent = commit.author
      row.appendChild(authorEl)

      const dateEl = document.createElement('span')
      dateEl.className = 'git-graph-date'
      dateEl.textContent = compactDate(commit.date)
      row.appendChild(dateEl)

      // clicking a commit toggles its detail + diff view
      row.addEventListener('click', function () {
        graphExpandedCommit = (graphExpandedCommit === commit.hash) ? null : commit.hash
        persistStateSoon()
        const detailEl = row.nextElementSibling
        if (detailEl && detailEl.classList.contains('git-graph-detail')) {
          detailEl.remove()
        }
        if (graphExpandedCommit === commit.hash) {
          row.classList.add('expanded')
          row.after(buildGraphDetail(commit))
        } else {
          row.classList.remove('expanded')
        }
      })

      // right-click: undo (HEAD only) / create branch / checkout / copy hash
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        const remoteMenu = require('remoteMenuRenderer.js')
        const cwd = currentGitRoot || currentWorkspacePath
        const short = commit.shortHash
        const menu = []
        // undo only makes sense for the tip commit: it deletes HEAD and
        // moves the commit's changes back to the index
        if (commit.refs && commit.refs.indexOf('HEAD') !== -1) {
          menu.push({
            label: l('gitUndoCommit') || 'Undo Commit',
            click: function () {
              if (!confirm((l('gitUndoCommitConfirm') || 'Undo commit %s? Its changes will move back to Staged Changes.').replace('%s', short))) return
              ipc.invoke('gitUndoCommit', cwd).then(function (err) {
                if (err) alert(err)
                refresh()
              })
            }
          })
        }
        menu.push({
          label: l('gitCreateBranchAt') || 'Create Branch from Commit…',
          click: function () {
            const name = prompt(l('gitBranchName') || 'Branch name')
            if (!name) return
            ipc.invoke('gitCreateBranchAt', cwd, name, commit.hash).then(function (err) {
              if (err) alert(err)
              refresh()
            })
          }
        },
        {
          label: l('gitCheckoutCommit') || 'Checkout Commit',
          click: function () {
            if (!confirm((l('gitCheckoutCommitConfirm') || 'Checkout commit %s?').replace('%s', short))) return
            ipc.invoke('gitCheckoutCommit', cwd, commit.hash).then(function (err) {
              if (err) alert(err)
              refresh()
            })
          }
        })
        menu.push({
          label: l('gitCopyHash') || 'Copy Commit Hash',
          click: function () {
            electron.clipboard.writeText(commit.hash)
          }
        })
        remoteMenu.open([menu], e.clientX, e.clientY)
      })

      container.appendChild(row)

      if (graphExpandedCommit === commit.hash) {
        row.classList.add('expanded')
        row.after(buildGraphDetail(commit))
      }
    })

    body.appendChild(container)
  } else if (currentGraph && typeof currentGraph === 'string' && currentGraph.trim()) {
    const container = document.createElement('div')
    container.className = 'git-graph-container'
    const graphRows = buildGraphRows(currentGraph.split('\n').filter(Boolean))
    graphRows.forEach(function (parsed) {
      const row = document.createElement('div')
      row.className = 'git-graph-row'
      const lane = document.createElement('span')
      lane.className = 'git-graph-lane'
      parsed.symbols.forEach(function (sym) {
        const icon = laneSymbol(sym.color, sym.kind)
        icon.style.marginLeft = (sym.col * 14) + 'px'
        lane.appendChild(icon)
      })
      row.appendChild(lane)
      const msg = document.createElement('span')
      msg.className = 'git-graph-message'
      msg.textContent = parsed.rest
      row.appendChild(msg)
      container.appendChild(row)
    })
    body.appendChild(container)
  } else {
    const empty = document.createElement('div')
    empty.className = 'git-graph-empty'
    empty.textContent = l('gitNoCommits') || 'No commits'
    body.appendChild(empty)
  }
  section.appendChild(body)

  // restore the saved scroll position once the graph is in the DOM
  requestAnimationFrame(function () {
    const container = section.querySelector('.git-graph-container')
    if (!container) return
    if (graphScrollTop > 0) container.scrollTop = graphScrollTop
    // remember the scroll position while the user browses the graph
    container.addEventListener('scroll', function () {
      graphScrollTop = container.scrollTop
      persistStateSoon()
    }, { passive: true })
  })
  return section
}

function buildViewSplitter (graphView) {
  const splitter = document.createElement('div')
  splitter.className = 'git-view-splitter'
  splitter.setAttribute('role', 'separator')
  splitter.setAttribute('aria-orientation', 'horizontal')
  splitter.tabIndex = 0

  splitter.addEventListener('mousedown', function (event) {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = graphView.getBoundingClientRect().height
    document.body.classList.add('is-resizing-git-views')

    function resize (moveEvent) {
      const panelHeight = panel.getBoundingClientRect().height
      const maxHeight = Math.max(96, panelHeight - 180)
      const nextHeight = Math.max(72, Math.min(maxHeight, startHeight + startY - moveEvent.clientY))
      graphView.style.flexBasis = Math.round(nextHeight) + 'px'
    }

    function stop () {
      document.removeEventListener('mousemove', resize)
      document.removeEventListener('mouseup', stop)
      document.body.classList.remove('is-resizing-git-views')
      // remember the dragged height; render() rebuilds the graph element
      // and would otherwise lose it on the next refresh
      graphViewHeight = Math.round(graphView.getBoundingClientRect().height)
      persistStateSoon()
    }

    document.addEventListener('mousemove', resize)
    document.addEventListener('mouseup', stop)
  })
  return splitter
}

async function refresh () {
  const wsPath = getWorkspacePath()
  if (isLoading && loadingWorkspacePath === wsPath) return
  const generation = ++refreshGeneration
  currentWorkspacePath = wsPath
  if (!wsPath) {
    currentGitRoot = null
    currentStatus = null
    if (renderKey() !== lastRenderKey) render()
    return
  }
  isLoading = true
  loadingWorkspacePath = wsPath
  const loadingEl = panel.querySelector('.git-loading')
  if (loadingEl) loadingEl.hidden = false
  try {
    const status = await ipc.invoke('gitStatus', wsPath)
    if (generation !== refreshGeneration || getWorkspacePath() !== wsPath) return
    if (status && status.isRepo) {
      const gitRoot = status.gitRoot || wsPath
      currentStatus = status
      // fetch branches and graph in parallel when repo exists
      const graph = await fetchGraph(gitRoot)
      if (generation !== refreshGeneration || getWorkspacePath() !== wsPath) return
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
    }
  } catch (e) {
    if (generation !== refreshGeneration || getWorkspacePath() !== wsPath) return
    currentStatus = { error: e.message }
  } finally {
    if (generation === refreshGeneration) {
      isLoading = false
      loadingWorkspacePath = null
    }
  }
  if (generation === refreshGeneration && getWorkspacePath() === wsPath) {
    if (renderKey() !== lastRenderKey) render()
  }
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
    const graphView = buildGraphSection()
    graphView.classList.add('git-split-view')
    const splitter = buildViewSplitter(graphView)
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
    currentWorkspacePath = getWorkspacePath()
    currentWorkspaceId = getWorkspaceId()
    loadSavedState().then(function () {
      render()
    })
    // re-render on workspace change (both event names are retained for
    // compatibility; onWorkspaceSelected de-duplicates their pair)
    workspaces.on('workspace-selected', onWorkspaceSelected)
    // task switches within a workspace share the same repo/state; the
    // workspace-selected handler above covers re-renders
    workspaces.on('state-sync-change', function () {
      const wsPath = getWorkspacePath()
      if (wsPath !== currentWorkspacePath) {
        currentStatus = null
        refresh()
      }
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
