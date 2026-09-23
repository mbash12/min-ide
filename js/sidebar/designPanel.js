/* global ipc, l, tasks, tabs, empty */
/* Design sidebar: engine controls are global; file and layer context follows
the active tab. The engine uses the Figma session from the Min tab. */

const panel = document.getElementById('sidebar-panel-design')

let lastStatus = null
let lastParsed = null
let lastParsedUrl = ''
let lastParsedTabId = null
let lastError = null
let lastResult = null
let lastResultKind = 'css'
let resultModalOpen = false
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
  const ws = (typeof workspaces !== 'undefined' && workspaces.getSelected) ? workspaces.getSelected() : null
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
      resultModalOpen = true
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

/* Design spec (build list) state — the list of Figma objects to implement,
each with variants pinned to a node id and a target viewport. */
let spec = { entries: [] }
let specWorkspace = ''
const specExpanded = {}
let specAddOpen = false
let variantFormFor = null
let variantEditFor = null // 'entryId|variantId'
let importModalOpen = false
let importFrames = null
let exportingFor = null // 'entryId|variantId'
let overlayState = null
let overlayTabId = null

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
      resultModalOpen = true
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

/* Results open as a modal — an inline pre would eat the build list's space. */
function buildResultModal () {
  if (!resultModalOpen) return null
  const sections = resultSections(lastResult)
  if (!sections.length) {
    resultModalOpen = false
    return null
  }
  const wrap = el('div', 'design-modal-overlay')
  const box = el('div', 'design-modal design-result-modal')

  const head = el('div', 'design-modal-head')
  head.appendChild(el('div', 'design-modal-title', t('designResult', 'Result')))
  const closeBtn = iconButton('codicon-close', t('designClose', 'Close'), function () {
    resultModalOpen = false
    lastResult = null
    render(true)
  })
  head.appendChild(closeBtn)
  box.appendChild(head)

  const tabsWrap = el('div', 'design-result-tabs')
  const body = el('pre', 'design-output design-modal-output')
  let active = lastResultKind
  if (!sections.some(function (s) { return s.id === active })) {
    active = sections[0].id
    lastResultKind = active
  }

  function activeSection () {
    return sections.filter(function (s) { return s.id === lastResultKind })[0] || sections[0]
  }

  function show (id) {
    lastResultKind = id
    body.textContent = activeSection().text
    Array.prototype.forEach.call(tabsWrap.children, function (btn) {
      btn.classList.toggle('active', btn.dataset.id === activeSection().id)
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
  box.appendChild(tabsWrap)
  box.appendChild(body)

  const actions = el('div', 'design-modal-actions')
  const copyBtn = el('button', 'design-modal-btn primary', t('designCopy', 'Copy'))
  copyBtn.type = 'button'
  copyBtn.addEventListener('click', function () {
    const text = activeSection().text
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {})
    }
  })
  actions.appendChild(copyBtn)
  box.appendChild(actions)

  wrap.appendChild(box)
  show(active)
  return wrap
}

function cardConnectButton () {
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

/* Compact pipeline indicator: engine → file → plugin, each a single icon with
a state dot. Detail text lives in tooltips instead of extra rows; the header
stays an icon bar like the other sidebar panels. */
function statusIndicator (icon, state, tip) {
  const ind = el('span', 'design-ind state-' + state)
  ind.appendChild(el('span', 'codicon ' + icon))
  ind.appendChild(el('span', 'design-ind-dot'))
  ind.title = tip
  return ind
}

function buildStatusCard () {
  const card = el('div', 'design-status')
  const tab = selectedTab()
  const parsed = activeParsed()
  const isFigma = !!(parsed && parsed.isFigmaFile)
  const engineOn = !!(lastStatus && lastStatus.running)
  const ctx = lastStatus && lastStatus.context
  const fileReady = !!(ctx && ctx.fileKey && ctx.ready)
  const pluginOn = pluginReady()

  const top = el('div', 'design-status-top')
  top.appendChild(statusIndicator(
    'codicon-server-environment',
    engineOn ? 'on' : 'off',
    engineOn ? t('designIndEngineOn', 'Engine running') : t('designIndEngineOff', 'Engine not running')
  ))
  top.appendChild(statusIndicator(
    'codicon-window',
    fileReady ? 'on' : (engineOn ? 'warn' : 'off'),
    fileReady
      ? t('designIndFileOn', 'File open in engine')
      : (engineOn ? t('designIndFileWarn', 'No file open in engine') : t('designIndEngineOff', 'Engine not running'))
  ))
  top.appendChild(statusIndicator(
    'codicon-extensions',
    pluginOn ? 'on' : (fileReady ? 'warn' : 'off'),
    pluginOn
      ? t('designIndPluginOn', 'Plugin connected')
      : (fileReady ? t('designIndPluginWarn', 'Waiting for plugin…') : t('designIndPluginOff', 'Plugin not connected'))
  ))
  const transport = lastStatus && lastStatus.bridge && lastStatus.bridge.transport
  top.appendChild(statusIndicator(
    transport === 'ws' ? 'codicon-radio-tower' : 'codicon-sync',
    transport === 'ws' ? 'on' : (transport === 'poll' ? 'busy' : 'off'),
    transport === 'ws'
      ? t('designIndLinkWs', 'Link: WebSocket')
      : (transport === 'poll' ? t('designIndLinkPoll', 'Link: HTTP polling') : t('designIndLinkOff', 'Link: offline'))
  ))

  // No persistent status text — the dots carry it. Errors still need words,
  // so only the error state gets a label.
  if (lifecycleState() === 'error') {
    const label = el('span', 'design-status-label', statusCopy())
    label.title = statusCopy()
    top.appendChild(label)
  }

  const actions = el('div', 'design-status-actions')
  // One button slot swaps Connect ↔ Disconnect so the card never grows a row.
  if (connectedToSelected()) {
    const btn = el('button', 'design-connect-btn', t('designDisconnect', 'Disconnect'))
    btn.type = 'button'
    btn.disabled = busy
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (btn.disabled) return
      disconnectSelectedTab()
    })
    actions.appendChild(btn)
  } else if (isFigma || connectedTabIsLoading() || needsLogin()) {
    actions.appendChild(cardConnectButton())
  }
  if (actions.childNodes.length) top.appendChild(actions)
  card.appendChild(top)
  if (needsLogin()) {
    card.appendChild(el('div', 'design-status-label', t('designLoginInTabHint', 'Sign in to Figma in this tab, then Connect again.')))
  }

  if (tab && isFigma) {
    const file = el('div', 'design-status-file')
    file.appendChild(el('span', 'codicon codicon-file design-status-icon'))
    const fileName = el('span', 'design-status-file-name', fileTitle(tab.url, parsed.fileKey, tab.title))
    fileName.title = fileName.textContent
    file.appendChild(fileName)
    const node = selectedNode()
    if (node) {
      file.appendChild(el('span', 'codicon codicon-layers design-status-icon'))
      const nodeEl = el('span', 'design-status-node', selectedNodeText(node))
      nodeEl.title = selectedNodeText(node)
      file.appendChild(nodeEl)
    }
    card.appendChild(file)
  }
  return card
}

function selectedNodeText (node) {
  if (!node) return ''
  if (node.name && node.id && node.name !== node.id) return node.name + ' (' + node.id + ')'
  return node.name || node.id || ''
}

/* --- build list (design spec) ------------------------------------------- */

let specUnavailable = false

function specFail (err) {
  lastError = (err && err.message) || String(err)
  render(true)
}

async function refreshSpec () {
  const ws = workspaceInfo()
  const key = ws.workspacePath || 'default'
  try {
    const result = await ipc.invoke('designSpec:list', { workspacePath: ws.workspacePath })
    if (key === (workspaceInfo().workspacePath || 'default')) {
      spec = (result && result.doc) || { entries: [] }
      specWorkspace = key
      specUnavailable = false
    }
  } catch (e) {
    // Old main process without designSpec handlers — flag it so the section
    // can hint at a restart instead of looking broken.
    specUnavailable = true
  }
}

async function refreshOverlay () {
  const tab = selectedTab()
  overlayTabId = tab ? tab.id : null
  try {
    overlayState = tab ? await ipc.invoke('designOverlay:get', { tabId: tab.id }) : null
  } catch (e) {
    overlayState = null
  }
}

function overlayActiveFor (entryId, variantId) {
  const tab = selectedTab()
  return !!(overlayState && overlayState.active && tab && sameTab(overlayTabId, tab.id) &&
    overlayState.entryId === entryId && overlayState.variantId === variantId)
}

async function ensureVariantImage (entry, variant) {
  if (variant.image) return { path: variant.image, cssWidth: variant.cssWidth }
  if (!variant.nodeId) return { error: t('designVariantNoNode', 'Variant has no Figma node — edit the node id first') }
  if (!connectedToSelected() || !pluginReady()) {
    return { error: t('designNeedConnect', 'Connect Figma first to export the design') }
  }
  exportingFor = entry.id + '|' + variant.id
  render(true)
  try {
    return await exportVariantImage(entry, variant)
  } finally {
    exportingFor = null
    render(true)
  }
}

async function exportVariantImage (entry, variant) {
  const parsed = activeParsed()
  const result = await ipc.invoke('figmaBridge:command', 'export', {
    nodeId: variant.nodeId,
    fileKey: parsed && parsed.fileKey,
    format: 'PNG',
    scale: 2,
    fileName: entry.name + '-' + variant.label
  })
  const payload = result && result.payload
  if (!result || result.ok === false || !payload || !payload.path) {
    return { error: (result && (result.error || result.message)) || t('designExportFailed', 'Export failed') }
  }
  const effScale = payload.scale || 2
  const cssWidth = payload.node && payload.node.width ? Math.round(payload.node.width / effScale) : null
  const cssHeight = payload.node && payload.node.height ? Math.round(payload.node.height / effScale) : null
  const patch = { image: payload.path, cssWidth: cssWidth }
  const vp = variant.viewport || {}
  if (cssWidth && cssHeight && (vp.w !== cssWidth || vp.h !== cssHeight)) {
    patch.viewport = { w: cssWidth, h: cssHeight, mobile: !!vp.mobile, dpr: vp.dpr }
  }
  await ipc.invoke('designSpec:variantUpdate', {
    workspacePath: workspaceInfo().workspacePath,
    entryId: entry.id,
    variantId: variant.id,
    patch: patch
  })
  variant.image = payload.path
  variant.cssWidth = cssWidth
  if (patch.viewport) variant.viewport = patch.viewport
  return { path: payload.path, cssWidth: cssWidth }
}

async function toggleVariantOverlay (entry, variant) {
  const tab = selectedTab()
  if (!tab || busy) return
  setBusy(true)
  lastError = null
  try {
    if (overlayActiveFor(entry.id, variant.id)) {
      await ipc.invoke('designOverlay:clear', { tabId: tab.id })
    } else {
      const image = await ensureVariantImage(entry, variant)
      if (image.error) {
        lastError = image.error
      } else {
        const result = await ipc.invoke('designOverlay:set', {
          tabId: tab.id,
          image: image.path,
          cssWidth: image.cssWidth,
          label: entry.name + ' / ' + variant.label,
          viewport: variant.viewport,
          entryId: entry.id,
          variantId: variant.id
        })
        if (result && result.ok === false) lastError = result.error
      }
    }
    await refreshOverlay()
    await refreshSpec()
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

async function refreshVariantImage (entry, variant) {
  if (busy) return
  setBusy(true)
  lastError = null
  try {
    variant.image = null
    const image = await ensureVariantImage(entry, variant)
    if (image.error) lastError = image.error
    await refreshSpec()
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

async function openImportModal () {
  if (busy || !connectedToSelected() || !pluginReady()) return
  setBusy(true)
  lastError = null
  try {
    const parsed = activeParsed()
    const result = await ipc.invoke('figmaBridge:command', 'list-frames', {
      fileKey: parsed && parsed.fileKey
    })
    const payload = result && result.payload
    if (result && result.ok === false) {
      lastError = result.error || t('designCommandFailed', 'Command failed')
    } else {
      importFrames = (payload && payload.frames) || []
      importModalOpen = true
    }
  } catch (err) {
    lastError = err.message || String(err)
  }
  setBusy(false)
}

async function addEntry (name, kind, nodeId) {
  const parsed = activeParsed()
  const tab = selectedTab()
  const ws = workspaceInfo()
  try {
    const result = await ipc.invoke('designSpec:add', {
      workspacePath: ws.workspacePath,
      name: name,
      kind: kind,
      figmaUrl: tab && parsed && parsed.isFigmaFile ? tab.url : null,
      fileKey: parsed && parsed.fileKey,
      nodeId: nodeId || (parsed && parsed.nodeId)
    })
    if (result && result.ok === false) {
      lastError = result.error || t('designCommandFailed', 'Command failed')
    } else {
      specAddOpen = false
    }
  } catch (err) {
    // Missing IPC handler (old main bundle) lands here — surface it instead
    // of dying silently.
    lastError = err.message || String(err)
  }
  await refreshSpec()
  render(true)
}

function variantViewportText (variant) {
  const vp = variant.viewport || {}
  // Before the first export the w×h are just preset guesses — show the preset
  // name instead of fake numbers. Real dims arrive with the image.
  const dims = variant.image && vp.w && vp.h
    ? vp.w + '×' + vp.h
    : t('designViewport_' + viewportPresetOf(variant), viewportPresetOf(variant))
  return dims + (vp.mobile && viewportPresetOf(variant) !== 'mobile' ? ' · ' + t('designViewportMobile', 'mobile') : '')
}

function buildVariantRow (entry, variant) {
  const row = el('div', 'design-variant' + (overlayActiveFor(entry.id, variant.id) ? ' overlay-active' : ''))

  const isExporting = exportingFor === entry.id + '|' + variant.id
  const thumb = el('div', 'design-variant-thumb' + (isExporting ? ' exporting' : ''))
  if (isExporting) {
    thumb.appendChild(el('span', 'codicon codicon-loading codicon-modifier-spin'))
  } else if (variant.image) {
    const img = document.createElement('img')
    img.alt = variant.label
    thumb.appendChild(img)
    ipc.invoke('designOverlay:imageData', { path: variant.image }).then(function (data) {
      if (data) img.src = data
      else thumb.classList.add('empty')
    })
  } else {
    thumb.classList.add('empty')
    thumb.appendChild(el('span', 'codicon ' + (variant.viewport && variant.viewport.mobile ? 'codicon-device-mobile' : 'codicon-device-desktop')))
  }
  row.appendChild(thumb)

  const info = el('div', 'design-variant-info')
  info.appendChild(el('div', 'design-variant-label', variant.label))
  const meta = el('div', 'design-variant-meta')
  meta.appendChild(document.createTextNode(variantViewportText(variant)))
  if (variant.nodeId) {
    const nid = el('span', 'design-variant-node', variant.nodeId)
    nid.title = variant.nodeId
    meta.appendChild(nid)
  }
  info.appendChild(meta)
  row.appendChild(info)

  const actions = el('div', 'design-variant-actions')
  // Overlay only makes sense once the design image exists — and never on the
  // Figma tab itself (that IS the design). Hidden entirely when unusable;
  // stays visible while active so it can be turned off.
  const targetIsFigma = !!(activeParsed() && activeParsed().isFigmaFile)
  const overlayOn = overlayActiveFor(entry.id, variant.id)
  if (overlayOn || (variant.image && !targetIsFigma)) {
    const overlayBtn = iconButton(
      overlayOn ? 'codicon-eye-closed' : 'codicon-eye',
      overlayOn ? t('designOverlayHide', 'Hide design overlay') : t('designOverlayShow', 'Overlay design on this tab'),
      function () { toggleVariantOverlay(entry, variant) },
      busy
    )
    overlayBtn.classList.add('design-overlay-toggle')
    actions.appendChild(overlayBtn)
  }
  actions.appendChild(iconButton(
    isExporting ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh',
    isExporting
      ? t('designExporting', 'Exporting…')
      : (variant.image
        ? t('designVariantRefresh', 'Re-export from Figma')
        : t('designVariantExport', 'Export from Figma')),
    function () { refreshVariantImage(entry, variant) },
    busy || !variant.nodeId
  ))
  actions.appendChild(iconButton(
    'codicon-edit',
    t('designVariantEdit', 'Edit variant'),
    function () {
      const key = entry.id + '|' + variant.id
      variantEditFor = variantEditFor === key ? null : key
      variantFormFor = null
      render(true)
    },
    busy
  ))
  actions.appendChild(iconButton(
    'codicon-close',
    t('designVariantRemove', 'Remove variant'),
    function () {
      ipc.invoke('designSpec:variantRemove', {
        workspacePath: workspaceInfo().workspacePath,
        entryId: entry.id,
        variantId: variant.id
      }).then(refreshSpec).then(function () { render(true) }).catch(specFail)
    },
    busy
  ))
  row.appendChild(actions)
  return row
}

function viewportPresetOf (variant) {
  const vp = variant && variant.viewport
  if (!vp) return 'desktop'
  if (vp.mobile && vp.w === 414) return 'mobile'
  if (!vp.mobile && vp.w === 1440) return 'desktop'
  return 'custom'
}

/* Fills the node id — and the real frame size, which the plugin pushes with
the selection — so desktop and mobile variants can point at different frames. */
function useSelectedButton (nodeInput, viewportCtl) {
  const btn = el('button', 'design-form-cancel design-use-selected', t('designUseSelected', 'Use selected'))
  btn.type = 'button'
  btn.title = t('designUseSelectedHint', 'Fill with the layer selected in Figma')
  btn.addEventListener('click', function () {
    const node = selectedNode()
    if (!node || !node.id) return
    nodeInput.value = node.id
    if (viewportCtl && node.width && node.height) {
      viewportCtl.vpSelect.value = 'custom'
      viewportCtl.wInput.value = Math.round(node.width)
      viewportCtl.hInput.value = Math.round(node.height)
      viewportCtl.sizeWrap.style.display = ''
    }
  })
  return btn
}

function buildVariantForm (entry, variant) {
  const editing = !!variant
  const form = el('div', 'design-variant-form')
  const labelInput = el('input', 'design-form-input')
  labelInput.type = 'text'
  labelInput.placeholder = t('designVariantLabel', 'Label (e.g. Hover state)')
  labelInput.value = editing ? variant.label : ''
  const nodeInput = el('input', 'design-form-input')
  nodeInput.type = 'text'
  nodeInput.placeholder = t('designVariantNode', 'Node id (e.g. 12:34)')
  nodeInput.value = editing ? (variant.nodeId || '') : (entry.nodeId || '')
  const vpSelect = el('select', 'design-form-select')
  ;['desktop', 'mobile', 'custom'].forEach(function (v) {
    const opt = el('option', null, t('designViewport_' + v, v[0].toUpperCase() + v.slice(1)))
    opt.value = v
    vpSelect.appendChild(opt)
  })
  const sizeWrap = el('div', 'design-variant-size')
  const wInput = el('input', 'design-form-input')
  wInput.type = 'number'
  wInput.placeholder = 'W'
  const hInput = el('input', 'design-form-input')
  hInput.type = 'number'
  hInput.placeholder = 'H'
  sizeWrap.appendChild(wInput)
  sizeWrap.appendChild(el('span', 'design-form-x', '×'))
  sizeWrap.appendChild(hInput)
  const preset = viewportPresetOf(variant)
  vpSelect.value = preset
  if (editing && preset === 'custom' && variant.viewport) {
    wInput.value = variant.viewport.w
    hInput.value = variant.viewport.h
  }
  sizeWrap.style.display = preset === 'custom' ? '' : 'none'
  vpSelect.addEventListener('change', function () {
    sizeWrap.style.display = vpSelect.value === 'custom' ? '' : 'none'
  })
  const saveBtn = el('button', 'design-connect-btn', editing ? t('designSaveVariant', 'Save') : t('designAddVariant', 'Add variant'))
  saveBtn.type = 'button'
  saveBtn.addEventListener('click', function () {
    const viewport = vpSelect.value === 'custom'
      ? (wInput.value + 'x' + hInput.value)
      : vpSelect.value
    const done = function () {
      variantFormFor = null
      variantEditFor = null
      render(true)
      // The main process fetches the node's real dims in the background —
      // refresh once more so the row shows them without another click.
      setTimeout(function () { refreshSpec().then(function () { render(true) }) }, 1200)
    }
    if (editing) {
      ipc.invoke('designSpec:variantUpdate', {
        workspacePath: workspaceInfo().workspacePath,
        entryId: entry.id,
        variantId: variant.id,
        patch: {
          label: labelInput.value.trim(),
          nodeId: nodeInput.value.trim(),
          viewport: viewport
        }
      }).then(refreshSpec).then(done).catch(specFail)
    } else {
      ipc.invoke('designSpec:variantAdd', {
        workspacePath: workspaceInfo().workspacePath,
        entryId: entry.id,
        label: labelInput.value.trim(),
        nodeId: nodeInput.value.trim() || null,
        viewport: viewport
      }).then(refreshSpec).then(done).catch(specFail)
    }
  })
  const cancelBtn = el('button', 'design-form-cancel', t('designCancel', 'Cancel'))
  cancelBtn.type = 'button'
  cancelBtn.addEventListener('click', function () { variantFormFor = null; variantEditFor = null; render(true) })
  const viewportCtl = { vpSelect: vpSelect, wInput: wInput, hInput: hInput, sizeWrap: sizeWrap }
  form.appendChild(labelInput)
  const nodeRow = el('div', 'design-variant-form-row')
  nodeRow.appendChild(nodeInput)
  nodeRow.appendChild(useSelectedButton(nodeInput, viewportCtl))
  form.appendChild(nodeRow)
  const vpRow = el('div', 'design-variant-form-row')
  vpRow.appendChild(vpSelect)
  vpRow.appendChild(sizeWrap)
  form.appendChild(vpRow)
  const btnRow = el('div', 'design-variant-form-row')
  btnRow.appendChild(saveBtn)
  btnRow.appendChild(cancelBtn)
  form.appendChild(btnRow)
  return form
}

function buildEntryRow (entry) {
  const wrap = el('div', 'design-entry')
  const expanded = !!specExpanded[entry.id]

  const head = el('div', 'design-entry-head')
  const chevron = iconButton(
    expanded ? 'codicon-chevron-down' : 'codicon-chevron-right',
    '',
    function () { specExpanded[entry.id] = !expanded; render(true) }
  )
  chevron.classList.add('design-entry-chevron')
  head.appendChild(chevron)

  const titleWrap = el('div', 'design-entry-title-wrap')
  const title = el('span', 'design-entry-title', entry.name)
  title.title = entry.figmaUrl || entry.name
  titleWrap.appendChild(title)
  head.appendChild(titleWrap)

  const actions = el('div', 'design-entry-actions')
  actions.appendChild(iconButton(
    'codicon-add',
    t('designAddVariant', 'Add variant'),
    function () { variantFormFor = variantFormFor === entry.id ? null : entry.id; render(true) }
  ))
  actions.appendChild(iconButton(
    'codicon-trash',
    t('designRemoveEntry', 'Remove entry'),
    function () {
      ipc.invoke('designSpec:remove', {
        workspacePath: workspaceInfo().workspacePath,
        entryId: entry.id
      }).then(refreshSpec).then(function () { render(true) }).catch(specFail)
    }
  ))
  head.appendChild(actions)
  head.addEventListener('click', function () {
    specExpanded[entry.id] = !expanded
    render(true)
  })
  wrap.appendChild(head)

  if (expanded) {
    const variants = el('div', 'design-variants')
    ;(entry.variants || []).forEach(function (variant) {
      variants.appendChild(buildVariantRow(entry, variant))
      if (variantEditFor === entry.id + '|' + variant.id) {
        variants.appendChild(buildVariantForm(entry, variant))
      }
    })
    if (!entry.variants || !entry.variants.length) {
      variants.appendChild(el('div', 'design-variant-empty', t('designNoVariants', 'No variants yet')))
    }
    if (variantFormFor === entry.id) variants.appendChild(buildVariantForm(entry))
    wrap.appendChild(variants)
  }
  return wrap
}

function buildSpecAddForm () {
  const form = el('div', 'design-entry-form')
  const nameInput = el('input', 'design-form-input')
  nameInput.type = 'text'
  nameInput.placeholder = t('designEntryName', 'Name (e.g. Login page)')
  const parsed = activeParsed()
  const nodeInput = el('input', 'design-form-input')
  nodeInput.type = 'text'
  nodeInput.placeholder = t('designVariantNode', 'Node id (e.g. 12:34)')
  nodeInput.value = (parsed && parsed.nodeId) || ''
  const nodeRow = el('div', 'design-variant-form-row')
  nodeRow.appendChild(nodeInput)
  nodeRow.appendChild(useSelectedButton(nodeInput))
  const kindSelect = el('select', 'design-form-select')
  ;['page', 'component', 'element'].forEach(function (k) {
    const opt = el('option', null, t('designKind_' + k, k[0].toUpperCase() + k.slice(1)))
    opt.value = k
    kindSelect.appendChild(opt)
  })
  const addBtn = el('button', 'design-connect-btn', t('designAddEntry', 'Add'))
  addBtn.type = 'button'
  addBtn.addEventListener('click', function () {
    if (!nameInput.value.trim()) return
    addEntry(nameInput.value.trim(), kindSelect.value, nodeInput.value.trim() || null)
  })
  const cancelBtn = el('button', 'design-form-cancel', t('designCancel', 'Cancel'))
  cancelBtn.type = 'button'
  cancelBtn.addEventListener('click', function () { specAddOpen = false; render(true) })
  form.appendChild(nameInput)
  form.appendChild(nodeRow)
  form.appendChild(kindSelect)
  const btnRow = el('div', 'design-variant-form-row')
  btnRow.appendChild(addBtn)
  btnRow.appendChild(cancelBtn)
  form.appendChild(btnRow)
  return form
}

function buildImportModal () {
  if (!importModalOpen) return null
  const wrap = el('div', 'design-modal-overlay')
  const box = el('div', 'design-modal')
  box.appendChild(el('div', 'design-modal-title', t('designImportTitle', 'Import from Figma')))
  const list = el('div', 'design-import-list')
  if (!importFrames || !importFrames.length) {
    list.appendChild(el('div', 'design-import-empty', t('designImportEmpty', 'No top-level frames on this page')))
  } else {
    importFrames.forEach(function (frame) {
      const item = el('button', 'design-import-item')
      item.type = 'button'
      const name = el('span', 'design-import-name', frame.name)
      name.title = frame.name
      item.appendChild(name)
      item.appendChild(el('span', 'design-import-meta',
        frame.type + ' · ' + frame.width + '×' + frame.height))
      item.addEventListener('click', function () {
        importModalOpen = false
        addEntry(frame.name, frame.type === 'COMPONENT' || frame.type === 'COMPONENT_SET' ? 'component' : 'page', frame.id)
      })
      list.appendChild(item)
    })
  }
  box.appendChild(list)
  const actions = el('div', 'design-modal-actions')
  const cancelBtn = el('button', 'design-modal-btn', t('designCancel', 'Cancel'))
  cancelBtn.type = 'button'
  cancelBtn.addEventListener('click', function () { importModalOpen = false; render(true) })
  actions.appendChild(cancelBtn)
  box.appendChild(actions)
  wrap.appendChild(box)
  return wrap
}

function buildSpecSection () {
  const section = el('div', 'design-spec')
  const headRow = el('div', 'design-spec-head')
  headRow.appendChild(el('div')) // spacer — the tab above carries the label
  const headActions = el('div', 'design-spec-head-actions')
  const canImport = connectedToSelected() && pluginReady()
  headActions.appendChild(iconButton(
    'codicon-cloud-download',
    t('designImport', 'Import frames from Figma'),
    openImportModal,
    !canImport || busy
  ))
  headActions.appendChild(iconButton(
    'codicon-add',
    t('designAddEntry', 'Add entry'),
    function () { specAddOpen = !specAddOpen; render(true) }
  ))
  headRow.appendChild(headActions)
  section.appendChild(headRow)

  if (specAddOpen) section.appendChild(buildSpecAddForm())

  if (specUnavailable) {
    section.appendChild(el('div', 'design-spec-empty', t('designSpecRestart',
      'Restart Min to enable the build list — the new IPC handlers load with the main process')))
  }
  const entries = (spec && spec.entries) || []
  if (!entries.length && !specAddOpen && !specUnavailable) {
    section.appendChild(el('div', 'design-spec-empty', t('designSpecEmpty',
      'No objects yet — add a page or component you want to build')))
  }
  entries.forEach(function (entry) {
    section.appendChild(buildEntryRow(entry))
  })
  return section
}

/* --- queue tab ------------------------------------------------------------ */

let panelTab = 'list' // 'list' | 'queue'

function bridgeJobs () {
  return (lastStatus && lastStatus.bridge && lastStatus.bridge.jobs) || []
}

function buildPanelTabs () {
  const running = bridgeJobs().filter(function (j) {
    return j.state === 'queued' || j.state === 'sent'
  }).length
  const bar = el('div', 'design-tabs')
  const mkTab = function (id, label) {
    const b = el('button', 'design-tab' + (panelTab === id ? ' active' : ''), label)
    b.type = 'button'
    b.addEventListener('click', function () {
      if (panelTab === id) return
      panelTab = id
      render(true)
    })
    return b
  }
  bar.appendChild(mkTab('list', t('designTabList', 'Build list')))
  bar.appendChild(mkTab('queue', t('designTabQueue', 'Queue') + (running ? ' (' + running + ')' : '')))
  return bar
}

function jobElapsedText (job) {
  const end = job.doneAt || Date.now()
  const ms = Math.max(0, end - (job.startedAt || end))
  if (ms < 1000) return '<1s'
  if (ms < 60000) return Math.round(ms / 1000) + 's'
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's'
}

function buildQueueSection () {
  const section = el('div', 'design-queue')
  const jobs = bridgeJobs()
  if (!jobs.length) {
    section.appendChild(el('div', 'design-spec-empty', t('designQueueEmpty', 'No commands yet')))
    return section
  }
  jobs.forEach(function (job) {
    const row = el('div', 'design-job state-' + job.state)
    const icon = job.state === 'done'
      ? 'codicon-pass'
      : job.state === 'error'
        ? 'codicon-error'
        : 'codicon-loading codicon-modifier-spin'
    row.appendChild(el('span', 'codicon ' + icon + ' design-job-icon'))
    const main = el('div', 'design-job-main')
    const title = el('div', 'design-job-title', job.action + (job.nodeId ? ' ' + job.nodeId : ''))
    title.title = title.textContent
    main.appendChild(title)
    if (job.state === 'error' && job.error) {
      const err = el('div', 'design-job-error', job.error)
      err.title = job.error
      main.appendChild(err)
    }
    row.appendChild(main)
    row.appendChild(el('span', 'design-job-meta',
      (job.transport ? job.transport + ' ' : '') + jobElapsedText(job)))
    section.appendChild(row)
  })
  return section
}

function buildHeader () {
  const header = el('div', 'file-tree-header design-header')
  header.appendChild(el('div', 'file-tree-title', t('sidebarDesign', 'Design')))

  const actions = el('div', 'file-tree-header-actions')
  const engineRunning = !!(lastStatus && lastStatus.running)
  const engineVisible = !!(lastStatus && lastStatus.windowVisible)
  // The engine window is global — keep its toggle on every tab so showing it
  // never requires a trip through settings.
  actions.appendChild(iconButton(
    engineVisible ? 'codicon-eye-closed' : 'codicon-eye',
    engineVisible ? t('designHideEngine', 'Hide engine window') : t('designShowEngine', 'Show engine window'),
    function () { ipc.invoke('figmaEngine:setVisible', { visible: !engineVisible }).then(refreshStatus) },
    !engineRunning
  ))

  const isFigma = !!(activeParsed() && activeParsed().isFigmaFile)
  const scoped = connectedToSelected()
  const canRun = scoped && pluginReady() && !busy && !needsLogin()

  // Everything else in this panel's header is a Figma-tab action — on a
  // non-Figma tab the build list below is the whole panel.
  if (isFigma) {
    // Connect and disconnect share one slot and the same icon-button style.
    if (scoped) {
      actions.appendChild(iconButton(
        'codicon-debug-disconnect',
        t('designDisconnect', 'Disconnect'),
        disconnectSelectedTab,
        busy
      ))
    } else {
      actions.appendChild(iconButton(
        'codicon-plug',
        t('designConnect', 'Connect'),
        connectSelectedTab,
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
  }
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
    (lastStatus && lastStatus.phaseError) || '',
    payload && (payload.path || payload.css || payload.textExtract)
      ? String((payload.path || '') + (payload.css || '') + (payload.textExtract || '')).length
      : '',
    busy ? 'busy' : 'idle',
    !!(lastStatus && lastStatus.running),
    pluginReady(),
    (lastStatus && lastStatus.bridge && lastStatus.bridge.transport) || '',
    specWorkspace,
    specUnavailable ? 'unavailable' : '',
    (spec && spec.updatedAt) || '',
    (spec && spec.entries && spec.entries.length) || 0,
    specAddOpen ? 'add' : '',
    variantFormFor || '',
    variantEditFor || '',
    exportingFor || '',
    resultModalOpen ? 'result' : '',
    importModalOpen ? 'import' : '',
    panelTab,
    !!(lastStatus && lastStatus.windowVisible),
    bridgeJobs().map(function (j) {
      return j.id + ':' + j.state + ':' + (j.doneAt || '') + ':' + (j.error || '')
    }).join(','),
    overlayState && overlayState.active
      ? overlayState.tabId + ':' + overlayState.entryId + ':' + overlayState.variantId
      : '',
    Object.keys(specExpanded).filter(function (k) { return specExpanded[k] }).join(',')
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
  const parsed = activeParsed()
  if (parsed && parsed.isFigmaFile) body.appendChild(buildStatusCard())
  body.appendChild(buildPanelTabs())
  body.appendChild(panelTab === 'queue' ? buildQueueSection() : buildSpecSection())

  if (lastError) {
    body.appendChild(el('div', 'design-error', lastError))
  }

  const modal = exportModal()
  if (modal) panel.appendChild(modal)
  const importModal = buildImportModal()
  if (importModal) panel.appendChild(importModal)
  const resultModal = buildResultModal()
  if (resultModal) panel.appendChild(resultModal)
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

    // tasks.on subscribes at the workspace store, so it keeps receiving the
    // selected workspace's task events across switches.
    tasks.on('tab-selected', function () {
      lastParsed = null
      lastParsedUrl = ''
      lastParsedTabId = null
      lastResult = null
      lastError = null
      render()
      refreshStatus()
      refreshOverlay().then(function () { render() })
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
    workspaces.on('workspace-selected', function () {
      refreshStatus()
      spec = { entries: [] }
      refreshSpec().then(function () { render() })
    })

    refreshStatus()
    refreshSpec().then(function () { render() })
    refreshOverlay().then(function () { render() })
    setInterval(function () {
      if (panel.classList.contains('active')) {
        refreshStatus()
        // The in-page ✕ control clears the overlay in main — poll keeps the
        // variant's eye state honest without an extra event channel.
        refreshOverlay().then(function () { render() })
      }
    }, 2500)
  }
}

module.exports = designPanel
