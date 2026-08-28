/* global ipc, l, tasks, empty, MutationObserver */
/* Playbook sidebar: lists this workspace's automations. With a folder they
live in .min/playbooks; without one they are stored in Min per workspace. */

const editorView = require('editorView.js')
const promptModal = require('promptModal.js')

const panel = document.getElementById('sidebar-panel-playbook')

let currentWorkspacePath = null
let currentWorkspaceId = null
let playbooks = []
let isLoading = false
let runningName = null
let runProgress = null
let expandedName = null
let lastError = null
let detailCache = {}
let detailPending = {}
let refreshSeq = 0
let panelWasActive = false

function getWorkspacePath () {
  const ws = tasks.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = tasks.getSelected()
  return ws && ws.id
}

function t (key, fallback) {
  const value = l(key)
  return typeof value === 'string' && value ? value : fallback
}

function buildHeader () {
  const header = document.createElement('div')
  header.className = 'file-tree-header'

  const title = document.createElement('div')
  title.className = 'file-tree-title'
  title.textContent = t('sidebarPlaybook', 'Playbook')
  header.appendChild(title)

  const actions = document.createElement('div')
  actions.className = 'file-tree-header-actions'

  const addButton = document.createElement('button')
  addButton.className = 'codicon codicon-add git-icon-button'
  addButton.title = t('playbookNew', 'New playbook')
  addButton.addEventListener('click', function (e) {
    e.stopPropagation()
    createPlaybook()
  })
  actions.appendChild(addButton)

  const refreshButton = document.createElement('button')
  refreshButton.className = 'codicon codicon-refresh git-icon-button'
  refreshButton.title = t('playbookRefresh', 'Refresh')
  refreshButton.addEventListener('click', function () { refresh() })
  actions.appendChild(refreshButton)

  header.appendChild(actions)
  return header
}

function buildEmptyState () {
  const wrap = document.createElement('div')
  wrap.className = 'git-empty-state'
  const p = document.createElement('div')
  p.className = 'git-empty-message'
  p.textContent = t('playbookEmpty', 'No playbooks yet. Ask the Agent to automate a repeated browser task, or create one here.')
  wrap.appendChild(p)
  const btn = document.createElement('button')
  btn.className = 'git-action-button primary'
  btn.textContent = t('playbookNew', 'New playbook')
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    createPlaybook()
  })
  wrap.appendChild(btn)
  return wrap
}

function listFingerprint (list) {
  return (list || []).map(function (entry) {
    return [entry.name, entry.steps, entry.description || '', entry.error || '', entry.updatedAt || ''].join('\t')
  }).join('\n')
}

function pruneDetailCache (list) {
  const keep = {}
  ;(list || []).forEach(function (entry) { keep[entry.name] = true })
  Object.keys(detailCache).forEach(function (name) {
    if (!keep[name]) delete detailCache[name]
  })
  Object.keys(detailPending).forEach(function (name) {
    if (!keep[name]) delete detailPending[name]
  })
}

function seedDetailCache (list) {
  ;(list || []).forEach(function (entry) {
    if (!entry || entry.error || !Array.isArray(entry.stepItems)) return
    detailCache[entry.name] = { steps: entry.stepItems }
  })
}

function findDetailEl (name) {
  const rows = panel.querySelectorAll('.playbook-row')
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].dataset.name === name) return rows[i].querySelector('.playbook-detail')
  }
  return null
}

function stepsFor (entry) {
  if (entry && Array.isArray(entry.stepItems)) return entry.stepItems
  const cached = detailCache[entry.name]
  if (cached && cached.steps) return cached.steps
  return null
}

function renderSteps (detail, entry) {
  empty(detail)
  const cached = detailCache[entry.name]
  if (cached && cached.error) {
    detail.textContent = cached.error
    return
  }
  const steps = stepsFor(entry)
  if (!steps) {
    detail.textContent = t('playbookLoadingDetail', 'Loading…')
    return
  }
  steps.forEach(function (step, i) {
    const line = document.createElement('div')
    line.className = 'playbook-step'
    if (runningName === entry.name && runProgress && runProgress.index === i) {
      line.classList.add('active')
    }
    line.textContent = (i + 1) + '. ' + stepSummary(step)
    detail.appendChild(line)
  })
}

function loadDetail (entry) {
  if (stepsFor(entry) || (detailCache[entry.name] && detailCache[entry.name].error)) return
  const name = entry.name
  if (detailPending[name]) return
  detailPending[name] = true
  ipc.invoke('playbookGet', currentWorkspacePath, name, currentWorkspaceId).then(function (result) {
    delete detailPending[name]
    if (!result || !result.ok) {
      detailCache[name] = { error: (result && result.error) || t('playbookLoadError', 'Could not load playbook'), steps: [] }
    } else {
      detailCache[name] = { steps: (result.playbook && result.playbook.steps) || [] }
    }
    const detail = findDetailEl(name)
    if (detail) renderSteps(detail, entry)
  }).catch(function () {
    delete detailPending[name]
    detailCache[name] = { error: t('playbookLoadError', 'Could not load playbook'), steps: [] }
    const detail = findDetailEl(name)
    if (detail) renderSteps(detail, entry)
  })
}

function stepSummary (step) {
  if (!step || typeof step !== 'object') return ''
  const action = step.action || 'step'
  const detail = step.url || step.selector || step.text || step.ref || step.path || step.key || step.value || step.operation || ''
  return detail ? action + ' · ' + String(detail).slice(0, 80) : action
}

function buildRow (entry) {
  const row = document.createElement('div')
  row.className = 'playbook-row' + (runningName === entry.name ? ' running' : '') + (entry.error ? ' error' : '')
  row.dataset.name = entry.name

  const top = document.createElement('div')
  top.className = 'playbook-row-main'

  const icon = document.createElement('i')
  icon.className = 'codicon ' + (runningName === entry.name ? 'codicon-loading codicon-modifier-spin' : 'codicon-checklist')
  top.appendChild(icon)

  const body = document.createElement('div')
  body.className = 'playbook-row-body'
  const name = document.createElement('div')
  name.className = 'playbook-name'
  name.textContent = entry.name
  body.appendChild(name)
  const meta = document.createElement('div')
  meta.className = 'playbook-meta'
  if (entry.error) {
    meta.textContent = entry.error
  } else {
    const bits = []
    if (entry.description) bits.push(entry.description)
    bits.push((entry.steps || 0) + ' ' + t('playbookSteps', 'steps'))
    meta.textContent = bits.join(' · ')
  }
  body.appendChild(meta)
  if (runningName === entry.name && runProgress) {
    const progress = document.createElement('div')
    progress.className = 'playbook-progress'
    progress.textContent = (runProgress.index + 1) + '/' + runProgress.total + ' ' + stepSummary(runProgress.step)
    body.appendChild(progress)
  }
  top.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'playbook-row-actions'

  if (!entry.error) {
    const runBtn = document.createElement('button')
    runBtn.className = 'codicon codicon-play git-icon-button'
    runBtn.title = t('playbookRun', 'Run')
    runBtn.disabled = !!runningName
    runBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      runPlaybook(entry.name)
    })
    actions.appendChild(runBtn)
  }

  const editBtn = document.createElement('button')
  editBtn.className = 'codicon codicon-edit git-icon-button'
  editBtn.title = t('playbookEdit', 'Edit')
  editBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (entry.path) editorView.openFile(entry.path)
  })
  actions.appendChild(editBtn)

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'codicon codicon-trash git-icon-button'
  deleteBtn.title = t('playbookDelete', 'Delete')
  deleteBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    deletePlaybook(entry.name)
  })
  actions.appendChild(deleteBtn)

  top.appendChild(actions)
  row.appendChild(top)

  if (expandedName === entry.name) {
    const detail = document.createElement('div')
    detail.className = 'playbook-detail'
    row.appendChild(detail)
    renderSteps(detail, entry)
    loadDetail(entry)
  }

  row.addEventListener('click', function () {
    expandedName = expandedName === entry.name ? null : entry.name
    render()
  })

  return row
}

function render () {
  empty(panel)
  panel.appendChild(buildHeader())

  const body = document.createElement('div')
  body.className = 'playbook-body'

  if (!currentWorkspaceId) {
    const msg = document.createElement('div')
    msg.className = 'git-empty-message'
    msg.textContent = t('playbookNoWorkspace', 'No workspace selected.')
    body.appendChild(msg)
  } else if (isLoading && playbooks.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'git-loading'
    msg.textContent = t('playbookLoading', 'Loading…')
    body.appendChild(msg)
  } else if (playbooks.length === 0) {
    body.appendChild(buildEmptyState())
  } else {
    playbooks.forEach(function (entry) {
      body.appendChild(buildRow(entry))
    })
  }

  if (lastError) {
    const err = document.createElement('div')
    err.className = 'git-error'
    err.textContent = lastError
    body.appendChild(err)
  }

  panel.appendChild(body)
}

async function refresh (options) {
  options = options || {}
  const silent = !!options.silent
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId() || null
  currentWorkspacePath = wsPath
  currentWorkspaceId = wsId
  if (!wsId) {
    playbooks = []
    detailCache = {}
    detailPending = {}
    render()
    updateBadge()
    return
  }
  const seq = ++refreshSeq
  if (!silent && playbooks.length === 0) {
    isLoading = true
    render()
  }
  try {
    const result = await ipc.invoke('playbookList', wsPath, wsId)
    if (seq !== refreshSeq) return
    if (currentWorkspaceId !== wsId) return
    const next = (result && result.ok) ? (result.playbooks || []) : playbooks
    if (result && result.ok) {
      lastError = null
    } else {
      lastError = (result && result.error) || t('playbookLoadError', 'Could not load playbooks')
    }
    const changed = listFingerprint(next) !== listFingerprint(playbooks)
    playbooks = next
    pruneDetailCache(playbooks)
    seedDetailCache(playbooks)
    isLoading = false
    if (!silent || changed) render()
  } catch (err) {
    if (seq !== refreshSeq) return
    lastError = (err && err.message) || String(err)
    isLoading = false
    if (!silent) render()
  }
  updateBadge()
}

function updateBadge () {
  const tab = document.getElementById('sidebar-tab-playbook')
  if (!tab) return
  let badge = tab.querySelector('.activity-bar-badge')
  const count = playbooks.length
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'activity-bar-badge'
      tab.appendChild(badge)
    }
    badge.textContent = count > 99 ? '99+' : String(count)
    badge.hidden = false
  } else if (badge) {
    badge.hidden = true
  }
}

async function createPlaybook () {
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId()
  if (!wsId) return
  const name = await promptModal.prompt({
    title: t('playbookNew', 'New playbook'),
    label: l('workspaceNameLabel') || t('playbookNewName', 'Name'),
    ok: l('dialogConfirmButton') || 'Confirm',
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!name) return
  const stub = {
    name: name,
    description: '',
    steps: [
      { action: 'navigate', url: 'https://example.com' },
      { action: 'wait', ms: 500 }
    ]
  }
  const result = await ipc.invoke('playbookSave', wsPath, stub, wsId)
  if (!result || !result.ok) {
    lastError = (result && result.error) || t('playbookSaveError', 'Could not save playbook')
    render()
    return
  }
  if (result.playbook && result.playbook.name) delete detailCache[result.playbook.name]
  await refresh()
  if (result.path) editorView.openFile(result.path)
}

async function runPlaybook (name) {
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId()
  if (!wsId || runningName) return
  runningName = name
  lastError = null
  render()
  try {
    const result = await ipc.invoke('playbookRun', wsPath, name, {}, wsId)
    if (!result || !result.ok) {
      lastError = (result && result.error) || t('playbookRunError', 'Playbook failed')
    }
  } catch (err) {
    lastError = (err && err.message) || String(err)
  }
  runningName = null
  runProgress = null
  render()
}

async function deletePlaybook (name) {
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId()
  if (!wsId) return
  const ok = await promptModal.confirm({
    title: t('playbookDelete', 'Delete'),
    message: t('playbookDeleteConfirm', 'Delete playbook "%s"?').replace('%s', name),
    ok: l('dialogConfirmButton') || 'Confirm',
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!ok) return
  const result = await ipc.invoke('playbookDelete', wsPath, name, wsId)
  if (!result || !result.ok) {
    lastError = (result && result.error) || t('playbookDeleteError', 'Could not delete playbook')
  }
  if (expandedName === name) expandedName = null
  delete detailCache[name]
  await refresh()
}

const playbookPanel = {
  initialize: function () {
    currentWorkspacePath = getWorkspacePath() || null
    currentWorkspaceId = getWorkspaceId() || null
    if (currentWorkspaceId) isLoading = true
    render()
    refresh()

    tasks.on('workspace-selected', function () {
      runningName = null
      runProgress = null
      expandedName = null
      detailCache = {}
      detailPending = {}
      refresh()
    })
    tasks.on('task-selected', function () {
      const wsId = getWorkspaceId() || null
      if (String(wsId || '') !== String(currentWorkspaceId || '')) {
        runningName = null
        runProgress = null
        expandedName = null
        detailCache = {}
        detailPending = {}
      }
      refresh({ silent: true })
    })
    tasks.on('state-sync-change', function () {
      const wsPath = getWorkspacePath() || null
      const wsId = getWorkspaceId() || null
      if (wsPath !== currentWorkspacePath || String(wsId || '') !== String(currentWorkspaceId || '')) {
        expandedName = null
        detailCache = {}
        detailPending = {}
        refresh()
      }
    })

    ipc.on('playbook-event', function (e, data) {
      if (!data) return
      if (data.workspaceId && currentWorkspaceId && String(data.workspaceId) !== String(currentWorkspaceId)) return
      if (!data.workspaceId && data.cwd && currentWorkspacePath && data.cwd !== currentWorkspacePath) return
      if (data.type === 'changed') {
        if (data.name) delete detailCache[data.name]
        refresh({ silent: true })
        return
      }
      if (data.type === 'progress') {
        runningName = data.name
        runProgress = { index: data.index, total: data.total, step: data.step }
        render()
        return
      }
      if (data.type === 'done') {
        runningName = null
        runProgress = null
        if (!data.ok) lastError = data.error || t('playbookRunError', 'Playbook failed')
        refresh({ silent: true })
      }
    })

    panelWasActive = panel.classList.contains('active')
    const observer = new MutationObserver(function () {
      const isActive = panel.classList.contains('active')
      if (isActive && !panelWasActive) refresh()
      panelWasActive = isActive
    })
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] })

    setInterval(function () {
      if (panel.classList.contains('active') && !runningName) refresh({ silent: true })
    }, 4000)
  },
  refresh: refresh
}

module.exports = playbookPanel
