/* global ipc, l, tasks, empty, MutationObserver */
/* Playbook sidebar: lists this workspace's automations. With a folder they
live in .min/playbooks; without one they are stored in Min per workspace. */

const editorView = require('editorView.js')
const promptModal = require('promptModal.js')
const sidebarUI = require('sidebar/ui.js')
const createRequestGate = require('sidebar/lifecycle/requestGate.js')

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
const refreshGate = createRequestGate()
let scopeGeneration = 0
let panelWasActive = false
let refreshTimer = null
let initialized = false
let refreshFlight = null
const repeatCounts = {}

function getWorkspacePath () {
  const ws = workspaces.getSelected()
  return ws && ws.path
}

function getWorkspaceId () {
  const ws = workspaces.getSelected()
  return ws && ws.id
}

function workspaceScopeKey (workspaceId, workspacePath) {
  const id = workspaceId == null || workspaceId === '' ? null : String(workspaceId)
  return JSON.stringify([id, workspacePath || null])
}

function selectedWorkspaceScopeKey () {
  return workspaceScopeKey(getWorkspaceId(), getWorkspacePath())
}

function isWorkspaceCurrent (workspaceId, workspacePath) {
  return workspaceId === currentWorkspaceId &&
    workspacePath === currentWorkspacePath &&
    workspaceScopeKey(workspaceId, workspacePath) === selectedWorkspaceScopeKey()
}

function t (key, fallback) {
  const value = l(key)
  return typeof value === 'string' && value ? value : fallback
}

function buildHeader () {
  return sidebarUI.createPanelHeader({
    title: t('sidebarPlaybook', 'Playbook'),
    actions: [{
      icon: 'codicon-add',
      label: t('playbookNew', 'New playbook'),
      onClick: function (event) {
        event.stopPropagation()
        createPlaybook()
      }
    }, {
      icon: 'codicon-refresh',
      label: t('playbookRefresh', 'Refresh'),
      onClick: function () { refresh() }
    }]
  })
}

function buildEmptyState () {
  return sidebarUI.createEmptyState({
    icon: 'codicon-checklist',
    message: t('playbookEmpty', 'No playbooks yet. Ask the Agent to automate a repeated browser task, or create one here.'),
    actionLabel: t('playbookNew', 'New playbook'),
    onAction: function (event) {
      event.stopPropagation()
      createPlaybook()
    }
  })
}

function listFingerprint (list) {
  return (list || []).map(function (entry) {
    return [entry.name, entry.steps, entry.description || '', entry.error || '', entry.updatedAt || '', entry.lastRun && entry.lastRun.runId].join('\t')
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
    if (runningName === entry.name && runProgress && runProgress.phase === 'steps' && runProgress.stepIndex === i) {
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
  const workspacePath = currentWorkspacePath
  const workspaceId = currentWorkspaceId
  const generation = scopeGeneration
  const request = { generation: generation, workspacePath: workspacePath, workspaceId: workspaceId }
  detailPending[name] = request
  ipc.invoke('playbookGet', workspacePath, name, workspaceId).then(function (result) {
    if (detailPending[name] !== request || generation !== scopeGeneration || workspacePath !== currentWorkspacePath || workspaceId !== currentWorkspaceId) return
    delete detailPending[name]
    if (!playbooks.some(function (entry) { return entry.name === name })) return
    if (!result || !result.ok) {
      detailCache[name] = { error: (result && result.error) || t('playbookLoadError', 'Could not load playbook'), steps: [] }
    } else {
      detailCache[name] = { steps: (result.playbook && result.playbook.steps) || [] }
    }
    const detail = findDetailEl(name)
    if (detail) renderSteps(detail, entry)
  }).catch(function () {
    if (detailPending[name] !== request || generation !== scopeGeneration || workspacePath !== currentWorkspacePath || workspaceId !== currentWorkspaceId) return
    delete detailPending[name]
    if (!playbooks.some(function (entry) { return entry.name === name })) return
    detailCache[name] = { error: t('playbookLoadError', 'Could not load playbook'), steps: [] }
    const detail = findDetailEl(name)
    if (detail) renderSteps(detail, entry)
  })
}

function stepSummary (step) {
  if (!step || typeof step !== 'object') return ''
  const action = step.action || 'step'
  const detail = step.stepName || step.testId || step.label || step.name || step.selector || step.url || step.text || step.ref || step.path || step.key || step.value || step.condition || step.operation || ''
  return detail ? action + ' · ' + String(detail).slice(0, 80) : action
}

function buildRow (entry) {
  const rowWorkspaceId = currentWorkspaceId
  const rowWorkspacePath = currentWorkspacePath
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
  if (entry.lastRun) {
    const result = document.createElement('button')
    result.className = 'playbook-result ' + (entry.lastRun.ok ? 'passed' : 'failed')
    const summary = entry.lastRun.summary || {}
    result.textContent = t('playbookStatus' + (entry.lastRun.status || 'failed'), entry.lastRun.status || 'failed') + ' · ' + (summary.passed || 0) + ' ✓ / ' + (summary.failed || 0) + ' ✕ · ' + Math.round(entry.lastRun.durationMs / 100) / 10 + 's'
    result.title = t('playbookOpenReport', 'Open report')
    result.addEventListener('click', function (e) {
      e.stopPropagation()
      if (entry.lastRun.reportPath) editorView.openFile(entry.lastRun.reportPath)
    })
    body.appendChild(result)
  }
  if (runningName === entry.name && runProgress) {
    const progress = document.createElement('div')
    progress.className = 'playbook-progress'
    progress.textContent = (runProgress.index + 1) + '/' + runProgress.total + ' · ' + (runProgress.case || '') + ' #' + (runProgress.iteration || 1) + ' · ' + (runProgress.phase || '') + ' ' + stepSummary(runProgress.step)
    body.appendChild(progress)
  }
  top.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'playbook-row-actions'

  if (!entry.error) {
    const repeat = document.createElement('input')
    repeat.type = 'number'
    repeat.min = '1'
    repeat.max = '20'
    repeat.step = '1'
    repeat.className = 'playbook-repeat'
    repeat.title = t('playbookRepeat', 'Repetitions')
    repeat.setAttribute('aria-label', repeat.title)
    repeat.value = repeatCounts[entry.name] || entry.repeat || 1
    repeat.disabled = !!runningName
    repeat.addEventListener('click', function (e) { e.stopPropagation() })
    repeat.addEventListener('change', function () {
      if (!isWorkspaceCurrent(rowWorkspaceId, rowWorkspacePath)) return
      const value = Math.max(1, Math.min(20, Math.round(Number(repeat.value) || 1)))
      repeatCounts[entry.name] = value
      repeat.value = value
    })
    actions.appendChild(repeat)
    const runBtn = document.createElement('button')
    runBtn.className = 'codicon codicon-play git-icon-button'
    runBtn.title = t('playbookRun', 'Run')
    runBtn.disabled = !!runningName
    runBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      runPlaybook(entry.name, Number(repeat.value), rowWorkspaceId, rowWorkspacePath)
    })
    actions.appendChild(runBtn)
    if (runningName === entry.name) {
      const stopBtn = document.createElement('button')
      stopBtn.className = 'codicon codicon-debug-stop git-icon-button'
      stopBtn.title = t('playbookStop', 'Stop after current step; run cleanup')
      stopBtn.addEventListener('click', async function (e) {
        e.stopPropagation()
        if (!isWorkspaceCurrent(rowWorkspaceId, rowWorkspacePath)) return
        stopBtn.disabled = true
        try {
          const result = await ipc.invoke('playbookCancel', rowWorkspaceId, entry.name)
          if (isWorkspaceCurrent(rowWorkspaceId, rowWorkspacePath) && !result.ok) { lastError = result.error; render() }
        } catch (err) {
          if (isWorkspaceCurrent(rowWorkspaceId, rowWorkspacePath)) { lastError = err.message; render() }
        }
      })
      actions.appendChild(stopBtn)
    }
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
    deletePlaybook(entry.name, rowWorkspaceId, rowWorkspacePath)
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

function refresh (options) {
  options = options || {}
  const silent = !!options.silent
  const wsPath = getWorkspacePath() || null
  const wsId = getWorkspaceId() || null
  if (wsPath !== currentWorkspacePath || wsId !== currentWorkspaceId) {
    syncWorkspaceScope()
    return
  }
  if (!wsId) {
    playbooks = []
    detailCache = {}
    detailPending = {}
    render()
    updateBadge()
    return Promise.resolve()
  }
  const scopeKey = workspaceScopeKey(wsId, wsPath)
  if (refreshFlight && refreshFlight.scopeKey === scopeKey) {
    refreshFlight.again = true
    refreshFlight.silent = refreshFlight.silent && silent
    return refreshFlight.promise
  }

  const flight = { scopeKey: scopeKey, again: false, silent: silent, promise: null }
  refreshFlight = flight
  flight.promise = performRefresh(silent, wsId, wsPath, scopeKey).finally(function () {
    if (refreshFlight === flight) refreshFlight = null
    if (flight.again && flight.scopeKey === selectedWorkspaceScopeKey() && flight.scopeKey === workspaceScopeKey(currentWorkspaceId, currentWorkspacePath)) {
      refresh({ silent: flight.silent })
    }
  })
  return flight.promise
}

async function performRefresh (silent, wsId, wsPath, scopeKey) {
  const request = refreshGate.begin(scopeKey)
  if (!silent && playbooks.length === 0) {
    isLoading = true
    render()
  }
  try {
    const result = await ipc.invoke('playbookList', wsPath, wsId)
    if (!refreshGate.isCurrent(request, selectedWorkspaceScopeKey()) || currentWorkspaceId !== wsId || currentWorkspacePath !== wsPath) return
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
    if (!refreshGate.isCurrent(request, selectedWorkspaceScopeKey()) || currentWorkspaceId !== wsId || currentWorkspacePath !== wsPath) return
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

function startRefreshPolling () {
  if (refreshTimer !== null) return
  refreshTimer = setInterval(function () {
    if (panel.classList.contains('active') && !runningName) refresh({ silent: true })
  }, 4000)
}

function stopRefreshPolling () {
  if (refreshTimer === null) return
  clearInterval(refreshTimer)
  refreshTimer = null
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
  if (!name || !isWorkspaceCurrent(wsId, wsPath)) return
  const stub = {
    name: name,
    description: '',
    steps: [
      { action: 'navigate', url: 'https://example.com' },
      { action: 'assert', condition: 'visible', role: 'heading', name: 'Example Domain' }
    ]
  }
  const result = await ipc.invoke('playbookSave', wsPath, stub, wsId)
  if (!isWorkspaceCurrent(wsId, wsPath)) return
  if (!result || !result.ok) {
    lastError = (result && result.error) || t('playbookSaveError', 'Could not save playbook')
    render()
    return
  }
  if (result.playbook && result.playbook.name) delete detailCache[result.playbook.name]
  await refresh()
  if (result.path) editorView.openFile(result.path)
}

async function runPlaybook (name, repeat, workspaceId, workspacePath) {
  const wsPath = workspacePath === undefined ? (getWorkspacePath() || null) : workspacePath
  const wsId = workspaceId === undefined ? getWorkspaceId() : workspaceId
  if (!wsId || runningName || !isWorkspaceCurrent(wsId, wsPath)) return
  runningName = name
  lastError = null
  render()
  try {
    const task = tasks.getSelected()
    const result = await ipc.invoke('playbookRun', wsPath, name, {}, wsId, { taskId: task && task.id, repeat: repeat })
    if (isWorkspaceCurrent(wsId, wsPath) && (!result || !result.ok)) {
      lastError = (result && result.error) || t('playbookRunError', 'Playbook failed')
    }
  } catch (err) {
    if (isWorkspaceCurrent(wsId, wsPath)) lastError = (err && err.message) || String(err)
  }
  if (!isWorkspaceCurrent(wsId, wsPath)) return
  runningName = null
  runProgress = null
  await refresh()
}

async function deletePlaybook (name, workspaceId, workspacePath) {
  const wsPath = workspacePath === undefined ? (getWorkspacePath() || null) : workspacePath
  const wsId = workspaceId === undefined ? getWorkspaceId() : workspaceId
  if (!wsId) return
  const ok = await promptModal.confirm({
    title: t('playbookDelete', 'Delete'),
    message: t('playbookDeleteConfirm', 'Delete playbook "%s"?').replace('%s', name),
    ok: l('dialogConfirmButton') || 'Confirm',
    cancel: l('dialogSkipButton') || 'Cancel'
  })
  if (!ok || !isWorkspaceCurrent(wsId, wsPath)) return
  const result = await ipc.invoke('playbookDelete', wsPath, name, wsId)
  if (!isWorkspaceCurrent(wsId, wsPath)) return
  if (!result || !result.ok) {
    lastError = (result && result.error) || t('playbookDeleteError', 'Could not delete playbook')
  }
  if (expandedName === name) expandedName = null
  delete detailCache[name]
  await refresh()
}

function syncWorkspaceScope () {
  const workspacePath = getWorkspacePath() || null
  const workspaceId = getWorkspaceId() || null
  if (workspacePath === currentWorkspacePath && workspaceId === currentWorkspaceId) return

  // Clear the old folder's rows before asking for the new list. Incrementing
  // both generations also prevents old list/detail requests from repopulating
  // the panel after the workspace path changes.
  scopeGeneration++
  currentWorkspacePath = workspacePath
  currentWorkspaceId = workspaceId
  refreshGate.setScope(workspaceScopeKey(workspaceId, workspacePath))
  playbooks = []
  isLoading = !!workspaceId
  runningName = null
  runProgress = null
  expandedName = null
  lastError = null
  detailCache = {}
  detailPending = {}
  Object.keys(repeatCounts).forEach(function (name) { delete repeatCounts[name] })
  render()
  updateBadge()
  refresh()
}

const playbookPanel = {
  initialize: function () {
    if (initialized) return
    initialized = true
    currentWorkspacePath = getWorkspacePath() || null
    currentWorkspaceId = getWorkspaceId() || null
    if (currentWorkspaceId) isLoading = true
    render()
    refresh()

    workspaces.on('workspace-selected', syncWorkspaceScope)
    workspaces.on('workspace-updated', function (workspaceId, key) {
      if (key !== 'path') return
      const selectedWorkspaceId = getWorkspaceId()
      if (selectedWorkspaceId && String(workspaceId) !== String(selectedWorkspaceId)) return
      syncWorkspaceScope()
    })
    // Covers synchronized path changes; task switches retain the same scope.
    workspaces.on('state-sync-change', syncWorkspaceScope)

    ipc.on('playbook-event', function (e, data) {
      if (!data) return
      if (data.workspaceId && currentWorkspaceId && String(data.workspaceId) !== String(currentWorkspaceId)) return
      if (data.cwd && data.cwd !== currentWorkspacePath) return
      if (data.type === 'changed') {
        if (data.name) delete detailCache[data.name]
        if (panel.classList.contains('active')) refresh({ silent: true })
        return
      }
      if (data.type === 'progress') {
        runningName = data.name
        runProgress = data
        if (panel.classList.contains('active')) render()
        return
      }
      if (data.type === 'done') {
        runningName = null
        runProgress = null
        if (!data.ok) lastError = data.error || t('playbookRunError', 'Playbook failed')
        if (panel.classList.contains('active')) refresh({ silent: true })
      }
    })

    refreshGate.setScope(workspaceScopeKey(currentWorkspaceId, currentWorkspacePath))
    panelWasActive = panel.classList.contains('active')
    const observer = new MutationObserver(function () {
      const isActive = panel.classList.contains('active')
      if (isActive && !panelWasActive) {
        refresh()
        startRefreshPolling()
      } else if (!isActive && panelWasActive) {
        stopRefreshPolling()
      }
      panelWasActive = isActive
    })
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] })

    if (panelWasActive) startRefreshPolling()
  },
  refresh: refresh
}

module.exports = playbookPanel
