/* Pro Settings page: tabs for the AI provider (OpenRouter key) and
workspace profile management (moved from the standalone profiles page).

Pages run with context isolation, so there is no ipc global here — main-process
requests go through the preload's postMessage relay instead. Profiles live in
localStorage under min://app, shared with the rest of the browser UI.
*/

document.title = l('proSettingsTitle') + ' | Min'

/* ----- tabs ----- */

var tabButtons = Array.from(document.querySelectorAll('.pro-tab'))
var panels = {
  provider: document.getElementById('panel-provider'),
  profiles: document.getElementById('panel-profiles'),
  design: document.getElementById('panel-design')
}

function selectTab (name) {
  if (!panels[name]) return
  tabButtons.forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-tab') === name)
  })
  Object.keys(panels).forEach(function (key) {
    panels[key].classList.toggle('active', key === name)
  })
}

tabButtons.forEach(function (button) {
  button.addEventListener('click', function () {
    selectTab(button.getAttribute('data-tab'))
  })
})

/* deep link: min://proSettings?tab=profiles */
if (new URLSearchParams(window.location.search).get('tab')) {
  selectTab(new URLSearchParams(window.location.search).get('tab'))
}

/* =====================================================================
   Provider tab (OpenRouter)
   ===================================================================== */

var keyInput = document.getElementById('input-openrouter-key')
var toggleVisibilityButton = document.getElementById('toggle-key-visibility')
var testButton = document.getElementById('test-key-button')
var testResult = document.getElementById('test-result')
var statusPill = document.getElementById('status-pill')
var statusText = document.getElementById('status-text')

function agentCall (message, data, callback) {
  const resultMessage = message + 'Result'
  function listener (e) {
    if (!e.origin.startsWith('min://')) return
    if (e.data && e.data.message === resultMessage) {
      window.removeEventListener('message', listener)
      callback(e.data.result)
    }
  }
  window.addEventListener('message', listener)
  window.postMessage(Object.assign({ message: message }, data), window.location.toString())
}

/* status pill */

function updateStatusPill () {
  var hasKey = !!(keyInput.value && keyInput.value.trim())
  statusPill.classList.toggle('configured', hasKey)
  statusText.textContent = hasKey ? 'Configured' : 'Not configured'
}

/* api key */

toggleVisibilityButton.addEventListener('click', function () {
  var show = keyInput.type === 'password'
  keyInput.type = show ? 'text' : 'password'
  toggleVisibilityButton.title = show ? 'Hide key' : 'Show key'
  toggleVisibilityButton.firstElementChild.className = show ? 'i carbon:view--off' : 'i carbon:view'
})

keyInput.addEventListener('input', function () {
  settings.set('openrouterApiKey', this.value.trim() || null)
  testResult.hidden = true
  updateStatusPill()
})

testButton.addEventListener('click', function () {
  var key = keyInput.value.trim()
  testResult.hidden = false
  testResult.className = 'pro-test-result'
  testResult.textContent = '…'
  testButton.disabled = true
  agentCall('agentTestKey', { key: key }, function (result) {
    testButton.disabled = false
    if (result && result.ok) {
      testResult.classList.add('ok')
      statusPill.classList.remove('error')
    } else {
      testResult.classList.add('fail')
      statusPill.classList.toggle('error', !!key)
    }
    testResult.textContent = result ? result.message : 'Unknown error'
  })
})

settings.get('openrouterApiKey', function (value) {
  if (value) keyInput.value = value
  updateStatusPill()
})

updateStatusPill()

/* =====================================================================
   Profiles tab (moved from pages/profiles/profiles.js)
   ===================================================================== */

const STORAGE_KEY = 'workspaceProfiles'
const profileColors = ['#5b8def', '#43a047', '#f4511e', '#8e24aa', '#00897b', '#d81b60', '#6d4c41', '#546e7a']

function getProfiles () {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (Array.isArray(data)) return data.filter(function (p) { return p && p.id && p.name })
  } catch (e) {
    console.warn('profiles: failed to read', e)
  }
  return []
}
function saveProfiles (profiles) {
  const previous = getProfiles()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  try {
    const keep = {}
    profiles.forEach(function (p) {
      if (p && p.id) {
        keep[p.id] = true
        window.postMessage({ message: 'dbInvoke', action: 'db:saveProfile', payload: p }, window.location.toString())
      }
    })
    previous.forEach(function (p) {
      if (p && p.id && !keep[p.id]) {
        window.postMessage({ message: 'dbInvoke', action: 'db:deleteProfile', payload: p.id }, window.location.toString())
      }
    })
  } catch (e) {}
}
function getColor (profileId) {
  let hash = 0
  for (let i = 0; i < profileId.length; i++) {
    hash = ((hash << 5) - hash) + profileId.charCodeAt(i)
    hash |= 0
  }
  return profileColors[Math.abs(hash) % profileColors.length]
}

function getWorkspaceUsage () {
  const usage = {}
  try {
    // workspaces are persisted via sessionRestore — check both possible keys
    const keys = ['taskRestoreData', 'workspaceRestoreData']
    for (let k = 0; k < keys.length; k++) {
      const raw = localStorage.getItem(keys[k])
      if (!raw) continue
      const data = JSON.parse(raw)
      const arr = data.workspaces || data.tasks || (data.state && (data.state.workspaces || data.state.tasks)) || []
      arr.forEach(function (ws) {
        if (ws.profileId) usage[ws.profileId] = (usage[ws.profileId] || 0) + 1
      })
    }
    let totalWorkspaces = 0
    let withProfile = 0
    Object.keys(usage).forEach(function (k) { withProfile += usage[k] })
    try {
      const raw2 = localStorage.getItem('taskRestoreData') || localStorage.getItem('workspaceRestoreData')
      if (raw2) {
        const d2 = JSON.parse(raw2)
        const a2 = d2.workspaces || d2.tasks || (d2.state && (d2.state.workspaces || d2.state.tasks)) || []
        totalWorkspaces = a2.length
      }
    } catch (e2) {}
    usage.__total = totalWorkspaces
    usage.__default = Math.max(0, totalWorkspaces - withProfile)
  } catch (e) {}
  return usage
}

var listEl = document.getElementById('profiles-list')
var addInput = document.getElementById('profiles-add-input')
var addButton = document.getElementById('profiles-add-button')

addInput.placeholder = l('taskProfileAddPlaceholder')

function renderProfiles () {
  listEl.textContent = ''

  const usage = getWorkspaceUsage()

  // always show Default row first
  const defaultRow = document.createElement('div')
  defaultRow.className = 'profiles-default-row'
  const defaultIcon = document.createElement('span')
  defaultIcon.className = 'profile-initial profile-initial-default i carbon:user-multiple'
  defaultRow.appendChild(defaultIcon)
  const defaultName = document.createElement('span')
  defaultName.className = 'profile-row-name'
  defaultName.textContent = l('taskProfileDefault')
  defaultRow.appendChild(defaultName)
  if (usage.__total > 0) {
    const u = document.createElement('span')
    u.className = 'profile-row-usage'
    const n = usage.__default
    u.textContent = n === 1 ? '1 workspace' : n + ' workspaces'
    defaultRow.appendChild(u)
  }
  listEl.appendChild(defaultRow)

  const profiles = getProfiles()

  if (profiles.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'profiles-empty'
    empty.textContent = l('taskProfileEmpty')
    listEl.appendChild(empty)
    return
  }

  profiles.forEach(function (profile) {
    const row = document.createElement('div')
    row.className = 'profile-row'

    const initial = document.createElement('span')
    initial.className = 'profile-initial'
    initial.textContent = (profile.name.trim()[0] || '?').toUpperCase()
    initial.style.backgroundColor = getColor(profile.id)
    row.appendChild(initial)

    const nameEl = document.createElement('span')
    nameEl.className = 'profile-row-name'
    nameEl.textContent = profile.name
    row.appendChild(nameEl)

    const count = usage[profile.id] || 0
    if (count > 0) {
      const usageEl = document.createElement('span')
      usageEl.className = 'profile-row-usage'
      usageEl.textContent = count === 1 ? '1 workspace' : count + ' workspaces'
      row.appendChild(usageEl)
    }

    const renameBtn = document.createElement('button')
    renameBtn.className = 'i carbon:edit'
    renameBtn.title = l('taskProfileRename')
    renameBtn.addEventListener('click', function () {
      const input = document.createElement('input')
      input.type = 'text'
      input.value = profile.name
      input.style.flex = '1'
      input.style.padding = '0.3em 0.5em'
      input.style.border = '1px solid rgba(127,127,127,0.4)'
      input.style.borderRadius = '6px'
      row.replaceChild(input, nameEl)
      input.focus()
      input.select()
      let done = false
      const save = function () {
        if (done) return
        done = true
        const v = input.value.trim()
        if (v) {
          const all = getProfiles()
          const p = all.find(function (x) { return x.id === profile.id })
          if (p) { p.name = v; saveProfiles(all) }
        }
        renderProfiles()
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') { done = true; renderProfiles() }
      })
      input.addEventListener('blur', save)
    })
    row.appendChild(renameBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'profile-delete i carbon:trash-can'
    deleteBtn.title = l('taskProfileDelete')
    deleteBtn.addEventListener('click', function () {
      const all = getProfiles().filter(function (p) { return p.id !== profile.id })
      saveProfiles(all)
      try {
        const keys = ['taskRestoreData', 'workspaceRestoreData']
        keys.forEach(function (k) {
          const raw = localStorage.getItem(k)
          if (!raw) return
          const data = JSON.parse(raw)
          const arr = data.workspaces || data.tasks || (data.state && (data.state.workspaces || data.state.tasks))
          if (!arr) return
          let changed = false
          arr.forEach(function (ws) {
            if (ws.profileId === profile.id) { ws.profileId = null; changed = true }
          })
          if (changed) localStorage.setItem(k, JSON.stringify(data))
        })
      } catch (e) {}
      renderProfiles()
    })
    row.appendChild(deleteBtn)

    listEl.appendChild(row)
  })
}

function addProfile () {
  const name = addInput.value.trim()
  if (!name) return
  const id = 'profile-' + Math.round(Math.random() * 100000000000000000)
  const profiles = getProfiles()
  profiles.push({ id: id, name: name })
  saveProfiles(profiles)
  addInput.value = ''
  renderProfiles()
}

addButton.addEventListener('click', addProfile)
addInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') addProfile()
})

renderProfiles()

/* =====================================================================
   Figma engine (global controls)
   ===================================================================== */

var figmaCallId = 0
var figmaBusy = false
var figmaStatus = null

function figmaCall (action, callback, payload) {
  const callId = ++figmaCallId
  function listener (e) {
    if (!e.origin.startsWith('min://')) return
    if (e.data && e.data.message === 'figmaEngineResult' && e.data.callId === callId) {
      window.removeEventListener('message', listener)
      callback(e.data.result)
    }
  }
  window.addEventListener('message', listener)
  window.postMessage({
    message: 'figmaEngine',
    action: action,
    callId: callId,
    payload: payload
  }, window.location.toString())
}

function figmaProcessRunning () {
  return !!(figmaStatus && (
    figmaStatus.processRunning != null
      ? figmaStatus.processRunning
      : figmaStatus.running
  ))
}

function figmaEngineReady () {
  return !!(figmaStatus && (
    figmaStatus.ready != null
      ? figmaStatus.ready
      : figmaStatus.running
  ))
}

function figmaStatusLoading () {
  var phase = figmaStatus && figmaStatus.phase
  return !!(figmaStatus && (
    figmaStatus.loading ||
    ['starting', 'loading-engine', 'opening-tab', 'loading-tab', 'loading-plugin'].indexOf(phase) !== -1
  ))
}

function figmaLoadingLabel () {
  var phase = figmaStatus && figmaStatus.phase
  if (phase === 'loading-tab' || phase === 'opening-tab') return l('designStatusLoading') || 'loading file…'
  if (phase === 'loading-plugin') return l('designStatusWaiting') || 'starting plugin…'
  return 'loading engine…'
}

function figmaSetBusy (value) {
  figmaBusy = value
  ;['figma-power-button', 'figma-window-button'].forEach(function (id) {
    var btn = document.getElementById(id)
    if (btn) btn.disabled = value || (id === 'figma-window-button' && !figmaEngineReady())
  })
}

function renderFigmaStatus (status, error) {
  figmaStatus = status || figmaStatus
  var pill = document.getElementById('figma-engine-pill')
  var text = document.getElementById('figma-engine-status-text')
  var meta = document.getElementById('figma-engine-meta')
  var errEl = document.getElementById('figma-engine-error')
  if (!pill || !text || !meta) return

  var processRunning = figmaProcessRunning()
  var loading = figmaStatusLoading()
  var running = !!(figmaEngineReady() && !loading)
  var visible = !!(processRunning && figmaStatus.windowVisible)
  var plugin = !!(figmaStatus && figmaStatus.bridge && figmaStatus.bridge.pluginConnected)
  var ctx = figmaStatus && figmaStatus.context
  var needsLogin = !!(ctx && ctx.needsLogin)
  var launchError = figmaStatus && figmaStatus.engineLaunch
  var connected = !!(ctx && ctx.fileKey)

  pill.classList.remove('configured', 'error')
  if (launchError || needsLogin || error) pill.classList.add('error')
  else if (connected && plugin) pill.classList.add('configured')

  if (launchError) text.textContent = l('designEngineMissing') || 'Engine not ready'
  else if (loading) text.textContent = figmaLoadingLabel()
  else if (needsLogin) text.textContent = l('designStatusLogin') || 'Sign in to Figma'
  else if (connected && plugin) text.textContent = l('designStatusReady') || 'Connected'
  else if (connected) text.textContent = l('designStatusWaiting') || 'Starting plugin…'
  else if (running) text.textContent = l('designRunning') || 'running'
  else text.textContent = l('designStopped') || 'stopped'

  meta.textContent = ''
  function addRow (label, value) {
    var row = document.createElement('div')
    row.className = 'pro-kv-row'
    var k = document.createElement('div')
    k.className = 'pro-kv-k'
    k.textContent = label
    var v = document.createElement('div')
    v.className = 'pro-kv-v'
    v.textContent = value
    row.appendChild(k)
    row.appendChild(v)
    meta.appendChild(row)
  }
  addRow(
    l('designEngine') || 'Engine',
    loading ? figmaLoadingLabel() : (running ? (l('designRunning') || 'running') : (l('designStopped') || 'stopped'))
  )
  addRow(l('designPlugin') || 'Plugin', plugin ? (l('designConnected') || 'connected') : (l('designWaiting') || 'waiting'))
  if (processRunning) {
    addRow(
      l('designWindow') || 'Window',
      visible
        ? (l('designVisible') || 'visible')
        : (needsLogin
          ? (l('designHiddenSignIn') || 'hidden — Show engine to sign in')
          : (l('designHidden') || 'hidden'))
    )
  }
  if (launchError) addRow(l('designEngineMissing') || 'Engine not ready', launchError)

  var power = document.getElementById('figma-power-button')
  var powerLabel = document.getElementById('figma-power-button-label')
  var windowBtn = document.getElementById('figma-window-button')
  var windowLabel = document.getElementById('figma-window-button-label')
  if (powerLabel) {
    powerLabel.textContent = processRunning
      ? (l('designStopEngine') || 'Stop engine')
      : (l('designStartEngine') || 'Start engine')
  }
  if (windowLabel) {
    windowLabel.textContent = visible
      ? (l('designHide') || 'Hide engine')
      : (l('designShowEngine') || 'Show engine')
  }
  if (power) power.disabled = !!figmaBusy || !!launchError
  if (windowBtn) windowBtn.disabled = !!figmaBusy || !figmaEngineReady() || !!launchError

  if (error) {
    errEl.hidden = false
    errEl.textContent = error
  } else {
    errEl.hidden = true
    errEl.textContent = ''
  }
}

function refreshFigmaStatus () {
  figmaCall('status', function (result) {
    renderFigmaStatus(result, null)
  })
}

function figmaAction (action, payload) {
  figmaSetBusy(true)
  figmaCall(action, function (result) {
    if (result && typeof result === 'object') {
      figmaStatus = Object.assign({}, figmaStatus, result)
    }
    figmaSetBusy(false)
    var error = (result && result.ok === false) ? (result.error || result.message) : null
    figmaCall('status', function (status) {
      renderFigmaStatus(status, error)
    })
  }, payload)
}

document.getElementById('figma-power-button').addEventListener('click', function () {
  figmaAction(figmaProcessRunning() ? 'stop' : 'start')
})
document.getElementById('figma-window-button').addEventListener('click', function () {
  var visible = !!(figmaProcessRunning() && figmaStatus.windowVisible)
  figmaAction('setVisible', { visible: !visible })
})

refreshFigmaStatus()
setInterval(function () {
  if (document.visibilityState === 'visible' && !figmaBusy) refreshFigmaStatus()
}, 2500)
