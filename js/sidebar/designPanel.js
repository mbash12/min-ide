/* global ipc, l, tasks, tabs, empty */
/* Design sidebar: engine controls are global; file and layer context follows
the active tab. Engine login / visibility live in Pro Settings. */

const panel = document.getElementById('sidebar-panel-design')

let lastStatus = null
let lastParsed = null
let lastParsedUrl = ''
let lastParsedTabId = null
let lastError = null
let lastResult = null
let lastResultKind = 'css'
let busy = false
let renderKey = ''
let statusRefreshGeneration = 0

function t (key, fallback) {
  const value = l(key)
  return typeof value === 'string' && value ? value : fallback
}

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function selectedTab () {
  if (!tabs) return null
  const id = tabs.getSelected()
  return id ? tabs.get(id) : null
}

function contextTabId () {
  return lastStatus && lastStatus.context ? lastStatus.context.tabId : null
}

function sameTab (a, b) {
  return a != null && b != null && String(a) === String(b)
}

function contextMatchesSelected () {
  const tab = selectedTab()
  const ctx = lastStatus && lastStatus.context
  return !!(tab && ctx && sameTab(ctx.tabId, tab.id))
}

function connectedToSelected () {
  const tab = selectedTab()
  const parsed = activeParsed()
  const ctx = lastStatus && lastStatus.context
  const bridge = lastStatus && lastStatus.bridge
  return !!(
    tab &&
    parsed &&
    parsed.isFigmaFile &&
    lastStatus &&
    lastStatus.running &&
    ctx &&
    ctx.fileKey === parsed.fileKey &&
    ctx.ready &&
    sameTab(ctx.tabId, tab.id) &&
    lastStatus.phase === 'connected' &&
    bridge &&
    bridge.pluginConnected &&
    bridge.fileKey === ctx.fileKey
  )
}

function pluginReady () {
  const ctx = lastStatus && lastStatus.context
  const bridge = lastStatus && lastStatus.bridge
  return !!(lastStatus && lastStatus.running && ctx && bridge && bridge.pluginConnected && bridge.fileKey === ctx.fileKey)
}

function needsLogin () {
  const parsed = activeParsed()
  return !!(parsed && parsed.isFigmaFile && contextMatchesSelected() && lastStatus.context.needsLogin)
}

function connectedTabIsLoading () {
  const parsed = activeParsed()
  const ctx = lastStatus && lastStatus.context
  return !!(parsed && parsed.isFigmaFile && contextMatchesSelected() && ctx.fileKey && !connectedToSelected())
}

function fileTitle (url, fileKey, tabTitle) {
  const match = String(url || '').match(/figma\.com\/(?:design|file|proto|board|deck)\/[^/]+\/([^/?#]+)/i)
  if (match) {
    try {
      return decodeURIComponent(match[1].replace(/\+/g, ' '))
    } catch (err) {
      return match[1]
    }
  }
  return tabTitle || fileKey || ''
}

function activeParsed () {
  const tab = selectedTab()
  if (!tab || !lastParsed || !sameTab(lastParsedTabId, tab.id)) return null
  const currentUrl = String(tab.url || '')
  if (lastParsedUrl !== currentUrl) {
    // Figma updates viewport/session query parameters while the same file is
    // open. Keep the parsed file context during that churn; the tab-updated
    // handler will replace it with the newest node id asynchronously.
    const currentFile = currentUrl.match(/figma\.com\/(?:design|file|proto|board|deck)\/([A-Za-z0-9]+)/i)
    if (!currentFile || currentFile[1] !== lastParsed.fileKey) return null
  }
  return lastParsed
}

function lifecycleState () {
  const parsed = activeParsed()
  const phase = lastStatus && lastStatus.phase
  if (lastStatus && lastStatus.engineLaunch && !lastStatus.running) return 'error'
  if (lastError && phase === 'error') return 'error'
  if (phase === 'login-needed' || needsLogin()) return 'login'
  if (phase === 'starting') return 'starting'
  if (phase === 'loading-engine') return 'loading-engine'
  if (phase === 'engine-ready') return 'engine-ready'
  if (phase === 'opening-tab') return 'opening-tab'
  if (phase === 'loading-tab') return 'loading-tab'
  if (phase === 'loading-plugin') return 'loading-plugin'
  if (phase === 'plugin-disconnected') return 'plugin-disconnected'
  if (phase === 'connected' && connectedToSelected()) return 'connected'
  if (busy) return 'starting'
  if (parsed && parsed.isFigmaFile) return 'idle'
  return lastStatus && lastStatus.running ? 'engine-ready' : 'empty'
}

function stateName () {
  return lifecycleState()
}

function statusCopy () {
  const name = lifecycleState()
  if (name === 'error') return (lastStatus && lastStatus.phaseError) || lastError || t('designStatusError', 'Something went wrong')
  if (name === 'login') return t('designStatusLogin', 'Sign in to Figma')
  if (name === 'starting') return t('designStatusStarting', 'Starting engine…')
  if (name === 'loading-engine') return t('designStatusLoadingEngine', 'Loading engine…')
  if (name === 'engine-ready') return t('designStatusEngineReady', 'Engine ready')
  if (name === 'opening-tab') return t('designStatusOpeningTab', 'Opening Figma tab…')
  if (name === 'loading-tab') return t('designStatusLoadingTab', 'Loading Figma tab…')
  if (name === 'loading-plugin') return t('designStatusLoadingPlugin', 'Loading plugin…')
  if (name === 'plugin-disconnected') return t('designStatusPluginDisconnected', 'Plugin disconnected')
  if (name === 'connected') return t('designStatusReady', 'Connected')
  if (name === 'idle') return t('designStatusIdle', 'Not connected')
  return t('designStatusEmpty', 'No Figma file')
}

function statusDetail () {
  const phase = lifecycleState()
  if (phase === 'error') return (lastStatus && lastStatus.phaseError) || lastError || t('designStatusError', 'Something went wrong')
  if (phase === 'connected') return t('designStatusAllReady', 'Engine, tab, and plugin ready')
  if (phase === 'plugin-disconnected') return t('designStatusPluginDisconnectedDetail', 'Engine and tab are ready, waiting for plugin')
  return t('designStatusPhaseDetail', 'Engine status: %s').replace('%s', statusCopy())
}

function statusDotClass () {
  const name = lifecycleState()
  if (name === 'connected') return 'ok'
  if (['starting', 'loading-engine', 'engine-ready', 'opening-tab', 'loading-tab', 'loading-plugin'].indexOf(name) !== -1) return 'busy'
  if (name === 'login' || name === 'plugin-disconnected' || name === 'error') return 'warn'
  return 'idle'
}

function rememberParsed (parsed, url, tabId) {
  const prevKey = lastParsed && lastParsed.fileKey
  const nextKey = parsed && parsed.fileKey
  if (prevKey && nextKey && prevKey !== nextKey) {
    lastResult = null
    lastError = null
  }
  lastParsed = parsed
  lastParsedUrl = String(url || '')
  lastParsedTabId = tabId != null
    ? tabId
    : (selectedTab() && selectedTab().id)
}

async function refreshStatus () {
  const generation = ++statusRefreshGeneration
  const tab = selectedTab()
  const tabId = tab && tab.id
  const url = tab && tab.url ? tab.url : ''
  try {
    const status = await ipc.invoke('figmaEngine:status')
    const parsed = await ipc.invoke('figmaEngine:parseUrl', url)
    // Lifecycle events and the 2.5s poll can overlap while Connect is
    // finishing. Do not let an older response overwrite the final connected
    // status; switching tabs starts a newer generation too.
    if (generation !== statusRefreshGeneration) return
    lastStatus = status
    const current = selectedTab()
    if (
      (tabId == null && !current) ||
      (
        current &&
        sameTab(tabId, current.id) &&
        String(current.url || '') === String(url || '')
      )
    ) {
      rememberParsed(parsed, url, tabId)
    }
  } catch (err) {
    if (generation !== statusRefreshGeneration) return
    lastError = err.message || String(err)
  }
  if (generation !== statusRefreshGeneration) return
  render()
}

function setBusy (value) {
  busy = value
  render()
}

function currentNodeId () {
  const node = selectedNode()
  return node && node.id ? node.id : null
}

function selectedNode () {
  const parsed = activeParsed()
  const bridgeSelection = lastStatus && lastStatus.bridge && lastStatus.bridge.selection
  if (
    connectedToSelected() &&
    pluginReady() &&
    parsed &&
    bridgeSelection &&
    bridgeSelection.fileKey === parsed.fileKey &&
    Array.isArray(bridgeSelection.nodes)
  ) {
    return bridgeSelection.nodes[0] || null
  }
  if (parsed && parsed.nodeId) return { id: parsed.nodeId }
  return null
}

function workspaceInfo () {
  const ws = tasks && tasks.getSelected ? tasks.getSelected() : null
  return {
    workspaceId: ws && ws.id,
    workspacePath: ws && ws.path
  }
}

async function connectSelectedTab () {
  const tab = selectedTab()
  if (!tab || busy) return
  const parsed = await ipc.invoke('figmaEngine:parseUrl', tab.url)
  if (!parsed || !parsed.isFigmaFile) {
    lastError = t('designNotFigma', 'Not a Figma file')
    render(true)
    return
  }
  const ws = workspaceInfo()
  setBusy(true)
  lastError = null
  lastResult = null
  try {
    const result = await ipc.invoke('figmaEngine:connect', {
      tabId: tab.id,
      url: tab.url,
      workspaceId: ws.workspaceId,
      workspacePath: ws.workspacePath
    })
    await refreshStatus()
    if (result && result.ok === false && !result.needsLogin) {
      const current = selectedTab()
      if (current && sameTab(current.id, tab.id)) {
        lastError = result.error || t('designConnectFailed', 'Connect failed')
      }
    }
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

async function disconnectSelectedTab () {
  if (busy) return
  setBusy(true)
  lastError = null
  try {
    await ipc.invoke('figmaEngine:disconnect', {
      tabId: selectedTab() && selectedTab().id
    })
    lastStatus = await ipc.invoke('figmaEngine:status')
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

async function runCommand (action, extra, kind) {
  if (!connectedToSelected() || !pluginReady()) return
  const nodeId = currentNodeId()
  lastResultKind = kind || lastResultKind
  setBusy(true)
  lastError = null
  lastResult = null
  const parsed = activeParsed()
  try {
    const result = await ipc.invoke('figmaBridge:command', action, Object.assign({
      nodeId: nodeId,
      fileKey: parsed && parsed.fileKey
    }, extra || {}))
    if (result && result.ok === false) {
      lastError = result.error || result.message || t('designCommandFailed', 'Command failed')
    } else {
      lastResult = result
    }
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

let exportModalOpen = false
let exportFormat = 'PNG'
let exportScale = 2
let exportDir = ''
let exportBusy = false

async function loadExportPrefs () {
  const ws = workspaceInfo()
  try {
    const prefs = await ipc.invoke('figmaEngine:getExportPrefs', { workspacePath: ws.workspacePath })
    exportDir = (prefs && prefs.effective) || (prefs && prefs.fallback) || ''
  } catch (e) {
    exportDir = ''
  }
}

async function openExportModal () {
  if (busy || !connectedToSelected() || !pluginReady()) return
  await loadExportPrefs()
  exportModalOpen = true
  exportBusy = false
  render(true)
}

function closeExportModal () {
  exportModalOpen = false
  exportBusy = false
  render(true)
}

async function browseExportDir () {
  try {
    const dirs = await ipc.invoke('showOpenDialog', {
      title: t('designExportDirTitle', 'Choose export folder'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: exportDir || undefined
    })
    if (dirs && dirs.length) {
      exportDir = dirs[0]
      render(true)
    }
  } catch (e) {}
}

async function confirmExport () {
  if (exportBusy || !exportDir) return
  exportBusy = true
  render(true)
  const nodeId = currentNodeId()
  const parsed = activeParsed()
  const ws = workspaceInfo()
  try {
    // Persist the chosen folder for this workspace so the next export opens
    // here again.
    await ipc.invoke('figmaEngine:setExportDir', {
      workspacePath: ws.workspacePath,
      dir: exportDir
    })
    const result = await ipc.invoke('figmaBridge:command', 'export', {
      nodeId: nodeId,
      fileKey: parsed && parsed.fileKey,
      format: exportFormat,
      scale: exportScale,
      target: 'asset',
      exportDir: exportDir
    })
    if (result && result.ok === false) {
      lastError = result.error || result.message || t('designCommandFailed', 'Command failed')
    } else {
      lastResult = result
      closeExportModal()
    }
  } catch (err) {
    lastError = err.message || String(err)
  }
  exportBusy = false
  render(true)
}

function exportModal () {
  if (!exportModalOpen) return null
  const wrap = el('div', 'design-modal-overlay')
  const box = el('div', 'design-modal')
  box.appendChild(el('div', 'design-modal-title', t('designExportTitle', 'Export asset')))

  const formatRow = el('div', 'design-modal-row')
  formatRow.appendChild(el('span', 'design-modal-label', t('designExportFormat', 'Format')))
  const formatSelect = el('select', 'design-modal-select')
  ;['PNG', 'JPG', 'SVG'].forEach(function (f) {
    const opt = el('option', null, f)
    opt.value = f
    if (f === exportFormat) opt.selected = true
    formatSelect.appendChild(opt)
  })
  formatSelect.addEventListener('change', function () {
    exportFormat = formatSelect.value
    render(true)
  })
  formatRow.appendChild(formatSelect)
  box.appendChild(formatRow)

  const scaleRow = el('div', 'design-modal-row')
  scaleRow.appendChild(el('span', 'design-modal-label', t('designExportScale', 'Scale')))
  const scaleSelect = el('select', 'design-modal-select')
  ;[1, 2, 3, 4].forEach(function (s) {
    const opt = el('option', null, s + '×')
    opt.value = String(s)
    if (s === exportScale) opt.selected = true
    scaleSelect.appendChild(opt)
  })
  scaleSelect.addEventListener('change', function () {
    exportScale = Number(scaleSelect.value)
    render(true)
  })
  scaleRow.appendChild(scaleSelect)
  box.appendChild(scaleRow)

  const dirRow = el('div', 'design-modal-row')
  dirRow.appendChild(el('span', 'design-modal-label', t('designExportDir', 'Folder')))
  const dirInput = el('input', 'design-modal-input')
  dirInput.type = 'text'
  dirInput.value = exportDir
  dirInput.placeholder = t('designExportDirPlaceholder', '/path/to/exports')
  dirInput.addEventListener('change', function () {
    exportDir = dirInput.value.trim()
  })
  dirRow.appendChild(dirInput)
  const browseBtn = el('button', 'design-modal-browse', t('designExportBrowse', 'Browse…'))
  browseBtn.type = 'button'
  browseBtn.addEventListener('click', function () { browseExportDir() })
  dirRow.appendChild(browseBtn)
  box.appendChild(dirRow)

  const actions = el('div', 'design-modal-actions')
  const cancelBtn = el('button', 'design-modal-btn', t('designCancel', 'Cancel'))
  cancelBtn.type = 'button'
  cancelBtn.addEventListener('click', closeExportModal)
  actions.appendChild(cancelBtn)
  const exportBtn = el('button', 'design-modal-btn primary', t('designExportConfirm', 'Export'))
  exportBtn.type = 'button'
  exportBtn.disabled = exportBusy || !exportDir
  exportBtn.addEventListener('click', confirmExport)
  actions.appendChild(exportBtn)
  box.appendChild(actions)

  wrap.appendChild(box)
  return wrap
}

function iconButton (icon, title, onClick, disabled) {
  const btn = el('button', 'codicon ' + icon + ' git-icon-button')
  btn.title = title
  btn.disabled = !!disabled
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (btn.disabled) return
    onClick()
  })
  return btn
}

function payloadOf (result) {
  if (!result) return null
  if (result.payload && typeof result.payload === 'object') return result.payload
  return result
}

function resultSections (result) {
  const payload = payloadOf(result)
  const sections = []
  if (!payload) return sections
  if (payload.path || result.path) {
    sections.push({
      id: 'file',
      label: t('designResultFile', 'File'),
      text: payload.path || result.path
    })
  }
  if (payload.css) {
    sections.push({ id: 'css', label: t('designResultCss', 'Style'), text: payload.css })
  }
  if (payload.textExtract) {
    sections.push({ id: 'text', label: t('designResultText', 'Text'), text: payload.textExtract })
  }
  if (payload.fontJson) {
    sections.push({ id: 'fonts', label: t('designResultFonts', 'Fonts'), text: payload.fontJson })
  }
  if (!sections.length && payload && typeof payload === 'object') {
    sections.push({
      id: 'css',
      label: t('designResultCss', 'Style'),
      text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    })
  }
  return sections
}

function buildResult (result) {
  const sections = resultSections(result)
  if (!sections.length) return null
  const wrap = el('div', 'design-result')
  wrap.appendChild(el('div', 'design-section-label', t('designResult', 'Result')))

  const tabsWrap = el('div', 'design-result-tabs')
  const body = el('pre', 'design-output')
  let active = lastResultKind
  if (!sections.some(function (s) { return s.id === active })) {
    active = sections[0].id
    lastResultKind = active
  }

  function show (id) {
    lastResultKind = id
    const section = sections.filter(function (s) { return s.id === id })[0] || sections[0]
    body.textContent = section.text
    Array.prototype.forEach.call(tabsWrap.children, function (btn) {
      btn.classList.toggle('active', btn.dataset.id === section.id)
    })
  }

  sections.forEach(function (section) {
    const btn = el('button', 'design-result-tab', section.label)
    btn.type = 'button'
    btn.dataset.id = section.id
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      show(section.id)
    })
    tabsWrap.appendChild(btn)
  })
  wrap.appendChild(tabsWrap)
  wrap.appendChild(body)
  show(active)
  return wrap
}

function connectButton () {
  const btn = el('button', 'design-connect-btn', t('designConnect', 'Connect'))
  btn.type = 'button'
  btn.title = t('designConnectHint', 'Runs the local plugin in the Figma engine.')
  btn.disabled = busy
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (btn.disabled) return
    connectSelectedTab()
  })
  return btn
}

function showEngineButton () {
  const btn = el('button', 'design-connect-btn', t('designShowEngineSignIn', 'Show engine to sign in'))
  btn.type = 'button'
  btn.title = t('designShowEngineSignInHint', 'Opens the Figma engine window so you can sign in, then Connect again.')
  btn.disabled = busy || !(lastStatus && lastStatus.running)
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (btn.disabled) return
    ipc.invoke('figmaEngine:setVisible', { visible: true }).then(refreshStatus)
  })
  return btn
}

function contextRow (label, value, empty) {
  const row = el('div', 'design-context-row' + (empty ? ' empty' : ''))
  row.appendChild(el('span', 'design-context-label', label))
  const valueEl = el('span', 'design-context-value', value)
  valueEl.title = value
  row.appendChild(valueEl)
  return row
}

function selectedNodeText (node) {
  if (!node) return t('designNoNode', 'No layer selected — click a frame in the tab')
  if (node.name && node.id && node.name !== node.id) return node.name + ' (' + node.id + ')'
  return node.name || node.id || t('designNoNode', 'No layer selected — click a frame in the tab')
}

function buildTabContext () {
  const context = el('div', 'design-context')
  context.appendChild(el('div', 'design-context-title', t('designTab', 'Tab')))

  const tab = selectedTab()
  const parsed = activeParsed()
  if (!tab || !parsed || !parsed.isFigmaFile) {
    context.appendChild(contextRow(
      t('designFigmaFile', 'Figma file'),
      tab && tab.url ? t('designNotFigma', 'Not a Figma file') : t('designStatusEmpty', 'No Figma file'),
      true
    ))
    return context
  }

  const title = fileTitle(tab.url, parsed.fileKey, tab.title) || t('designFigmaFile', 'Figma file')
  context.appendChild(contextRow(t('designFigmaFile', 'Figma file'), title, false))
  const node = selectedNode()
  context.appendChild(contextRow(
    t('designSelectedNode', 'Selected'),
    selectedNodeText(node),
    !node
  ))
  return context
}

function buildHeader () {
  const header = el('div', 'file-tree-header design-header')
  header.appendChild(el('div', 'file-tree-title', t('sidebarDesign', 'Design')))

  const status = el('div', 'design-toolbar-status')
  status.title = statusDetail()
  status.appendChild(el('span', 'design-dot ' + statusDotClass()))
  const copy = el('span', 'design-toolbar-copy')
  copy.appendChild(el('span', 'design-toolbar-label', statusCopy()))
  status.appendChild(copy)
  header.appendChild(status)

  const actions = el('div', 'file-tree-header-actions')
  const isFigma = !!(activeParsed() && activeParsed().isFigmaFile)
  const scoped = connectedToSelected()
  const stuck = !!(activeParsed() && activeParsed().isFigmaFile && connectedTabIsLoading())
  const canRun = scoped && pluginReady() && !busy && !needsLogin()

  if (needsLogin()) {
    actions.appendChild(showEngineButton())
  }
  if ((isFigma && !scoped) || stuck || needsLogin()) {
    actions.appendChild(connectButton())
  }
  if (scoped) {
    actions.appendChild(iconButton(
      'codicon-debug-disconnect',
      t('designDisconnect', 'Disconnect'),
      disconnectSelectedTab,
      busy
    ))
  }
  actions.appendChild(iconButton(
    'codicon-device-camera',
    t('designExport', 'Export PNG'),
    openExportModal,
    !canRun
  ))
  actions.appendChild(iconButton(
    'codicon-text-size',
    t('designExtractText', 'Extract text'),
    function () { runCommand('node-data', {}, 'text') },
    !canRun
  ))
  actions.appendChild(iconButton(
    'codicon-symbol-color',
    t('designExtractStyle', 'Extract styles'),
    function () { runCommand('node-data', {}, 'css') },
    !canRun
  ))
  header.appendChild(actions)
  return header
}

function fingerprint () {
  const parsed = activeParsed() || {}
  const node = selectedNode() || {}
  const payload = payloadOf(lastResult)
  const tab = selectedTab()
  return [
    stateName(),
    tab ? tab.id : '',
    contextTabId() || '',
    parsed.fileKey || '',
    parsed.nodeId || '',
    node.id || '',
    node.name || '',
    lastError || '',
    payload && (payload.path || payload.css || payload.textExtract)
      ? String((payload.path || '') + (payload.css || '') + (payload.textExtract || '')).length
      : '',
    busy ? 'busy' : 'idle',
    !!(lastStatus && lastStatus.running),
    pluginReady()
  ].join('|')
}

function render (force) {
  const key = fingerprint()
  if (!force && key === renderKey && panel.childNodes.length) return
  renderKey = key

  empty(panel)
  panel.appendChild(buildHeader())

  const body = el('div', 'design-body')
  panel.appendChild(body)
  body.appendChild(buildTabContext())

  if (lastError) {
    body.appendChild(el('div', 'design-error', lastError))
  }

  if (connectedToSelected()) {
    const result = buildResult(lastResult)
    if (result) body.appendChild(result)
  }

  const modal = exportModal()
  if (modal) panel.appendChild(modal)
}

const designPanel = {
  initialize: function () {
    empty(panel)
    render(true)

    ipc.on('figma-engine-event', function (e, ev) {
      if (!ev || typeof ev !== 'object') return
      // Event-driven refresh: main emits on every lifecycle transition so the
      // panel does not sit on a stale "Starting…" state between polls.
      if (ev.error && !lastError) lastError = ev.error
      refreshStatus()
    })

    tasks.on('tab-selected', function () {
      lastParsed = null
      lastParsedUrl = ''
      lastParsedTabId = null
      lastResult = null
      lastError = null
      render()
      refreshStatus()
    })
    tasks.on('tab-updated', function (id, key, value) {
      if (key !== 'url') return
      ipc.invoke('figmaEngine:syncUrl', { tabId: id, url: value })
      if (!tabs || !sameTab(id, tabs.getSelected())) return
      render()
      ipc.invoke('figmaEngine:parseUrl', value).then(function (parsed) {
        const current = selectedTab()
        if (
          !current ||
          !sameTab(id, current.id) ||
          String(current.url || '') !== String(value || '')
        ) return
        rememberParsed(parsed, value, id)
        render()
      })
    })
    tasks.on('tab-destroyed', function (id) {
      ipc.invoke('figmaEngine:disconnect', { tabId: id }).then(function (result) {
        if (result && result.ignored) return
        refreshStatus()
      })
    })
    tasks.on('task-selected', function () {
      refreshStatus()
    })
    tasks.on('workspace-selected', function () {
      refreshStatus()
    })

    refreshStatus()
    setInterval(function () {
      if (panel.classList.contains('active')) refreshStatus()
    }, 2500)
  }
}

module.exports = designPanel
