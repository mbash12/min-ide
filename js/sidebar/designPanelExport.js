/* Export modal state and workspace-scoped export requests for the Design panel. */

function createDesignPanelExport (deps) {
  const state = { modalOpen: false, format: 'PNG', scale: 2, dir: '', busy: false }
  let prefsRevision = 0
  let prefsRequest = null
  let modalRevision = 0
  let exportRevision = 0
  let modalContext = null

  function render () {
    if (deps.render) deps.render(true)
  }

  async function loadPrefs (context) {
    context = context || deps.getContext()
    const key = JSON.stringify([
      context.revision,
      context.workspaceId || null,
      context.workspacePath || null,
      context.tabId || null,
      context.url || ''
    ])
    if (prefsRequest && prefsRequest.key === key) return prefsRequest.promise
    const request = { key: key, revision: ++prefsRevision, promise: null }
    request.promise = (async function () {
      try {
        const prefs = await deps.ipc.invoke('figmaEngine:getExportPrefs', { workspacePath: context.workspacePath })
        if (request.revision !== prefsRevision || !deps.isContextCurrent(context)) return false
        state.dir = (prefs && prefs.effective) || (prefs && prefs.fallback) || ''
        return true
      } catch (err) {
        if (request.revision === prefsRevision && deps.isContextCurrent(context)) state.dir = ''
        return false
      } finally {
        if (prefsRequest === request) prefsRequest = null
      }
    })()
    prefsRequest = request
    return request.promise
  }

  async function open () {
    if (deps.isBusy() || !deps.isReady()) return
    const context = deps.getContext()
    const revision = ++modalRevision
    const loaded = await loadPrefs(context)
    if (!loaded || revision !== modalRevision || !deps.isContextCurrent(context)) return
    modalContext = context
    state.modalOpen = true
    state.busy = false
    render()
  }

  function close () {
    modalRevision++
    exportRevision++
    state.modalOpen = false
    state.busy = false
    modalContext = null
    render()
  }

  function resetForWorkspace () {
    prefsRevision++
    prefsRequest = null
    modalRevision++
    exportRevision++
    state.modalOpen = false
    state.busy = false
    modalContext = null
    state.dir = ''
  }

  function invalidateContext () {
    prefsRevision++
    prefsRequest = null
    modalRevision++
    exportRevision++
    state.modalOpen = false
    state.busy = false
    modalContext = null
  }

  async function browse () {
    const context = modalContext
    const revision = modalRevision
    try {
      const dirs = await deps.ipc.invoke('showOpenDialog', {
        title: deps.t('designExportDirTitle', 'Choose export folder'),
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: state.dir || undefined
      })
      if (revision !== modalRevision || !state.modalOpen || !context || !deps.isContextCurrent(context)) return
      if (dirs && dirs.length) {
        state.dir = dirs[0]
        render()
      }
    } catch (err) {}
  }

  async function confirm () {
    if (state.busy || !state.dir || !state.modalOpen) return
    const context = modalContext
    if (!context || !deps.isContextCurrent(context)) {
      close()
      return
    }
    const revision = ++exportRevision
    const nodeId = deps.getNodeId()
    const parsed = deps.getParsed()
    const format = state.format
    const scale = state.scale
    const dir = state.dir
    state.busy = true
    render()
    try {
      await deps.ipc.invoke('figmaEngine:setExportDir', {
        workspacePath: context.workspacePath,
        dir: dir
      })
      if (revision !== exportRevision || !deps.isContextCurrent(context)) return
      const result = await deps.designCommand('export', {
        nodeId: nodeId,
        fileKey: parsed && parsed.fileKey,
        format: format,
        scale: scale,
        target: 'asset',
        exportDir: dir
      })
      if (revision !== exportRevision || !deps.isContextCurrent(context)) return
      if (result && result.ok === false) {
        deps.setError(result.error || result.message || deps.t('designCommandFailed', 'Command failed'))
      } else {
        deps.setResult(result)
        close()
      }
    } catch (err) {
      if (revision === exportRevision && deps.isContextCurrent(context)) {
        deps.setError(err.message || String(err))
      }
    } finally {
      if (revision === exportRevision && deps.isContextCurrent(context)) {
        state.busy = false
        render()
      }
    }
  }

  function buildModal () {
    if (!state.modalOpen) return null
    const el = deps.el
    const wrap = el('div', 'design-modal-overlay')
    const box = el('div', 'design-modal')
    box.appendChild(el('div', 'design-modal-title', deps.t('designExportTitle', 'Export asset')))

    const formatRow = el('div', 'design-modal-row')
    formatRow.appendChild(el('span', 'design-modal-label', deps.t('designExportFormat', 'Format')))
    const formatSelect = el('select', 'design-modal-select')
    ;['PNG', 'JPG', 'SVG'].forEach(function (format) {
      const option = el('option', null, format)
      option.value = format
      if (format === state.format) option.selected = true
      formatSelect.appendChild(option)
    })
    formatSelect.addEventListener('change', function () {
      state.format = formatSelect.value
      render()
    })
    formatRow.appendChild(formatSelect)
    box.appendChild(formatRow)

    const scaleRow = el('div', 'design-modal-row')
    scaleRow.appendChild(el('span', 'design-modal-label', deps.t('designExportScale', 'Scale')))
    const scaleSelect = el('select', 'design-modal-select')
    ;[1, 2, 3, 4].forEach(function (scale) {
      const option = el('option', null, scale + '×')
      option.value = String(scale)
      if (scale === state.scale) option.selected = true
      scaleSelect.appendChild(option)
    })
    scaleSelect.addEventListener('change', function () {
      state.scale = Number(scaleSelect.value)
      render()
    })
    scaleRow.appendChild(scaleSelect)
    box.appendChild(scaleRow)

    const dirRow = el('div', 'design-modal-row')
    dirRow.appendChild(el('span', 'design-modal-label', deps.t('designExportDir', 'Folder')))
    const dirInput = el('input', 'design-modal-input')
    dirInput.type = 'text'
    dirInput.value = state.dir
    dirInput.placeholder = deps.t('designExportDirPlaceholder', '/path/to/exports')
    dirInput.addEventListener('change', function () { state.dir = dirInput.value.trim() })
    dirRow.appendChild(dirInput)
    const browseButton = el('button', 'design-modal-btn', deps.t('designBrowse', 'Browse…'))
    browseButton.type = 'button'
    browseButton.addEventListener('click', browse)
    dirRow.appendChild(browseButton)
    box.appendChild(dirRow)

    const actions = el('div', 'design-modal-actions')
    const cancel = el('button', 'design-modal-btn', deps.t('designCancel', 'Cancel'))
    cancel.type = 'button'
    cancel.addEventListener('click', close)
    actions.appendChild(cancel)
    const exportButton = el('button', 'design-modal-btn primary', deps.t('designExportConfirm', 'Export'))
    exportButton.type = 'button'
    exportButton.disabled = state.busy || !state.dir
    exportButton.addEventListener('click', confirm)
    actions.appendChild(exportButton)
    box.appendChild(actions)
    wrap.appendChild(box)
    return wrap
  }

  return {
    state: state,
    loadPrefs: loadPrefs,
    open: open,
    close: close,
    browse: browse,
    confirm: confirm,
    buildModal: buildModal,
    resetForWorkspace: resetForWorkspace,
    invalidateContext: invalidateContext
  }
}

module.exports = createDesignPanelExport
