/* global ipc, l, tasks, empty, MutationObserver, prompt, electron */
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
let commitMessage = ''

let currentBranches = null
let currentGraph = null
let currentLogDetailed = null

const collapsedSections = new Set()
let graphScrollTop = 0
let graphExpandedCommit = null // hash of the commit whose diff is shown
let renderToken = 0 // invalidates stale async renders (diff loading)

let currentWorkspaceId = null

function getWorkspacePath () {
  const ws = tasks.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = tasks.getSelected()
  return ws && ws.id
}

/* ----- per-workspace state persistence ----- */

function getStateKey () {
  return currentWorkspaceId ? 'git:' + currentWorkspaceId : null
}

/* sections collapsed by default on first run (Branches, Graph) */
const defaultCollapsedSections = ['branches', 'graph']

async function loadSavedState () {
  const key = getStateKey()
  if (!key) return
  try {
    const state = await uiStateDB.getGitPanelState(key)
    collapsedSections.clear()
    if (state && state.collapsedSections) {
      ;(state.collapsedSections || []).forEach(function (s) { collapsedSections.add(s) })
      commitMessage = state.commitMessage || ''
      graphScrollTop = state.graphScrollTop || 0
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
    graphExpandedCommit: graphExpandedCommit
  }
  await uiStateDB.setGitPanelState(key, state)
}

/* saves the panel's state without awaiting; used by fire-and-forget callers */
function persistStateSoon () {
  persistState().catch(function () {})
}

function statusLetterColor (status) {
  if (status === 'modified' || status === 'M') return 'var(--git-modified, #cca700)'
  if (status === 'added' || status === 'A') return 'var(--git-added, #73c991)'
  if (status === 'deleted' || status === 'D') return 'var(--git-deleted, #f85149)'
  if (status === 'untracked' || status === '?') return 'var(--git-untracked, #73c991)'
  if (status === 'renamed') return 'var(--git-renamed, #73c991)'
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

function buildHeader (status) {
  const header = document.createElement('div')
  header.className = 'git-header'

  const branchRow = document.createElement('div')
  branchRow.className = 'git-branch-row'

  const branchIcon = document.createElement('span')
  branchIcon.className = 'codicon codicon-source-control'
  branchRow.appendChild(branchIcon)

  const branchName = document.createElement('span')
  branchName.className = 'git-branch-name'
  branchName.textContent = status.branch || l('gitNoBranch') || 'no branch'
  branchName.title = status.branch || ''
  branchRow.appendChild(branchName)

  if (status.ahead || status.behind) {
    const syncInfo = document.createElement('span')
    syncInfo.className = 'git-sync-info'
    const parts = []
    if (status.ahead) parts.push('↑' + status.ahead)
    if (status.behind) parts.push('↓' + status.behind)
    syncInfo.textContent = parts.join(' ')
    branchRow.appendChild(syncInfo)
  }

  header.appendChild(branchRow)

  if (status.gitRoot) {
    const rootLabel = document.createElement('div')
    rootLabel.className = 'git-root-label'
    rootLabel.textContent = status.gitRoot
    rootLabel.title = status.gitRoot
    header.appendChild(rootLabel)
  }

  return header
}

function buildCommitBox () {
  const box = document.createElement('div')
  box.className = 'git-commit-box'

  const textarea = document.createElement('textarea')
  textarea.className = 'git-commit-input'
  textarea.placeholder = l('gitCommitMessage') || 'Message (Ctrl+Enter to commit)'
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
      doCommit()
    }
  })
  box.appendChild(textarea)

  const actions = document.createElement('div')
  actions.className = 'git-commit-actions'

  const commitBtn = document.createElement('button')
  commitBtn.className = 'git-commit-button'
  commitBtn.textContent = l('gitCommit') || 'Commit'
  commitBtn.addEventListener('click', doCommit)
  actions.appendChild(commitBtn)

  const commitAllBtn = document.createElement('button')
  commitAllBtn.className = 'git-commit-button secondary'
  commitAllBtn.textContent = l('gitCommitAll') || 'Commit All'
  commitAllBtn.title = l('gitCommitAllHint') || 'Stage all and commit'
  commitAllBtn.addEventListener('click', async function () {
    commitBtn.disabled = true
    commitAllBtn.disabled = true
    const cwd = currentGitRoot || currentWorkspacePath
    const err = await ipc.invoke('gitStageAll', cwd)
    if (err) {
      alert(err)
      refresh()
      return
    }
    await doCommit()
  })
  actions.appendChild(commitAllBtn)

  box.appendChild(actions)

  // expose for update
  box._textarea = textarea
  box._commitBtn = commitBtn
  box._commitAllBtn = commitAllBtn

  function updateCommitButtonState () {
    const hasMessage = commitMessage.trim().length > 0
    const hasStaged = currentStatus && currentStatus.staged && currentStatus.staged.length > 0
    // VSCode enables commit only when there is staged changes and message, but also offers Commit All
    commitBtn.disabled = !hasMessage || !hasStaged
    commitAllBtn.disabled = !hasMessage
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
  label.textContent = entry.path
  label.title = entry.path + ' (' + entry.status + ')'
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

  // click to open file in editor
  row.addEventListener('click', function () {
    const editorView = require('editorView.js')
    if (entry.fullPath) {
      editorView.openFile(entry.fullPath)
    }
  })

  // context menu: stage/unstage/discard/open
  row.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    const remoteMenu = require('remoteMenuRenderer.js')
    const menu = []
    if (sectionKey === 'staged') {
      menu.push([{ label: l('gitUnstage') || 'Unstage', click: function () { unstageFiles([entry.path]) } }])
    } else {
      menu.push([{ label: l('gitStage') || 'Stage', click: function () { stageFiles([entry.path]) } }])
    }
    menu.push([{ label: l('gitDiscard') || 'Discard', click: function () { discardFiles([entry.path]) } }])
    menu.push([{
      label: l('gitOpenFile') || 'Open File',
      click: function () {
        const editorView = require('editorView.js')
        editorView.openFile(entry.fullPath)
      }
    }])
    remoteMenu.open(menu, e.clientX, e.clientY)
  })

  return row
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

async function fetchBranches () {
  if (!currentGitRoot) {
    currentBranches = null
    return
  }
  try {
    const result = await ipc.invoke('gitBranches', currentGitRoot)
    if (result && !result.error && result.branches) {
      currentBranches = result
    } else {
      currentBranches = null
    }
  } catch (e) {
    currentBranches = null
  }
}

async function fetchGraph () {
  if (!currentGitRoot) {
    currentGraph = null
    currentLogDetailed = null
    return
  }
  try {
    const [graphResult, logResult] = await Promise.all([
      ipc.invoke('gitGraph', currentGitRoot, 30),
      ipc.invoke('gitLogDetailed', currentGitRoot, 30)
    ])
    if (graphResult && !graphResult.error) {
      currentGraph = graphResult.graph || graphResult
    } else {
      currentGraph = null
    }
    if (logResult && !logResult.error && logResult.commits) {
      currentLogDetailed = logResult.commits
    } else {
      currentLogDetailed = null
    }
  } catch (e) {
    currentGraph = null
    currentLogDetailed = null
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
  menu.push([{ label: l('gitFetch') || 'Fetch', click: async function () { const err = await ipc.invoke('gitFetch', cwd); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitPull') || 'Pull', click: async function () { const err = await ipc.invoke('gitPull', cwd); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitPush') || 'Push', click: async function () { const err = await ipc.invoke('gitPush', cwd); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitSync') || 'Sync', click: async function () { const err = await ipc.invoke('gitSync', cwd); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitStash') || 'Stash', click: async function () { const msg = prompt(l('gitStashMessage') || 'Stash message', 'WIP'); if (msg === null) return; const err = await ipc.invoke('gitStash', cwd, msg); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitStashPop') || 'Stash Pop', click: async function () { const err = await ipc.invoke('gitStashPop', cwd); if (err) alert(err); await refresh() } }])
  menu.push([{ label: l('gitCreateBranch') || 'Create Branch', click: function () { const name = prompt(l('gitBranchName') || 'Branch name'); if (name) { ipc.invoke('gitCreateBranch', cwd, name).then(function (err) { if (err) alert(err); refresh() }) } } }])
  const x = e ? e.clientX : 0
  const y = e ? e.clientY : 0
  remoteMenu.open(menu, x, y)
}

/* checks out a branch after a confirmation prompt */
function checkoutBranch (branchName) {
  if (!confirm((l('gitCheckoutConfirm') || 'Switch to branch %s?').replace('%s', branchName))) return
  const cwd = currentGitRoot || currentWorkspacePath
  ipc.invoke('gitCheckout', cwd, branchName).then(function (err) {
    if (err) alert(err)
    refresh()
  })
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
  const count = currentBranches && currentBranches.branches ? currentBranches.branches.length : 0
  titleEl.textContent = (l('gitBranches') || 'Branches') + (count ? ' (' + count + ')' : '')
  header.appendChild(titleEl)
  const headerActions = document.createElement('div')
  headerActions.className = 'git-section-header-actions'
  const createBtn = document.createElement('button')
  createBtn.className = 'codicon codicon-add git-icon-button small'
  createBtn.title = l('gitCreateBranch') || 'Create Branch'
  createBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    const name = prompt(l('gitBranchName') || 'Branch name')
    if (name) {
      const cwd = currentGitRoot || currentWorkspacePath
      ipc.invoke('gitCreateBranch', cwd, name).then(function (err) { if (err) alert(err); refresh() })
    }
  })
  headerActions.appendChild(createBtn)
  header.appendChild(headerActions)
  section.appendChild(header)

  const body = document.createElement('div')
  body.className = 'git-section-body git-branch-list'

  if (!currentBranches || !currentBranches.branches || currentBranches.branches.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'git-section-empty'
    empty.textContent = l('gitNoBranches') || 'No branches'
    body.appendChild(empty)
  } else {
    currentBranches.branches.forEach(function (branch) {
      const row = document.createElement('div')
      row.className = 'git-branch-item' + (branch.isCurrent ? ' current' : '')
      row.dataset.branch = branch.name
      const icon = document.createElement('span')
      icon.className = 'codicon codicon-git-branch'
      row.appendChild(icon)
      const label = document.createElement('span')
      label.className = 'git-branch-name'
      label.textContent = branch.displayName
      label.title = branch.name + (branch.isCurrent ? ' (current)' : '') + (branch.isRemote ? ' (remote)' : '')
      row.appendChild(label)
      if (branch.isRemote) {
        const meta = document.createElement('span')
        meta.className = 'git-branch-meta'
        meta.textContent = 'remote'
        row.appendChild(meta)
      }
      const actions = document.createElement('div')
      actions.className = 'git-branch-actions'
      if (!branch.isCurrent && !branch.isRemote) {
        const checkoutBtn = document.createElement('button')
        checkoutBtn.className = 'codicon codicon-check git-branch-action-btn'
        checkoutBtn.title = l('gitCheckout') || 'Checkout'
        checkoutBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          checkoutBranch(branch.displayName)
        })
        actions.appendChild(checkoutBtn)
      }
      if (!branch.isRemote && !branch.isCurrent) {
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'codicon codicon-trash git-branch-action-btn'
        deleteBtn.title = l('gitDeleteBranch') || 'Delete Branch'
        deleteBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          if (!confirm((l('gitDeleteBranchConfirm') || 'Delete branch %s?').replace('%s', branch.displayName))) return
          const cwd = currentGitRoot || currentWorkspacePath
          ipc.invoke('gitDeleteBranch', cwd, branch.displayName, false).then(function (err) { if (err) alert(err); refresh() })
        })
        actions.appendChild(deleteBtn)
      }
      row.appendChild(actions)
      row.addEventListener('click', function () {
        if (branch.isCurrent) return
        if (branch.isRemote) return
        checkoutBranch(branch.displayName)
      })
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        const remoteMenu = require('remoteMenuRenderer.js')
        const menu = []
        if (!branch.isCurrent && !branch.isRemote) {
          menu.push([{ label: l('gitCheckout') || 'Checkout', click: function () { checkoutBranch(branch.displayName) } }])
        }
        if (!branch.isRemote && !branch.isCurrent) {
          menu.push([{
            label: l('gitDeleteBranch') || 'Delete Branch',
            click: function () {
              if (confirm((l('gitDeleteBranchConfirm') || 'Delete branch %s?').replace('%s', branch.displayName))) {
                const cwd = currentGitRoot || currentWorkspacePath
                ipc.invoke('gitDeleteBranch', cwd, branch.displayName, false).then(function (err) { if (err) alert(err); refresh() })
              }
            }
          }])
        }
        if (menu.length) remoteMenu.open(menu, e.clientX, e.clientY)
      })
      body.appendChild(row)
    })
  }
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
  author.textContent = commit.author + ' · ' + commit.date
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

  detail.appendChild(buildDiffViewer(commit))

  return detail
}

async function buildDiffViewer (commit) {
  const wrap = document.createElement('div')
  wrap.className = 'git-graph-diff'
  const loading = document.createElement('div')
  loading.className = 'git-graph-diff-loading'
  loading.textContent = 'Loading diff…'
  wrap.appendChild(loading)

  // render the diff when it arrives; if the panel has been re-rendered
  // meanwhile, the stale nodes are discarded with the rest of the panel
  const token = renderToken
  try {
    const result = await ipc.invoke('gitCommitDiff', currentGitRoot, commit.hash)
    if (token !== renderToken) return wrap
    empty(wrap)
    if (!result || result.error || !result.diff) {
      const err = document.createElement('div')
      err.className = 'git-graph-diff-empty'
      err.textContent = result && result.error ? result.error : 'No diff'
      wrap.appendChild(err)
      return wrap
    }
    const lines = result.diff.split('\n')
    const hunks = []
    let currentHunk = null
    lines.forEach(function (line) {
      if (/^@@/.test(line)) {
        currentHunk = { header: line, lines: [] }
        hunks.push(currentHunk)
      } else if (currentHunk && (/^[+\- ]/.test(line) || /^\\/.test(line))) {
        currentHunk.lines.push(line)
      }
    })
    if (hunks.length === 0) {
      const emptyMsg = document.createElement('div')
      emptyMsg.className = 'git-graph-diff-empty'
      emptyMsg.textContent = 'No changes in this commit'
      wrap.appendChild(emptyMsg)
      return wrap
    }
    hunks.forEach(function (hunk) {
      const header = document.createElement('div')
      header.className = 'git-graph-diff-hunk'
      header.textContent = hunk.header
      wrap.appendChild(header)
      hunk.lines.forEach(function (line) {
        const row = document.createElement('div')
        row.className = 'git-graph-diff-line'
        if (line[0] === '+') row.classList.add('added')
        else if (line[0] === '-') row.classList.add('removed')
        else row.classList.add('context')
        row.textContent = line
        wrap.appendChild(row)
      })
    })
  } catch (e) {
    if (token !== renderToken) return wrap
    empty(wrap)
    const err = document.createElement('div')
    err.className = 'git-graph-diff-empty'
    err.textContent = e.message || 'Failed to load diff'
    wrap.appendChild(err)
  }
  return wrap
}

function buildGraphSection () {
  const sectionKey = 'graph'
  const section = document.createElement('div')
  section.className = 'git-section git-graph-section'
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
      dateEl.textContent = commit.date
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

      // right-click: revert / create branch / checkout / copy hash
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        const remoteMenu = require('remoteMenuRenderer.js')
        const cwd = currentGitRoot || currentWorkspacePath
        const short = commit.shortHash
        const menu = []
        menu.push([{
          label: l('gitRevertCommit') || 'Revert Commit',
          click: function () {
            if (!confirm((l('gitRevertCommitConfirm') || 'Revert commit %s?').replace('%s', short))) return
            ipc.invoke('gitRevertCommit', cwd, commit.hash).then(function (err) {
              if (err) alert(err)
              refresh()
            })
          }
        }])
        menu.push([{
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
        }])
        menu.push([{
          label: l('gitCopyHash') || 'Copy Commit Hash',
          click: function () {
            electron.clipboard.writeText(commit.hash)
          }
        }])
        remoteMenu.open(menu, e.clientX, e.clientY)
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

async function refresh () {
  if (isLoading) return
  const wsPath = getWorkspacePath()
  currentWorkspacePath = wsPath
  if (!wsPath) {
    currentGitRoot = null
    currentStatus = null
    render()
    return
  }
  isLoading = true
  const loadingEl = panel.querySelector('.git-loading')
  if (loadingEl) loadingEl.hidden = false
  try {
    const status = await ipc.invoke('gitStatus', wsPath)
    if (status && status.isRepo) {
      currentGitRoot = status.gitRoot || wsPath
      currentStatus = status
      // fetch branches and graph in parallel when repo exists
      await Promise.all([fetchBranches(), fetchGraph()])
    } else if (status && status.isRepo === false) {
      currentGitRoot = null
      currentStatus = { isRepo: false }
      currentBranches = null
      currentGraph = null
      currentLogDetailed = null
    } else {
      currentGitRoot = null
      currentStatus = status
    }
  } catch (e) {
    currentStatus = { error: e.message }
  }
  isLoading = false
  if (getWorkspacePath() === wsPath) {
    render()
  }
}

function render () {
  renderToken++
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
  // header (branch + root)
  panel.appendChild(buildHeader(currentStatus))

  // commit box
  const commitBox = buildCommitBox()
  panel.appendChild(commitBox)

  // the changes area (file sections) fills the remaining panel height and
  // scrolls on its own; Branches/Graph stay pinned at the bottom
  const changesBody = document.createElement('div')
  changesBody.className = 'git-changes-body'

  const totalChanges = (currentStatus.staged?.length || 0) + (currentStatus.unstaged?.length || 0) + (currentStatus.untracked?.length || 0) + (currentStatus.conflicted?.length || 0)
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

  panel.appendChild(changesBody)

  // repo/branches + graph at the very bottom (after all file sections)
  if (currentStatus && currentStatus.isRepo && !currentStatus.error) {
    panel.appendChild(buildBranchesSection())
    panel.appendChild(buildGraphSection())
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
    // re-render on workspace change
    tasks.on('workspace-selected', function () {
      persistStateSoon()
      currentWorkspaceId = getWorkspaceId()
      commitMessage = ''
      currentStatus = null
      loadSavedState().then(function () {
        refresh()
      })
    })
    tasks.on('task-selected', function () {
      persistStateSoon()
      currentWorkspaceId = getWorkspaceId()
      commitMessage = ''
      currentStatus = null
      loadSavedState().then(function () {
        refresh()
      })
    })
    tasks.on('state-sync-change', function () {
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
