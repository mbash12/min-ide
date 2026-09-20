/* global ipc, tasks, workspaces */
const proSettingsPage = require('util/proSettingsPage.js')
const agentMarkdown = require('sidebar/agentMarkdown.js')
const agentSlash = require('sidebar/agentSlash.js')
const taskPrefs = require('taskPrefs.js')

/* Chat UI for the sidebar's AI tab. The pi agent session runs in the main
process (main/agent.js); this module renders the streaming transcript and
forwards prompts over IPC.

The conversation is scoped per task: each task in a workspace keeps its
own transcript, model/thinking preference and backend session. Switching
tasks swaps the visible transcript and asks the backend for that
task's state. The composer is styled after t3.chat: a rounded card pinned
to the bottom with a model selector, a thinking-level selector, a live
context-usage donut and a send/stop button. Enter sends, Shift+Enter inserts a
newline. Sending while a reply is still running steers the current run. An
empty send while streaming stops it. */

const panel = document.getElementById('sidebar-panel-ai')

const THINKING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

let els = null // cached DOM references created by buildUI()
let currentAssistantEl = null // bubble receiving the active text stream (active task only)
let currentThinkingEl = null
let isStreaming = false
let modelsCache = null // model catalog (provider-aware) for the model picker
let popover = null // currently open popover element
let popoverAnchor = null
let currentSessionPath = null
let historyOpen = false
let historyTimer = null
let isCompacting = false
let lastContextInfo = null
let slashItems = []
let slashIndex = 0
let slashMenuOpen = false

/* per-task transcript + in-progress state, keyed by task id. The backend
keeps the authoritative session/messages; this map just caches what we've
rendered so switching tasks is instant. */
const conversations = new Map()
let activeTaskId = null

function getTaskInfo () {
  const task = tasks.getSelected()
  const ws = workspaces.getSelected()
  return {
    taskId: task ? String(task.id) : 'default',
    workspaceId: ws ? String(ws.id) : 'default',
    cwd: (ws && ws.path) ? ws.path : null
  }
}

function getActiveTaskId () {
  return getTaskInfo().taskId
}

function agentPayload (extra) {
  const info = getTaskInfo()
  return Object.assign({ taskId: info.taskId, workspaceId: info.workspaceId, cwd: info.cwd }, extra || {})
}

function convFor (taskId) {
  const key = taskId || 'default'
  if (!conversations.has(key)) conversations.set(key, { messages: [], assistantMsg: null, thinking: '' })
  return conversations.get(key)
}

function currentConv () {
  return convFor(getActiveTaskId())
}

/* ----- session ownership (HANDOVER §25) -----
Sessions live at workspace scope; a task claims one by keeping its file path
in task.prefs.agentSession. The record dies with the task, so a deleted task
frees its session automatically. At most one task holds a given session. */

function sessionOwners () {
  const owners = {}
  const ws = typeof workspaces !== 'undefined' && workspaces.getSelected && workspaces.getSelected()
  if (!ws) return owners
  ws.tasks.forEach(function (task) {
    const path = task.prefs && task.prefs.agentSession
    if (path) owners[path] = task
  })
  return owners
}

function ownerTaskFor (sessionPath) {
  return sessionPath ? (sessionOwners()[sessionPath] || null) : null
}

function taskLabel (task) {
  return (task && task.name) || 'Task'
}

function syncSessionOwnership (taskId, sessionPath) {
  if (!taskId || taskId === 'default') return
  taskPrefs.set(taskId, 'agentSession', sessionPath || null)
}

function getModelLabel (modelId) {
  if (!modelId) return 'Model'
  const short = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId
  return short
}

/* ----- DOM building ----- */

function buildUI () {
  const root = document.createElement('div')
  root.className = 'agent-panel'

  /* header, kept light: just the title and the new-chat / settings actions */
  const header = document.createElement('div')
  header.className = 'file-tree-header agent-header'

  const title = document.createElement('div')
  title.className = 'file-tree-title'
  title.textContent = 'Agent'
  header.appendChild(title)

  const actions = document.createElement('div')
  actions.className = 'file-tree-header-actions'

  const historyButton = document.createElement('button')
  historyButton.className = 'codicon codicon-history git-icon-button'
  historyButton.title = 'Chat history'
  historyButton.addEventListener('click', function () {
    if (historyOpen) closeHistoryDrawer()
    else openHistoryDrawer()
  })
  actions.appendChild(historyButton)

  const newChatButton = document.createElement('button')
  newChatButton.className = 'codicon codicon-add git-icon-button'
  newChatButton.title = 'New chat'
  newChatButton.addEventListener('click', startNewChat)
  actions.appendChild(newChatButton)

  header.appendChild(actions)

  /* transcript */
  const transcript = document.createElement('div')
  transcript.className = 'agent-transcript'

  /* composer card, pinned to the bottom */
  const composer = document.createElement('div')
  composer.className = 'agent-composer'

  const card = document.createElement('div')
  card.className = 'agent-composer-card'

  const input = document.createElement('textarea')
  input.className = 'agent-input'
  input.rows = 1
  input.placeholder = 'Ask or type / for commands…'
  input.addEventListener('keydown', onComposerKeydown)
  input.addEventListener('input', function () {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 220) + 'px'
    updateSlashMenu()
    updateSendButton()
  })
  input.addEventListener('blur', function () {
    setTimeout(function () {
      if (document.activeElement !== els.input) hideSlashMenu()
    }, 120)
  })

  const actionsRow = document.createElement('div')
  actionsRow.className = 'agent-composer-actions'

  const leftGroup = document.createElement('div')
  leftGroup.className = 'agent-composer-left'

  const modelButton = document.createElement('button')
  modelButton.className = 'agent-pill'
  modelButton.addEventListener('click', function (e) {
    e.stopPropagation()
    openModelPopover(modelButton)
  })
  const modelLabel = document.createElement('span')
  modelLabel.className = 'agent-pill-label'
  modelLabel.textContent = 'Model'
  const modelCaret = document.createElement('i')
  modelCaret.className = 'codicon codicon-chevron-down agent-pill-caret'
  modelButton.appendChild(modelLabel)
  modelButton.appendChild(modelCaret)

  const thinkingButton = document.createElement('button')
  thinkingButton.className = 'agent-pill'
  thinkingButton.addEventListener('click', function (e) {
    e.stopPropagation()
    openThinkingPopover(thinkingButton)
  })
  const thinkingLabel = document.createElement('span')
  thinkingLabel.className = 'agent-pill-label'
  thinkingLabel.textContent = 'Thinking'
  const thinkingCaret = document.createElement('i')
  thinkingCaret.className = 'codicon codicon-chevron-down agent-pill-caret'
  thinkingButton.appendChild(thinkingLabel)
  thinkingButton.appendChild(thinkingCaret)

  const pillDivider = document.createElement('div')
  pillDivider.className = 'agent-pill-divider'
  leftGroup.appendChild(modelButton)
  leftGroup.appendChild(pillDivider)
  leftGroup.appendChild(thinkingButton)

  const rightGroup = document.createElement('div')
  rightGroup.className = 'agent-composer-right'

  const donut = document.createElement('button')
  donut.type = 'button'
  donut.className = 'agent-donut'
  donut.title = 'Context usage'
  donut.addEventListener('click', function (e) {
    e.stopPropagation()
    openContextPopover(donut)
  })
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('width', '26')
  svg.setAttribute('height', '26')
  svg.setAttribute('viewBox', '0 0 26 26')
  const track = document.createElementNS(svgNS, 'circle')
  track.setAttribute('class', 'agent-donut-track')
  track.setAttribute('cx', '13')
  track.setAttribute('cy', '13')
  track.setAttribute('r', '10')
  const fill = document.createElementNS(svgNS, 'circle')
  fill.setAttribute('class', 'agent-donut-fill')
  fill.setAttribute('cx', '13')
  fill.setAttribute('cy', '13')
  fill.setAttribute('r', '10')
  svg.appendChild(track)
  svg.appendChild(fill)
  const donutLabel = document.createElement('span')
  donutLabel.className = 'agent-donut-label'
  donutLabel.textContent = '–'
  donut.appendChild(svg)
  donut.appendChild(donutLabel)

  const sendButton = document.createElement('button')
  sendButton.className = 'codicon codicon-arrow-up agent-send-button'
  sendButton.title = 'Send'
  sendButton.disabled = true
  sendButton.addEventListener('click', sendCurrentInput)

  rightGroup.appendChild(donut)
  rightGroup.appendChild(sendButton)

  actionsRow.appendChild(leftGroup)
  actionsRow.appendChild(rightGroup)

  card.appendChild(input)
  card.appendChild(actionsRow)
  composer.appendChild(card)

  const slashMenu = document.createElement('div')
  slashMenu.className = 'agent-slash-menu'
  composer.appendChild(slashMenu)

  root.appendChild(header)
  root.appendChild(transcript)
  root.appendChild(composer)

  const history = document.createElement('div')
  history.className = 'agent-history'

  const historyHeader = document.createElement('div')
  historyHeader.className = 'file-tree-header agent-header'
  const historyTitle = document.createElement('div')
  historyTitle.className = 'file-tree-title'
  historyTitle.textContent = 'History'
  historyHeader.appendChild(historyTitle)
  const historyHeaderActions = document.createElement('div')
  historyHeaderActions.className = 'file-tree-header-actions'
  const historyClose = document.createElement('button')
  historyClose.className = 'codicon codicon-close git-icon-button'
  historyClose.title = 'Close'
  historyClose.addEventListener('click', closeHistoryDrawer)
  historyHeaderActions.appendChild(historyClose)
  historyHeader.appendChild(historyHeaderActions)

  const searchWrap = document.createElement('div')
  searchWrap.className = 'agent-history-search-wrap'
  const historySearch = document.createElement('input')
  historySearch.className = 'agent-history-search'
  historySearch.type = 'search'
  historySearch.placeholder = 'Search chats…'
  historySearch.addEventListener('input', scheduleHistoryRefresh)
  searchWrap.appendChild(historySearch)

  const historyList = document.createElement('div')
  historyList.className = 'agent-history-list'

  history.appendChild(historyHeader)
  history.appendChild(searchWrap)
  history.appendChild(historyList)
  root.appendChild(history)
  panel.appendChild(root)

  els = {
    root,
    transcript,
    input,
    modelButton,
    modelLabel,
    thinkingButton,
    thinkingLabel,
    donut,
    donutFill: fill,
    donutLabel,
    sendButton,
    history,
    historySearch,
    historyList,
    historyButton,
    slashMenu
  }
}

function confirmStopRunning (message) {
  if (!isStreaming) return true
  return confirm(message)
}

function startNewChat () {
  if (!confirmStopRunning('A reply is still running. Stop it and start a new chat?')) return
  closeHistoryDrawer()
  currentSessionPath = null
  clearActiveConversation()
  ipc.send('agent-new-session', agentPayload())
}

function formatHistoryTime (ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'Just now'
  if (diff < hour) return Math.floor(diff / minute) + 'm ago'
  if (diff < day) return Math.floor(diff / hour) + 'h ago'
  if (diff < 7 * day) return Math.floor(diff / day) + 'd ago'
  try {
    return new Date(ts).toLocaleDateString()
  } catch (e) {
    return ''
  }
}

function onHistoryKeydown (e) {
  if (e.key === 'Escape') closeHistoryDrawer()
}

function openHistoryDrawer () {
  if (!els || historyOpen) return
  hideSlashMenu()
  historyOpen = true
  els.history.classList.add('open')
  els.historyButton.classList.add('active')
  document.addEventListener('keydown', onHistoryKeydown)
  els.historySearch.value = ''
  refreshHistoryList()
  setTimeout(function () {
    els.historySearch.focus()
  }, 0)
}

function closeHistoryDrawer () {
  if (!historyOpen) return
  historyOpen = false
  if (historyTimer) {
    clearTimeout(historyTimer)
    historyTimer = null
  }
  if (els) {
    els.history.classList.remove('open')
    els.historyButton.classList.remove('active')
  }
  document.removeEventListener('keydown', onHistoryKeydown)
}

function scheduleHistoryRefresh () {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = setTimeout(function () {
    historyTimer = null
    refreshHistoryList()
  }, 140)
}

async function refreshHistoryList () {
  if (!els || !historyOpen) return
  const query = (els.historySearch.value || '').trim()
  let result
  try {
    result = await ipc.invoke('agent-list-sessions', agentPayload({ query: query }))
  } catch (e) {
    result = null
  }
  if (!historyOpen) return
  const sessions = (result && result.sessions) || []
  if (result && result.currentPath) currentSessionPath = result.currentPath
  renderHistoryList(sessions)
}

function renderHistoryList (sessions) {
  els.historyList.textContent = ''
  if (!sessions.length) {
    const empty = document.createElement('div')
    empty.className = 'agent-history-empty'
    empty.textContent = els.historySearch.value.trim() ? 'No matching chats' : 'No previous chats'
    els.historyList.appendChild(empty)
    return
  }
  const owners = sessionOwners()
  const myTaskId = getActiveTaskId()
  sessions.forEach(function (session) {
    const owner = session.path ? owners[session.path] : null
    const mine = owner ? String(owner.id) === myTaskId : false
    const locked = !!(owner && !mine)

    const row = document.createElement('div')
    row.className = 'agent-history-item'
    if (mine || (session.path && session.path === currentSessionPath)) row.classList.add('active')
    if (locked) row.classList.add('locked')

    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'agent-history-item-main'
    const title = document.createElement('div')
    title.className = 'agent-history-item-title'
    title.textContent = session.title || 'New chat'
    const meta = document.createElement('div')
    meta.className = 'agent-history-item-meta'
    const count = session.messageCount === 1 ? '1 message' : (session.messageCount || 0) + ' messages'
    const status = owner
      ? (mine ? ' · active' : ' · active in ' + taskLabel(owner))
      : ' · available'
    meta.textContent = formatHistoryTime(session.modified) + ' · ' + count + status
    main.appendChild(title)
    main.appendChild(meta)
    /* a session owned by another task is not selectable - its task has to
    create a new chat or switch first (HANDOVER §25) */
    main.disabled = locked
    main.addEventListener('click', function () {
      switchToSession(session.path)
    })

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'codicon codicon-trash git-icon-button agent-history-delete'
    del.title = 'Delete'
    del.addEventListener('click', function (e) {
      e.stopPropagation()
      deleteHistorySession(session.path)
    })

    row.appendChild(main)
    row.appendChild(del)
    els.historyList.appendChild(row)
  })
}

async function switchToSession (sessionPath) {
  if (!sessionPath) return
  const owner = ownerTaskFor(sessionPath)
  if (owner && String(owner.id) !== getActiveTaskId()) return
  if (sessionPath === currentSessionPath) {
    closeHistoryDrawer()
    return
  }
  if (!confirmStopRunning('A reply is still running. Stop it and switch chats?')) return
  try {
    const state = await ipc.invoke('agent-open-session', agentPayload({ path: sessionPath }))
    if (!state || state.ok === false) return
    applyTaskState(state)
    closeHistoryDrawer()
  } catch (e) {}
}

async function deleteHistorySession (sessionPath) {
  if (!sessionPath) return
  const isCurrent = sessionPath === currentSessionPath
  const message = (isCurrent && isStreaming)
    ? 'A reply is still running. Stop it and delete this chat?'
    : 'Delete this chat? This cannot be undone.'
  if (!confirm(message)) return
  try {
    const result = await ipc.invoke('agent-delete-session', agentPayload({ path: sessionPath }))
    if (!result || result.ok === false) return
    /* free the deleted file from whichever task held it */
    const owner = ownerTaskFor(sessionPath)
    if (owner) syncSessionOwnership(String(owner.id), null)
    if (result.deletedCurrent) {
      applyTaskState(result.state)
    }
    if (historyOpen) refreshHistoryList()
  } catch (e) {}
}

function applyTaskState (state) {
  if (!els || !state) return
  const conv = currentConv()
  conv.messages = state.messages || []
  conv.assistantMsg = null
  conv.thinking = ''
  currentSessionPath = state.sessionPath || null
  syncSessionOwnership(getActiveTaskId(), state.sessionPath)
  if (state.modelId) {
    els.modelLabel.textContent = getModelLabel(state.modelId)
    els.modelLabel.dataset.modelId = state.modelId
  } else {
    els.modelLabel.textContent = 'Model'
    els.modelLabel.dataset.modelId = ''
  }
  applyThinkingUI(state.thinkingLevel || 'medium')
  const lastBubble = renderTranscript()
  if (state.streaming && conv.messages.length) {
    const last = conv.messages[conv.messages.length - 1]
    if (last.role === 'assistant') {
      conv.assistantMsg = last
      currentAssistantEl = lastBubble
    }
  } else {
    currentAssistantEl = null
  }
  updateContext(state.context)
  setStreamingUI(!!state.streaming)
  setCompactingUI(!!state.compacting)
}

/* ----- popovers (model + thinking pickers) ----- */

function closePopover () {
  if (popover) {
    popover.remove()
    popover = null
    popoverAnchor = null
  }
  document.removeEventListener('mousedown', onPopoverOutside, true)
}

function onPopoverOutside (e) {
  if (popover && !popover.contains(e.target) && popoverAnchor && !popoverAnchor.contains(e.target)) {
    closePopover()
  }
}

function buildPopover (anchor) {
  closePopover()
  hideSlashMenu()
  popoverAnchor = anchor
  const p = document.createElement('div')
  p.className = 'agent-popover'
  const rect = anchor.getBoundingClientRect()
  p.style.position = 'fixed'
  p.style.left = Math.max(8, rect.left) + 'px'
  p.style.bottom = (window.innerHeight - rect.top + 6) + 'px'
  p.style.minWidth = Math.max(180, rect.width) + 'px'
  document.body.appendChild(p)
  popover = p
  setTimeout(function () {
    document.addEventListener('mousedown', onPopoverOutside, true)
  }, 0)
  return p
}

function openThinkingPopover (anchor) {
  const p = buildPopover(anchor)
  p.classList.add('agent-popover-thinking')
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const current = els.thinkingLabel.dataset.level || 'medium'
  levels.forEach(function (level) {
    const item = document.createElement('button')
    item.className = 'agent-popover-item'
    item.type = 'button'
    if (level === current) item.classList.add('selected')
    const name = document.createElement('span')
    name.textContent = THINKING_LABELS[level] || level
    const check = document.createElement('i')
    check.className = 'codicon codicon-check agent-popover-check'
    item.appendChild(name)
    item.appendChild(check)
    item.addEventListener('click', function () {
      setThinkingLevel(level)
      closePopover()
    })
    p.appendChild(item)
  })
}

function openModelPopover (anchor) {
  const p = buildPopover(anchor)
  p.classList.add('agent-popover-models')
  const search = document.createElement('input')
  search.className = 'agent-popover-search'
  search.placeholder = 'Search models…'
  p.appendChild(search)
  const list = document.createElement('div')
  list.className = 'agent-popover-list'
  p.appendChild(list)

  const current = els.modelLabel.dataset.modelId || null

  function render (query) {
    list.textContent = ''
    const q = (query || '').trim().toLowerCase()
    const models = (modelsCache || []).filter(function (m) {
      return !q || m.id.toLowerCase().indexOf(q) !== -1 || (m.name && m.name.toLowerCase().indexOf(q) !== -1)
    }).slice(0, 60)

    if (!models.length) {
      const empty = document.createElement('div')
      empty.className = 'agent-popover-empty'
      empty.textContent = 'No models found'
      list.appendChild(empty)
      return
    }
    models.forEach(function (m) {
      const item = document.createElement('button')
      item.className = 'agent-popover-item'
      item.type = 'button'
      if (m.id === current) item.classList.add('selected')

      const text = document.createElement('span')
      text.className = 'agent-popover-item-text'

      const name = document.createElement('span')
      name.className = 'agent-popover-item-name'
      name.textContent = m.name || m.id

      const sub = document.createElement('span')
      sub.className = 'agent-popover-item-sub'
      const parts = []
      if (m.providerLabel || m.provider) parts.push(m.providerLabel || m.provider)
      if (m.contextWindow) parts.push(Math.round(m.contextWindow / 1000) + 'k ctx')
      sub.textContent = parts.join('  ·  ')

      text.appendChild(name)
      text.appendChild(sub)

      const check = document.createElement('i')
      check.className = 'codicon codicon-check agent-popover-check'

      item.appendChild(text)
      item.appendChild(check)
      item.addEventListener('click', function () {
        setModel(m.provider, m.id)
        closePopover()
      })
      list.appendChild(item)
    })
  }

  render('')
  search.addEventListener('input', function () {
    render(search.value)
  })
  setTimeout(function () { search.focus() }, 0)
}

function formatContextTokens (n) {
  if (n == null || !Number.isFinite(n)) return '–'
  if (n >= 1000) return Math.round(n / 100) / 10 + 'k'
  return String(Math.round(n))
}

function openContextPopover (anchor) {
  const p = buildPopover(anchor)
  p.classList.add('agent-popover-context')
  const rect = anchor.getBoundingClientRect()
  p.style.left = Math.max(8, Math.min(rect.right - 228, window.innerWidth - 236)) + 'px'
  p.style.minWidth = '220px'
  p.style.width = '228px'

  const head = document.createElement('div')
  head.className = 'agent-context-pop-head'
  const title = document.createElement('div')
  title.className = 'agent-context-pop-title'
  title.textContent = 'Context window'
  const stats = document.createElement('div')
  stats.className = 'agent-context-pop-stats'
  const info = lastContextInfo
  const pct = (info && info.percent != null) ? Math.max(0, Math.min(100, info.percent)) : null
  if (info && info.contextWindow) {
    stats.textContent = (pct != null ? Math.round(pct) + '% · ' : '') +
      formatContextTokens(info.tokens) + ' / ' + formatContextTokens(info.contextWindow)
  } else {
    stats.textContent = 'No usage yet'
  }
  head.appendChild(title)
  head.appendChild(stats)
  p.appendChild(head)

  const bar = document.createElement('div')
  bar.className = 'agent-context-pop-bar'
  const fill = document.createElement('div')
  fill.className = 'agent-context-pop-bar-fill'
  if (pct != null && pct > 80) fill.classList.add('warn')
  fill.style.width = (pct != null ? pct : 0) + '%'
  bar.appendChild(fill)
  p.appendChild(bar)

  const compactBtn = document.createElement('button')
  compactBtn.type = 'button'
  compactBtn.className = 'agent-context-compact'
  const compactIcon = document.createElement('i')
  compactIcon.className = 'codicon codicon-fold'
  const compactLabel = document.createElement('span')
  compactLabel.textContent = isCompacting ? 'Compacting…' : 'Compact context'
  compactBtn.appendChild(compactIcon)
  compactBtn.appendChild(compactLabel)
  const hasChat = currentConv().messages.length > 0
  compactBtn.disabled = isCompacting || !hasChat
  compactBtn.addEventListener('click', function () {
    closePopover()
    requestCompact()
  })
  p.appendChild(compactBtn)
}

function setModel (provider, modelId) {
  els.modelLabel.textContent = getModelLabel(modelId)
  els.modelLabel.dataset.modelId = modelId || ''
  updateSendButton()
  ipc.send('agent-set-model', agentPayload({ provider: provider || 'openrouter', modelId: modelId || null }))
}

function setThinkingLevel (level) {
  applyThinkingUI(level)
  ipc.send('agent-set-thinking', agentPayload({ level: level }))
}

function applyThinkingUI (level) {
  els.thinkingLabel.textContent = THINKING_LABELS[level] || level
  els.thinkingLabel.dataset.level = level
}

/* ----- transcript rendering ----- */

function scrollToEnd () {
  els.transcript.scrollTop = els.transcript.scrollHeight
}

function fillFormattedText (el, text) {
  agentMarkdown.render(el, text)
}

function toolIconClass (name) {
  const n = (name || '').toLowerCase()
  if (n === 'bash' || n === 'terminal' || n === 'shell') return 'codicon-terminal'
  if (n === 'read' || n === 'ls') return 'codicon-file'
  if (n === 'grep' || n === 'find') return 'codicon-search'
  if (n === 'edit' || n === 'write') return 'codicon-edit'
  if (n === 'browser' || n.indexOf('browser_') === 0) return 'codicon-globe'
  if (n === 'playbook') return 'codicon-checklist'
  return 'codicon-tools'
}

function friendlyToolLabel (name) {
  const n = (name || '').toLowerCase()
  if (n === 'bash') return 'Ran command'
  if (n === 'read') return 'Read file'
  if (n === 'write') return 'Wrote file'
  if (n === 'edit') return 'Edited file'
  if (n === 'grep') return 'Searched'
  if (n === 'find') return 'Found files'
  if (n === 'ls') return 'Listed files'
  if (n === 'browser' || n.indexOf('browser_') === 0) return 'Browser'
  if (n === 'playbook') return 'Playbook'
  return name || 'Tool'
}

function makeWorkRow (item) {
  const row = document.createElement('div')
  row.className = 'agent-work-row' + (item.status === 'running' ? ' running' : '') + (item.status === 'error' ? ' error' : '')
  const icon = document.createElement('i')
  if (item.status === 'running') {
    icon.className = 'codicon codicon-loading codicon-modifier-spin'
  } else if (item.status === 'error') {
    icon.className = 'codicon codicon-error'
  } else {
    icon.className = 'codicon ' + toolIconClass(item.name)
  }
  const label = document.createElement('span')
  label.className = 'agent-work-label'
  const title = friendlyToolLabel(item.name)
  label.textContent = item.detail ? (title + '  ' + item.detail) : title
  label.title = item.detail ? (item.name + ': ' + item.detail) : item.name
  row.appendChild(icon)
  row.appendChild(label)
  if (item.status === 'done') {
    const check = document.createElement('i')
    check.className = 'codicon codicon-check agent-work-status'
    row.appendChild(check)
  }
  return row
}

function renderWorkGroup (group) {
  if (!els || !els.transcript) return null
  let wrap = group.el
  if (!wrap || !wrap.isConnected) {
    wrap = document.createElement('div')
    wrap.className = 'agent-work-group'
    group.el = wrap
    els.transcript.appendChild(wrap)
  }
  wrap.textContent = ''
  const items = group.items || []
  if (!items.length) return wrap
  const expanded = !!group.expanded
  const visible = expanded ? items : items.slice(-1)
  const hidden = expanded ? 0 : Math.max(0, items.length - 1)

  visible.forEach(function (item) {
    wrap.appendChild(makeWorkRow(item))
  })

  if (items.length > 1) {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'agent-work-toggle'
    const chevron = document.createElement('i')
    chevron.className = 'codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right')
    const text = document.createElement('span')
    if (expanded) {
      text.textContent = 'Show fewer tool calls'
    } else {
      text.textContent = hidden === 1 ? '+1 previous tool call' : ('+' + hidden + ' previous tool calls')
    }
    toggle.appendChild(chevron)
    toggle.appendChild(text)
    toggle.addEventListener('click', function () {
      group.expanded = !group.expanded
      renderWorkGroup(group)
    })
    wrap.appendChild(toggle)
  }
  return wrap
}

function ensureToolsGroup (conv) {
  const last = conv.messages[conv.messages.length - 1]
  if (last && last.role === 'tools') return last
  const group = { role: 'tools', items: [], expanded: false, el: null }
  conv.messages.push(group)
  return group
}

function renderThinking (text) {
  if (!els || !els.transcript) return
  if (!text) {
    if (currentThinkingEl && currentThinkingEl.parentNode) currentThinkingEl.remove()
    currentThinkingEl = null
    return
  }
  if (!currentThinkingEl || !currentThinkingEl.isConnected) {
    currentThinkingEl = document.createElement('div')
    currentThinkingEl.className = 'agent-thinking'
    els.transcript.appendChild(currentThinkingEl)
  }
  const preview = text.replace(/\s+/g, ' ').trim()
  currentThinkingEl.textContent = preview.length > 180 ? ('Thinking  ·  ' + preview.slice(0, 180) + '…') : ('Thinking  ·  ' + preview)
}

function renderUserBubble (text) {
  const bubble = document.createElement('div')
  bubble.className = 'agent-message agent-message-user'
  bubble.textContent = text
  els.transcript.appendChild(bubble)
  return bubble
}

function makeAssistantBubble () {
  const bubble = document.createElement('div')
  bubble.className = 'agent-message agent-message-assistant'
  els.transcript.appendChild(bubble)
  return bubble
}

function addUserMessage (text) {
  currentConv().messages.push({ role: 'user', text: text })
  renderUserBubble(text)
  scrollToEnd()
}

function addErrorLine (message) {
  const line = document.createElement('div')
  line.className = 'agent-error-line'
  line.textContent = message
  els.transcript.appendChild(line)
  scrollToEnd()
}

function renderCompactMarker (text) {
  const line = document.createElement('div')
  line.className = 'agent-compact-line'
  line.textContent = 'Context compacted'
  if (text) line.title = text
  els.transcript.appendChild(line)
}

function setStreamingUI (streaming) {
  isStreaming = streaming
  if (els && els.input) {
    els.input.placeholder = streaming
      ? 'Steer the agent, or send empty to stop…'
      : 'Ask or type / for commands…'
  }
  updateSendButton()
}

/* rebuilds the visible transcript from the active task's cached messages.
Returns the DOM bubble of the last assistant message (if any) so the caller can
re-attach the live stream when the task is still generating. */
function renderTranscript () {
  els.transcript.textContent = ''
  currentAssistantEl = null
  currentThinkingEl = null
  const conv = currentConv()
  let lastAssistantBubble = null
  conv.messages.forEach(function (m) {
    if (m.role === 'user') {
      renderUserBubble(m.text)
    } else if (m.role === 'tools') {
      m.el = null
      renderWorkGroup(m)
    } else if (m.role === 'compact') {
      renderCompactMarker(m.text)
    } else if (m.role === 'assistant') {
      lastAssistantBubble = makeAssistantBubble()
      fillFormattedText(lastAssistantBubble, m.text)
    }
  })
  if (conv.thinking) renderThinking(conv.thinking)
  scrollToEnd()
  return lastAssistantBubble
}

/* clears the active task's transcript (DOM + cached messages) */
function clearActiveConversation () {
  const conv = currentConv()
  conv.messages = []
  conv.assistantMsg = null
  conv.thinking = ''
  els.transcript.textContent = ''
  currentAssistantEl = null
  currentThinkingEl = null
  setStreamingUI(false)
  setCompactingUI(false)
}

/* ----- context donut ----- */

function updateContext (info) {
  /* the SDK reports `percent` as a 0–100 percentage value (e.g. 0.22 means
  0.22%, 50 means 50%), not a 0–1 fraction */
  lastContextInfo = info || null
  let fraction = 0
  let pctValue = null
  if (info && info.percent != null) {
    pctValue = info.percent
    fraction = Math.max(0, Math.min(1, pctValue / 100))
  }
  const circ = 2 * Math.PI * 10
  els.donutFill.style.strokeDasharray = circ
  els.donutFill.style.strokeDashoffset = circ * (1 - fraction)
  if (pctValue == null) {
    els.donutLabel.textContent = '–'
    els.donut.title = 'Context usage'
  } else {
    const n = Math.max(0, Math.min(100, Math.round(pctValue)))
    els.donutLabel.textContent = String(n)
    if (info && info.contextWindow) {
      els.donut.title = formatContextTokens(info.tokens) + ' / ' +
        formatContextTokens(info.contextWindow) + ' context — click to compact'
    } else {
      els.donut.title = n + '% context — click to compact'
    }
  }
  els.donut.classList.toggle('agent-donut-warn', fraction > 0.8)
}

function setCompactingUI (compacting) {
  isCompacting = !!compacting
  if (els && els.donut) els.donut.classList.toggle('agent-donut-busy', isCompacting)
}

async function requestCompact (instructions) {
  if (isCompacting) return
  if (!currentConv().messages.length) return
  const message = isStreaming
    ? 'A reply is still running. Stop it and compact older messages to free context? This cannot be undone.'
    : 'Compact this chat? Older messages will be summarized to free context. This cannot be undone.'
  if (!confirm(message)) return
  setCompactingUI(true)
  try {
    const result = await ipc.invoke('agent-compact', agentPayload({
      instructions: instructions || ''
    }))
    if (!result || result.ok === false) {
      setCompactingUI(false)
      addErrorLine((result && result.message) || 'Could not compact context')
      return
    }
    applyTaskState(result)
  } catch (e) {
    setCompactingUI(false)
    addErrorLine('Could not compact context')
  }
}

function addSystemLine (text) {
  if (!els || !els.transcript) return
  const line = document.createElement('div')
  line.className = 'agent-slash-note'
  line.textContent = text
  els.transcript.appendChild(line)
  scrollToEnd()
}

function hideSlashMenu () {
  slashMenuOpen = false
  slashItems = []
  slashIndex = 0
  if (els && els.slashMenu) {
    els.slashMenu.classList.remove('open')
    els.slashMenu.textContent = ''
  }
}

function moveSlashHighlight (delta) {
  if (!slashItems.length) return
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length
  const rows = els.slashMenu.querySelectorAll('.agent-slash-item')
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('selected', i === slashIndex)
  }
  if (rows[slashIndex] && rows[slashIndex].scrollIntoView) {
    rows[slashIndex].scrollIntoView({ block: 'nearest' })
  }
}

function renderSlashMenu (items) {
  els.slashMenu.textContent = ''
  if (!items.length) {
    hideSlashMenu()
    return
  }
  slashItems = items
  if (slashIndex >= items.length) slashIndex = 0
  items.forEach(function (cmd, i) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'agent-slash-item' + (i === slashIndex ? ' selected' : '')
    const icon = document.createElement('i')
    icon.className = 'codicon ' + (cmd.icon || 'codicon-chevron-right')
    const text = document.createElement('span')
    text.className = 'agent-slash-item-text'
    const name = document.createElement('span')
    name.className = 'agent-slash-item-name'
    name.textContent = '/' + cmd.name
    const hint = document.createElement('span')
    hint.className = 'agent-slash-item-hint'
    hint.textContent = cmd.hint || ''
    text.appendChild(name)
    text.appendChild(hint)
    row.appendChild(icon)
    row.appendChild(text)
    row.addEventListener('mousedown', function (e) {
      e.preventDefault()
      selectSlashItem(cmd)
    })
    els.slashMenu.appendChild(row)
  })
  slashMenuOpen = true
  els.slashMenu.classList.add('open')
}

function updateSlashMenu () {
  if (!els || !els.input) return
  const trigger = agentSlash.detect(els.input.value, els.input.selectionStart)
  if (!trigger) {
    hideSlashMenu()
    return
  }
  renderSlashMenu(agentSlash.filterCommands(trigger.query))
}

function selectSlashItem (cmd) {
  if (!cmd) return
  hideSlashMenu()
  if (cmd.insert) {
    els.input.value = '/' + cmd.name + ' '
    els.input.focus()
    els.input.selectionStart = els.input.selectionEnd = els.input.value.length
    updateSendButton()
    return
  }
  els.input.value = ''
  els.input.style.height = 'auto'
  updateSendButton()
  runSlashCommand(cmd, '')
}

function findModelMatch (query) {
  const q = String(query || '').toLowerCase()
  if (!q || !modelsCache) return null
  const exact = modelsCache.find(function (m) {
    return m.id.toLowerCase() === q || (m.provider + '/' + m.id).toLowerCase() === q
  })
  if (exact) return exact
  const matches = modelsCache.filter(function (m) {
    return m.id.toLowerCase().indexOf(q) !== -1 ||
      (m.name && m.name.toLowerCase().indexOf(q) !== -1)
  })
  return matches.length === 1 ? matches[0] : null
}

function copyLastAssistant () {
  const msgs = currentConv().messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(msgs[i].text)
        return true
      }
      return false
    }
  }
  return false
}

function runSlashCommand (cmd, arg) {
  const action = cmd.action || cmd.name
  switch (action) {
    case 'new':
      startNewChat()
      break
    case 'compact':
      requestCompact(arg)
      break
    case 'history':
      openHistoryDrawer()
      break
    case 'model':
      if (arg) {
        const match = findModelMatch(arg)
        if (match) setModel(match.provider, match.id)
        else openModelPopover(els.modelButton)
      } else {
        openModelPopover(els.modelButton)
      }
      break
    case 'thinking': {
      const level = String(arg || '').toLowerCase()
      if (level && THINKING_LABELS[level]) setThinkingLevel(level)
      else openThinkingPopover(els.thinkingButton)
      break
    }
    case 'name':
      if (!arg) {
        addSystemLine('Usage: /name <title>')
        return
      }
      ipc.invoke('agent-set-name', agentPayload({ name: arg })).then(function (result) {
        if (result && result.ok === false) addSystemLine(result.message || 'Could not name chat')
        else addSystemLine('Named this chat “' + arg + '”')
      }).catch(function () {
        addSystemLine('Could not name chat')
      })
      break
    case 'copy':
      if (copyLastAssistant()) addSystemLine('Copied last reply')
      else addSystemLine('Nothing to copy yet')
      break
    case 'settings':
      proSettingsPage.open()
      break
    case 'help':
      addSystemLine(agentSlash.helpText())
      break
    default:
      addSystemLine('Unknown command /' + cmd.name)
  }
}

function onComposerKeydown (e) {
  if (e.isComposing) return
  if (slashMenuOpen && slashItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSlashHighlight(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSlashHighlight(-1)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      selectSlashItem(slashItems[slashIndex])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      hideSlashMenu()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      selectSlashItem(slashItems[slashIndex])
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendCurrentInput()
  }
}

/* ----- actions ----- */

/* keep the send button enabled only when there is both a message and a chosen
model. While streaming, text sends a steer; an empty composer is the stop
button. */
function updateSendButton () {
  if (!els || !els.sendButton) return
  const hasText = !!(els.input && els.input.value.trim())
  if (!els.modelLabel.dataset.modelId) {
    els.modelLabel.dataset.modelId = 'anthropic/claude-3.5-sonnet'
    els.modelLabel.textContent = getModelLabel('anthropic/claude-3.5-sonnet')
  }
  const parsed = agentSlash.parseSubmit(els.input ? els.input.value : '')
  const stopMode = !!(isStreaming && !hasText && !parsed)
  if (stopMode) {
    els.sendButton.title = 'Stop'
    els.sendButton.classList.replace('codicon-arrow-up', 'codicon-debug-stop')
    els.sendButton.classList.add('streaming')
  } else {
    els.sendButton.title = (isStreaming && hasText) ? 'Steer' : 'Send'
    els.sendButton.classList.replace('codicon-debug-stop', 'codicon-arrow-up')
    els.sendButton.classList.remove('streaming')
  }
  els.sendButton.disabled = parsed ? false : (isStreaming ? false : !hasText)
}

function sendCurrentInput () {
  if (slashMenuOpen && slashItems.length) {
    selectSlashItem(slashItems[slashIndex])
    return
  }
  const parsed = agentSlash.parseSubmit(els.input.value)
  if (parsed) {
    els.input.value = ''
    els.input.style.height = 'auto'
    hideSlashMenu()
    updateSendButton()
    runSlashCommand(parsed.command, parsed.arg)
    return
  }
  const text = els.input.value.trim()
  if (!text) {
    if (isStreaming) ipc.send('agent-abort', agentPayload())
    return
  }
  if (!els.modelLabel.dataset.modelId) {
    els.modelLabel.dataset.modelId = 'anthropic/claude-3.5-sonnet'
    els.modelLabel.textContent = getModelLabel('anthropic/claude-3.5-sonnet')
  }
  els.input.value = ''
  els.input.style.height = 'auto'
  hideSlashMenu()
  addUserMessage(text)
  setStreamingUI(true)
  ipc.send('agent-prompt', agentPayload({ text: text }))
}

/* ----- event handling (from main/agent.js) ----- */

/* applies a backend event to the right task's cached transcript. DOM is
only touched when the event's task is the one currently shown. */
function applyEvent (ev) {
  if (!els || !ev || !ev.type) return
  const taskKey = (ev.taskId != null && ev.taskId !== '')
    ? String(ev.taskId)
    : 'default'
  const conv = convFor(taskKey)
  const active = taskKey === String(activeTaskId)
  switch (ev.type) {
    case 'delta':
      if (ev.deltaType === 'thinking' && ev.delta) {
        conv.thinking = (conv.thinking || '') + ev.delta
        if (active) {
          renderThinking(conv.thinking)
          scrollToEnd()
        }
        break
      }
      if (ev.deltaType === 'text' && ev.delta) {
        conv.thinking = ''
        if (active) renderThinking('')
        if (!conv.assistantMsg) {
          const last = conv.messages[conv.messages.length - 1]
          if (last && last.role === 'assistant') {
            conv.assistantMsg = last
          } else {
            conv.assistantMsg = { role: 'assistant', text: '' }
            conv.messages.push(conv.assistantMsg)
          }
          if (active) currentAssistantEl = makeAssistantBubble()
        }
        conv.assistantMsg.text += ev.delta
        if (active && currentAssistantEl) fillFormattedText(currentAssistantEl, conv.assistantMsg.text)
        if (active) scrollToEnd()
      }
      break
    case 'tool_start':
      if (conv.assistantMsg) conv.assistantMsg = null
      conv.thinking = ''
      if (active) renderThinking('')
      var toolsGroup = ensureToolsGroup(conv)
      toolsGroup.items.push({
        name: ev.toolName || 'tool',
        status: 'running',
        detail: ev.detail || ''
      })
      if (active) {
        renderWorkGroup(toolsGroup)
        scrollToEnd()
      }
      break
    case 'tool_end':
      var endGroup = null
      for (var i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === 'tools') {
          endGroup = conv.messages[i]
          break
        }
      }
      if (endGroup) {
        var running = null
        for (var j = endGroup.items.length - 1; j >= 0; j--) {
          if (endGroup.items[j].status === 'running' && (!ev.toolName || endGroup.items[j].name === ev.toolName)) {
            running = endGroup.items[j]
            break
          }
        }
        if (!running) {
          for (var k = endGroup.items.length - 1; k >= 0; k--) {
            if (endGroup.items[k].status === 'running') {
              running = endGroup.items[k]
              break
            }
          }
        }
        if (running) running.status = ev.isError ? 'error' : 'done'
        if (active) renderWorkGroup(endGroup)
      }
      break
    case 'agent_start':
      if (active) setStreamingUI(true)
      break
    case 'agent_end':
      conv.assistantMsg = null
      conv.thinking = ''
      if (active) {
        renderThinking('')
        currentAssistantEl = null
        setStreamingUI(false)
      }
      break
    case 'error':
      conv.assistantMsg = null
      conv.thinking = ''
      if (active) {
        renderThinking('')
        currentAssistantEl = null
        setStreamingUI(false)
        addErrorLine(ev.message || 'Unknown error')
      }
      break
    case 'session_reset':
      conv.messages = []
      conv.assistantMsg = null
      conv.thinking = ''
      if (active) {
        currentSessionPath = null
        syncSessionOwnership(getActiveTaskId(), null)
        clearActiveConversation()
      }
      break
    case 'context':
      if (active) updateContext(ev)
      break
    case 'context_cleared':
      if (active) updateContext(null)
      break
    case 'thinking_changed':
      if (active) applyThinkingUI(ev.level)
      break
    case 'compaction_start':
      if (active) setCompactingUI(true)
      break
    case 'compaction_end':
      if (active) {
        setCompactingUI(false)
        if (ev.errorMessage) addErrorLine(ev.errorMessage)
        if (ev.messages) {
          conv.messages = ev.messages
          conv.assistantMsg = null
          conv.thinking = ''
          renderThinking('')
          renderTranscript()
        }
      }
      break
  }
}

ipc.on('agent-event', function (e, ev) {
  applyEvent(ev)
})

/* pulls a task's persisted transcript + model/thinking/context from the
backend and renders it if it's the active task. */
async function refreshState () {
  const taskInfo = getTaskInfo()
  activeTaskId = taskInfo.taskId
  try {
    const state = await ipc.invoke('agent-get-state', agentPayload({ restore: true }))
    if (!state) return
    /* the state belongs to the task it was queried for - keep its ownership
    record correct even if the user moved to another task meanwhile */
    syncSessionOwnership(taskInfo.taskId, state.sessionPath)
    if (taskInfo.taskId === activeTaskId) {
      applyTaskState(state)
    } else {
      const conv = convFor(taskInfo.taskId)
      conv.messages = state.messages || []
      conv.assistantMsg = null
      conv.thinking = ''
    }
  } catch (e) {}
}

/* Re-scope the chat whenever the workspace or task changes. Workspace
 * switches also change the task, so de-duplicate the pair. */
function onTaskChange (taskId) {
  const nextTaskId = taskId != null && taskId !== ''
    ? String(taskId)
    : getActiveTaskId()
  if (nextTaskId === activeTaskId) return

  closeHistoryDrawer()
  hideSlashMenu()
  refreshState()
}

/* A workspace switch also changes the active task, so both events refetch
 * the task's state. */
function onWorkspaceChange () {
  refreshState()
}

async function initialize () {
  if (!panel || els) return
  buildUI()

  /* re-scope the chat whenever the task changes, like the other sidebar
  panels (file tree, git) re-scope on workspace change. activeTaskId is
  written with emit=false so 'workspace-updated' never fires for it - the
  inner TaskList's 'task-selected' is forwarded by the store instead. */
  workspaces.on('workspace-selected', onWorkspaceChange)
  workspaces.on('task-selected', function (taskId) {
    onTaskChange(taskId)
  })
  workspaces.on('workspace-updated', function (id, key) {
    if (key === 'activeTaskId') {
      onTaskChange(workspaces.get(id) && workspaces.get(id).activeTaskId)
    }
  })

  /* load the model catalog for the picker in the background */
  try {
    modelsCache = await ipc.invoke('agent-fetch-models') || []
  } catch (e) {
    modelsCache = []
  }

  await refreshState()
}

module.exports = { initialize: initialize }
