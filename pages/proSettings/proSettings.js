/* Pro Settings page: tabs for the AI provider (OpenRouter key) and
workspace profile management (moved from the standalone profiles page).

Pages run with context isolation, so there is no ipc global here — main-process
requests go through the preload's postMessage relay instead. Profiles live in
localStorage under min://app, shared with the rest of the browser UI.
*/
/* global settings */

document.title = l('proSettingsTitle') + ' | Min'
var settingsLifecycle = window.createSettingsLifecycle()
var providerDiscoveryRevision = 0

/* ----- tabs ----- */

var tabButtons = Array.from(document.querySelectorAll('.pro-tab'))
var panels = {
  provider: document.getElementById('panel-provider'),
  tools: document.getElementById('panel-tools'),
  profiles: document.getElementById('panel-profiles'),
  editor: document.getElementById('panel-editor'),
  terminal: document.getElementById('panel-terminal'),
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
  if (name === 'tools' && !toolsLoaded) loadAgentTools()
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
   Provider tab (multi-provider API keys)
   ===================================================================== */

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

/* db calls go through the settingsPreload 'dbInvoke' relay; callback receives
the result (or null on error) */
var dbCallCounter = 0
function dbInvoke (action, payload, callback) {
  var callId = 'pdb-' + (++dbCallCounter)
  function listener (e) {
    if (!e.origin.startsWith('min://')) return
    if (e.data && e.data.message === 'dbInvokeResult' && e.data.callId === callId) {
      window.removeEventListener('message', listener)
      callback(e.data.error ? null : e.data.result)
    }
  }
  if (callback) {
    window.addEventListener('message', listener)
  }
  window.postMessage({ message: 'dbInvoke', callId: callId, action: action, payload: payload }, window.location.toString())
}

/* searchable wrapper for <select>s: hides the select and drives it through
a text input + filtered dropdown. Callers keep reading select.value and
listening for 'change'; options may be repopulated at any time.

Closed state shows the selected label as the input's placeholder; opening
clears the input so typing filters from scratch. */
function makeSearchableSelect (select) {
  var wrap = document.createElement('div')
  wrap.className = 'pro-search-select'

  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'pro-input pro-search-select-input'
  input.autocomplete = 'off'
  input.spellcheck = false

  var list = document.createElement('div')
  list.className = 'pro-search-select-list'
  list.hidden = true

  select.parentNode.insertBefore(wrap, select)
  wrap.appendChild(select)
  select.style.display = 'none'
  wrap.appendChild(input)
  wrap.appendChild(list)

  var activeIndex = -1
  var isOpen = false

  function selectedLabel () {
    var opt = select.selectedOptions && select.selectedOptions[0]
    return opt ? opt.textContent : ''
  }

  function sync () {
    input.disabled = select.disabled
    if (!isOpen) {
      input.value = ''
      input.placeholder = selectedLabel()
    }
  }

  function onDocMousedown (e) {
    if (!wrap.contains(e.target)) closeList()
  }

  function closeList () {
    if (!isOpen) return
    isOpen = false
    list.hidden = true
    input.value = ''
    input.placeholder = selectedLabel()
    document.removeEventListener('mousedown', onDocMousedown, true)
  }

  function renderList (filter) {
    list.textContent = ''
    var q = (filter || '').toLowerCase()
    var shown = 0
    activeIndex = -1
    Array.from(select.options).forEach(function (opt) {
      if (shown >= 200) return
      if (q && opt.textContent.toLowerCase().indexOf(q) === -1) return
      var item = document.createElement('div')
      item.className = 'pro-search-select-item'
      item.dataset.value = opt.value
      item.textContent = opt.textContent
      if (opt.value === select.value) {
        item.classList.add('selected')
        activeIndex = shown
      }
      item.addEventListener('mousedown', function (e) {
        e.preventDefault() // keep focus on the input so pick() lands first
        pick(opt.value)
      })
      list.appendChild(item)
      shown++
    })
    if (!shown) {
      var empty = document.createElement('div')
      empty.className = 'pro-search-select-empty'
      empty.textContent = l('proSettingsSearchNoResults')
      list.appendChild(empty)
    }
  }

  function openList () {
    if (isOpen || select.disabled) return
    isOpen = true
    input.placeholder = selectedLabel()
    renderList(input.value)
    list.hidden = false
    document.addEventListener('mousedown', onDocMousedown, true)
    var selected = list.querySelector('.pro-search-select-item.selected')
    if (selected) selected.scrollIntoView({ block: 'nearest' })
  }

  function pick (value) {
    select.value = value
    select.dispatchEvent(new Event('change'))
    closeList()
  }

  function moveActive (delta) {
    var items = list.querySelectorAll('.pro-search-select-item')
    if (!items.length) return
    activeIndex = (activeIndex + delta + items.length) % items.length
    items.forEach(function (item, i) { item.classList.toggle('active', i === activeIndex) })
    items[activeIndex].scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('mousedown', function (e) {
    if (isOpen) {
      // clicking the field while open toggles closed; preventDefault keeps
      // focus so the list doesn't immediately reopen via the focus handler
      e.preventDefault()
      closeList()
      return
    }
    if (document.activeElement === input) {
      // already focused (e.g. just closed by clicking the field) — the focus
      // event won't refire, so open explicitly
      e.preventDefault()
      openList()
    }
    // otherwise let the default focus happen; the focus handler opens
  })
  input.addEventListener('focus', function () {
    openList()
  })
  input.addEventListener('input', function () {
    if (!isOpen) openList()
    renderList(input.value)
  })
  input.addEventListener('blur', closeList)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!isOpen) { openList(); return }
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!isOpen) return
      moveActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!isOpen) { openList(); return }
      var items = list.querySelectorAll('.pro-search-select-item')
      var target = items[activeIndex] || items[0]
      if (target) pick(target.dataset.value)
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault()
        e.stopPropagation() // don't let it close the whole dialog too
        closeList()
      }
    }
  })

  // options may be repopulated async — keep the placeholder in sync
  new window.MutationObserver(sync).observe(select, { childList: true })

  sync()
  return { sync: sync, input: input }
}

/* CRUD list of configured providers: rows show the masked key with
test/remove actions, and an add row offers every provider the installed SDK
knows (probed live via agentListProviders). Keys live in the central DB under
provider_config as '<id>ApiKey'. */
var providersList = document.getElementById('providers-list')
var providerKeys = {} // providerId -> api key (from kv provider_config)
var providerDisabled = {} // providerId -> true when disabled (key kept stored)
var knownProviders = [] // {id, label, models} — probed from the SDK

var PROVIDER_LINKS = {
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai',
  deepseek: 'https://platform.deepseek.com',
  cerebras: 'https://cloud.cerebras.ai',
  together: 'https://api.together.ai',
  fireworks: 'https://fireworks.ai',
  baseten: 'https://baseten.co',
  nvidia: 'https://build.nvidia.com',
  huggingface: 'https://huggingface.co/settings/tokens',
  'kimi-coding': 'https://platform.moonshot.ai',
  minimax: 'https://platform.minimaxi.com',
  zai: 'https://z.ai',
  opencode: 'https://opencode.ai',
  'vercel-ai-gateway': 'https://vercel.com',
  'amazon-bedrock': 'https://console.aws.amazon.com/bedrock',
  'azure-openai-responses': 'https://portal.azure.com',
  'qwen-token-plan': 'https://qwen.ai'
}

function providerLabel (id) {
  var known = knownProviders.find(function (p) { return p.id === id })
  return (known && known.label) || id
}

function maskKey (key) {
  if (!key || key.length < 10) return '••••••'
  return key.slice(0, 6) + '…' + key.slice(-4)
}

function setProviderKey (id, key) {
  invalidateCommitModels()
  providerKeys[id] = key
  dbInvoke('db:kvSet', { scope: 'provider_config', key: id + 'ApiKey', value: key || null }, function () {
    refreshCommitModels()
  })
  /* keep the legacy settings mirror for openrouter so the catalog cache
  invalidation listener keeps firing */
  if (id === 'openrouter') {
    settings.set('openrouterApiKey', key)
  }
  if (!key) {
    delete providerKeys[id]
    delete providerDisabled[id]
    dbInvoke('db:kvDelete', { scope: 'provider_config', key: id + 'Disabled' })
  }
}

/* disabling keeps the key stored - it only hides the provider from the agent
runtime (no env key, no auth.json entry, models drop out of pickers) */
function setProviderEnabled (id, enabled) {
  invalidateCommitModels()
  /* refresh the model selects only after the write lands - the main-side
  catalog is invalidated by the kv write, so an earlier fetch could still
  return the stale list */
  if (enabled) {
    delete providerDisabled[id]
    dbInvoke('db:kvDelete', { scope: 'provider_config', key: id + 'Disabled' }, function () {
      refreshCommitModels()
    })
  } else {
    providerDisabled[id] = true
    dbInvoke('db:kvSet', { scope: 'provider_config', key: id + 'Disabled', value: true }, function () {
      refreshCommitModels()
    })
  }
  renderProviders()
}

/* providers with a stored OAuth credential live in the SDK's auth.json, not
in provider_config — merge them into the same list view */
function oauthSignedInProviders () {
  return knownProviders
    .filter(function (p) { return p.authType === 'oauth' })
    .map(function (p) { return p.id })
}

function renderProviders () {
  providersList.textContent = ''

  var configured = Object.keys(providerKeys).filter(function (id) { return !!providerKeys[id] })
  oauthSignedInProviders().forEach(function (id) {
    if (configured.indexOf(id) === -1) configured.push(id)
  })

  if (!configured.length) {
    var empty = document.createElement('p')
    empty.className = 'pro-description'
    empty.textContent = l('proSettingsNoProviders')
    providersList.appendChild(empty)
  }

  configured.forEach(function (id) {
    var disabled = !!providerDisabled[id]
    var oauthProvider = oauthSignedInProviders().indexOf(id) !== -1 && !providerKeys[id]

    var row = document.createElement('div')
    row.className = 'pro-provider-row' + (disabled ? ' disabled' : '')

    var avatar = document.createElement('span')
    avatar.className = 'pro-provider-avatar'
    var avatarIcon = document.createElement('i')
    avatarIcon.className = 'i carbon:password'
    avatar.appendChild(avatarIcon)

    var name = document.createElement('span')
    name.className = 'pro-provider-name'
    name.textContent = providerLabel(id)

    var masked = document.createElement('span')
    masked.className = 'pro-provider-key'
    masked.textContent = oauthProvider ? 'OAuth' : maskKey(providerKeys[id])

    var spacer = document.createElement('span')
    spacer.className = 'pro-provider-spacer'

    var status = document.createElement('span')
    status.className = 'pro-test-result'
    status.hidden = true

    var toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.className = 'pro-switch'
    toggle.setAttribute('role', 'switch')
    toggle.checked = !disabled
    toggle.title = l(disabled ? 'proSettingsEnableProvider' : 'proSettingsDisableProvider')
    toggle.addEventListener('change', function () {
      setProviderEnabled(id, toggle.checked)
    })

    var testBtn = document.createElement('button')
    testBtn.className = 'pro-icon-button'
    testBtn.title = l('proSettingsTestKey')
    var testIcon = document.createElement('i')
    testIcon.className = 'i carbon:checkmark-outline'
    testBtn.appendChild(testIcon)

    var editBtn = document.createElement('button')
    editBtn.className = 'pro-icon-button'
    editBtn.title = l('proSettingsEditProvider')
    var editIcon = document.createElement('i')
    editIcon.className = 'i carbon:edit'
    editBtn.appendChild(editIcon)

    var removeBtn = document.createElement('button')
    removeBtn.className = 'pro-icon-button'
    removeBtn.title = l('proSettingsRemoveProvider')
    var removeIcon = document.createElement('i')
    removeIcon.className = 'i carbon:trash-can'
    removeBtn.appendChild(removeIcon)

    testBtn.addEventListener('click', function () {
      status.hidden = false
      status.className = 'pro-test-result'
      status.textContent = '…'
      testBtn.disabled = true
      agentCall('agentTestKey', { provider: id, key: providerKeys[id] }, function (res) {
        testBtn.disabled = false
        status.classList.add(res && res.ok ? 'ok' : 'fail')
        status.textContent = res ? res.message : 'Unknown error'
      })
    })

    editBtn.addEventListener('click', function () {
      openAddDialog(id)
    })

    removeBtn.addEventListener('click', function () {
      if (oauthProvider) {
        /* OAuth credentials live in the SDK's auth.json - sign out there */
        agentCall('agentProviderLogout', { provider: id }, function () {
          invalidateProviderDiscovery()
          invalidateCommitModels()
          refreshKnownProviders()
          refreshCommitModels()
        })
      } else {
        setProviderKey(id, null)
        renderProviders()
      }
    })

    row.appendChild(avatar)
    row.appendChild(name)
    row.appendChild(masked)
    row.appendChild(spacer)
    row.appendChild(status)
    row.appendChild(toggle)
    if (!oauthProvider) {
      row.appendChild(testBtn)
      row.appendChild(editBtn)
    }
    row.appendChild(removeBtn)
    providersList.appendChild(row)
  })
}

/* ---- add/edit-provider modal ---- */
var addOverlay = document.getElementById('provider-add-overlay')
var addTitle = document.getElementById('provider-add-title')
var addSelect = document.getElementById('provider-add-select')
var addKey = document.getElementById('provider-add-key')
var addLink = document.getElementById('provider-add-link')
var addError = document.getElementById('provider-add-error')
var addConfirm = document.getElementById('provider-add-confirm')
addKey.placeholder = l('proSettingsApiKeyPlaceholder')
var addSelectSearch = makeSearchableSelect(addSelect)
var editProviderId = null // set while editing an existing provider's key

function updateAddLink () {
  var link = PROVIDER_LINKS[addSelect.value]
  addLink.href = link || '#'
  addLink.textContent = link ? link.replace('https://', '') : ''
  addLink.style.visibility = link ? 'visible' : 'hidden'
}

/* ---- OAuth sign-in inside the provider dialog ----
   providers that support OAuth get a "Sign in" button next to the API-key
   field; the flow runs in the main process and streams auth events back via
   the settingsPreload 'agentAuthEvent' relay */
var oauthSection = document.getElementById('provider-oauth-section')
var oauthSigninBtn = document.getElementById('provider-oauth-signin')
var oauthStatus = document.getElementById('provider-oauth-status')
var oauthDevice = document.getElementById('provider-oauth-device')
var oauthPromptWrap = document.getElementById('provider-oauth-prompt')
var oauthPromptLabel = document.getElementById('provider-oauth-prompt-label')
var oauthPromptInput = document.getElementById('provider-oauth-prompt-input')
var oauthPromptOptions = document.getElementById('provider-oauth-prompt-options')
var oauthPromptSubmit = document.getElementById('provider-oauth-prompt-submit')
var oauthFlowProvider = null
var oauthActiveRequestId = null

function selectedProviderInfo () {
  return knownProviders.find(function (p) { return p.id === addSelect.value }) || null
}

function setOauthStatus (text, isError) {
  oauthStatus.hidden = !text
  oauthStatus.textContent = text || ''
  oauthStatus.style.color = isError ? 'var(--error-color, #c00)' : ''
}

function hideOauthPrompt () {
  oauthPromptWrap.hidden = true
  oauthPromptOptions.hidden = true
  oauthPromptOptions.textContent = ''
  oauthPromptInput.value = ''
  oauthActiveRequestId = null
}

function showOauthPrompt (requestId, prompt) {
  oauthActiveRequestId = requestId
  oauthPromptWrap.hidden = false
  oauthPromptLabel.textContent = prompt.message || l('proSettingsOauthEnterValue')
  oauthPromptOptions.textContent = ''
  oauthPromptOptions.hidden = true
  if (prompt.type === 'select' && prompt.options && prompt.options.length) {
    /* select prompts render as a row of option buttons; clicking one is the
    answer (no separate submit) */
    oauthPromptInput.hidden = true
    oauthPromptSubmit.hidden = true
    oauthPromptOptions.hidden = false
    prompt.options.forEach(function (opt) {
      var btn = document.createElement('button')
      btn.className = 'pro-button'
      btn.type = 'button'
      btn.textContent = opt.label || opt.id
      btn.addEventListener('click', function () { answerOauthPrompt(opt.id) })
      oauthPromptOptions.appendChild(btn)
    })
  } else {
    oauthPromptInput.hidden = false
    oauthPromptSubmit.hidden = false
    oauthPromptInput.type = prompt.type === 'secret' ? 'password' : 'text'
    oauthPromptInput.placeholder = prompt.placeholder || ''
    oauthPromptInput.value = ''
    oauthPromptInput.focus()
  }
}

function answerOauthPrompt (value) {
  if (!oauthActiveRequestId) return
  var requestId = oauthActiveRequestId
  hideOauthPrompt()
  window.postMessage({ message: 'agentAuthRespond', requestId: requestId, value: value }, window.location.toString())
}

function startOauthFlow () {
  var provider = selectedProviderInfo()
  if (!provider) return
  oauthFlowProvider = provider.id
  oauthSigninBtn.disabled = true
  addSelect.disabled = true
  addConfirm.disabled = true
  hideOauthPrompt()
  oauthDevice.hidden = true
  oauthDevice.textContent = ''
  setOauthStatus(l('proSettingsOauthStarting'))
  window.postMessage({ message: 'agentProviderLogin', provider: provider.id }, window.location.toString())
}

function endOauthFlow (message, isError) {
  oauthFlowProvider = null
  oauthSigninBtn.disabled = false
  addSelect.disabled = !editProviderId
  addConfirm.disabled = false
  hideOauthPrompt()
  if (message) setOauthStatus(message, isError)
}

function updateOauthSection () {
  var provider = selectedProviderInfo()
  var supportsOauth = !!(provider && provider.oauth)
  oauthSection.hidden = !supportsOauth
  /* oauth-only providers (no apiKey auth) have nothing to type - hide the
  key field and the add-key confirm */
  var oauthOnly = supportsOauth && !provider.apiKey
  addKey.parentNode.hidden = oauthOnly && !editProviderId
  addConfirm.hidden = oauthOnly && !editProviderId
  if (supportsOauth && !oauthFlowProvider) {
    oauthSigninBtn.textContent = l('proSettingsOauthSignIn').replace('%s', provider.label || 'provider')
    setOauthStatus('')
  }
}

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://') || !e.data) return
  if (e.data.message === 'agentAuthEvent' && e.data.event) {
    var payload = e.data.event
    if (payload.provider !== oauthFlowProvider) return
    if (payload.type === 'prompt' && payload.prompt) {
      showOauthPrompt(payload.requestId, payload.prompt)
      return
    }
    if (payload.type === 'event' && payload.event) {
      var ev = payload.event
      if (ev.type === 'auth_url') {
        setOauthStatus(ev.instructions || l('proSettingsOauthOpenedTab'))
      } else if (ev.type === 'device_code') {
        oauthDevice.hidden = false
        oauthDevice.textContent = l('proSettingsOauthDeviceCode').replace('%s', ev.userCode).replace('%s', ev.verificationUri)
      } else if (ev.type === 'progress' || ev.type === 'info') {
        setOauthStatus(ev.message || '')
      }
      return
    }
    if (payload.type === 'done') {
      endOauthFlow(l('proSettingsOauthSignedIn'), false)
      closeAddDialog()
      invalidateProviderDiscovery()
      invalidateCommitModels()
      refreshKnownProviders()
      refreshCommitModels()
      return
    }
    if (payload.type === 'error') {
      endOauthFlow(payload.message || l('proSettingsOauthFailed'), true)
      return
    }
  }
  if (e.data.message === 'agentProviderLoginResult' && e.data.provider === oauthFlowProvider) {
    /* the invoke resolved without a done event (shouldn't normally happen) */
    if (e.data.result && !e.data.result.ok && oauthFlowProvider) {
      endOauthFlow(e.data.result.message || l('proSettingsOauthFailed'), true)
    }
  }
})

oauthSigninBtn.addEventListener('click', startOauthFlow)
oauthPromptSubmit.addEventListener('click', function () { answerOauthPrompt(oauthPromptInput.value) })
oauthPromptInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') answerOauthPrompt(oauthPromptInput.value)
})

/* re-probe providers (authType flags change after OAuth login/logout) and
re-render the list */
function refreshKnownProviders () {
  var revision = providerDiscoveryRevision
  return settingsLifecycle.refresh('provider-list', revision, function () {
    return new Promise(function (resolve) { agentCall('agentListProviders', {}, resolve) })
  }, function () { return revision === providerDiscoveryRevision }).then(function (result) {
    if (!result.current) return null
    knownProviders = result.value || []
    renderProviders()
    syncOpenAddDialogChoices()
    return knownProviders
  })
}

function invalidateProviderDiscovery () {
  providerDiscoveryRevision++
  settingsLifecycle.invalidate('provider-list')
}

function updateAddDialogChoices (selectedId) {
  addSelect.textContent = ''
  if (editProviderId) {
    /* editing an existing provider: the provider itself is locked, only the
    key can change */
    var opt = document.createElement('option')
    opt.value = editProviderId
    opt.textContent = providerLabel(editProviderId)
    addSelect.appendChild(opt)
    addSelect.disabled = true
    addConfirm.disabled = false
  } else {
    var configured = Object.keys(providerKeys).filter(function (id) { return !!providerKeys[id] })
    var unconfigured = knownProviders.filter(function (provider) {
      return configured.indexOf(provider.id) === -1
    })
    unconfigured.forEach(function (provider) {
      var option = document.createElement('option')
      option.value = provider.id
      option.textContent = provider.label + (provider.models ? ' (' + provider.models + ')' : '')
      addSelect.appendChild(option)
    })
    if (selectedId && unconfigured.some(function (provider) { return provider.id === selectedId })) {
      addSelect.value = selectedId
    }
    addSelect.disabled = !unconfigured.length
    addConfirm.disabled = !unconfigured.length
  }
  if (oauthFlowProvider) {
    addSelect.disabled = true
    addConfirm.disabled = true
  }
  addSelectSearch.sync()
}

function syncOpenAddDialogChoices () {
  if (addOverlay.hidden) return
  var selectedId = addSelect.value
  var key = addKey.value
  var errorText = addError.textContent
  var errorHidden = addError.hidden
  var oauthStatusText = oauthStatus.textContent
  var oauthStatusHidden = oauthStatus.hidden
  var oauthStatusColor = oauthStatus.style.color
  updateAddDialogChoices(selectedId)
  addKey.value = key
  addError.textContent = errorText
  addError.hidden = errorHidden
  updateAddLink()
  updateOauthSection()
  if (oauthStatusHidden) setOauthStatus('')
  else setOauthStatus(oauthStatusText, oauthStatusColor === 'var(--error-color, #c00)')
  if (oauthStatusColor && !oauthStatusHidden) oauthStatus.style.color = oauthStatusColor
}

function openAddDialog (editId) {
  editProviderId = typeof editId === 'string' ? editId : null
  addTitle.textContent = l(editProviderId ? 'proSettingsEditProviderTitle' : 'proSettingsAddProviderTitle')
  addConfirm.textContent = l(editProviderId ? 'docsSave' : 'proSettingsAddProvider')
  updateAddDialogChoices()
  addKey.value = editProviderId ? (providerKeys[editProviderId] || '') : ''
  addError.hidden = true
  updateAddLink()
  updateOauthSection()
  addOverlay.hidden = false
  addKey.focus()
}

function closeAddDialog () {
  /* closing mid-flow aborts the sign-in in the main process */
  if (oauthFlowProvider) {
    window.postMessage({ message: 'agentProviderLoginCancel', provider: oauthFlowProvider }, window.location.toString())
    endOauthFlow()
  }
  editProviderId = null
  addOverlay.hidden = true
}

function confirmAddProvider () {
  var key = addKey.value.trim()
  var id = editProviderId || addSelect.value
  if (!key || !id) {
    if (!key) {
      addError.hidden = false
      addError.textContent = l('proSettingsApiKeyPlaceholder')
    }
    return
  }
  setProviderKey(id, key)
  closeAddDialog()
  renderProviders()
}

document.getElementById('provider-add-open').addEventListener('click', function () { openAddDialog() })
document.getElementById('provider-add-cancel').addEventListener('click', closeAddDialog)
addSelect.addEventListener('change', function () {
  updateAddLink()
  updateOauthSection()
})
addConfirm.addEventListener('click', confirmAddProvider)
addKey.addEventListener('input', function () { addError.hidden = true })
addKey.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') confirmAddProvider()
})
addOverlay.addEventListener('click', function (e) {
  if (e.target === addOverlay) closeAddDialog()
})

/* load: providers the SDK knows + keys already stored */
refreshKnownProviders().then(function (providers) {
  if (!providers) return
  dbInvoke('db:kvList', 'provider_config', function (result) {
    providerKeys = {}
    providerDisabled = {}
    Object.keys(result || {}).forEach(function (kvKey) {
      if (kvKey.endsWith('ApiKey') && result[kvKey]) {
        providerKeys[kvKey.slice(0, -'ApiKey'.length)] = result[kvKey]
      } else if (kvKey.endsWith('Disabled')) {
        providerDisabled[kvKey.slice(0, -'Disabled'.length)] = !!result[kvKey]
      }
    })
    syncOpenAddDialogChoices()
    /* legacy: an openrouter key may still live in settings.json */
    if (!providerKeys.openrouter) {
      settings.get('openrouterApiKey', function (value) {
        if (value) providerKeys.openrouter = value
        renderProviders()
      })
      return
    }
    renderProviders()
  })
})

/* OAuth-signed-in providers are flagged via authType on the provider probe;
refresh when the providers tab becomes visible again isn't needed - the list
re-renders from the same data. */

/* commit message model: 'provider/model' stored in ai_config.commitModel.
Empty option follows the agent's own provider+model. */
var commitModelSelect = document.getElementById('commit-model')
var commitModelSearch = makeSearchableSelect(commitModelSelect)

/* the model list follows provider config (keys, enable/disable, OAuth
sign-in/out) - refetched after every mutation so a disabled provider's
models disappear immediately */
var commitModelConfigRevision = 0
function invalidateCommitModels () {
  commitModelConfigRevision++
  settingsLifecycle.invalidate('commit-models')
}

function refreshCommitModels () {
  var revision = commitModelConfigRevision
  settingsLifecycle.refresh('commit-models', revision, function () {
    return new Promise(function (resolve) {
      agentCall('agentFetchModels', {}, function (models) {
        if (revision !== commitModelConfigRevision) {
          resolve(null)
          return
        }
        dbInvoke('db:kvGet', { scope: 'ai_config', key: 'commitModel' }, function (value) {
          resolve({ models: models, value: value })
        })
      })
    })
  }, function () { return revision === commitModelConfigRevision }).then(function (result) {
    if (!result.current || !result.value) return
    var models = result.value.models
    commitModelSelect.textContent = ''
    var defaultOpt = document.createElement('option')
    defaultOpt.value = ''
    defaultOpt.textContent = l('proSettingsCommitModelDefault')
    commitModelSelect.appendChild(defaultOpt)
    ;(models || []).forEach(function (m) {
      var opt = document.createElement('option')
      opt.value = m.provider + '/' + m.id
      opt.textContent = m.providerLabel + ' / ' + m.name
      commitModelSelect.appendChild(opt)
    })
    commitModelSelect.value = result.value.value || ''
    commitModelSearch.sync()
  })
}
refreshCommitModels()

var modelsRefreshButton = document.getElementById('models-refresh')
var componentsCheckButton = document.getElementById('components-check')
var componentsUpdateButton = document.getElementById('components-update')
var aiUpdateStatus = document.getElementById('ai-update-status')

function setAiUpdateBusy (busy) {
  modelsRefreshButton.disabled = busy
  componentsCheckButton.disabled = busy
  componentsUpdateButton.disabled = busy
}

function renderComponentUpdate (result) {
  if (!result || !result.ok) {
    aiUpdateStatus.textContent = (result && result.message) || l('proSettingsAiUpdateFailed')
    return
  }
  componentsUpdateButton.hidden = !result.available
  aiUpdateStatus.textContent = result.available
    ? l('proSettingsComponentAvailable').replace('%s', result.latest)
    : l('proSettingsComponentCurrent').replace('%s', result.current || '—')
}

modelsRefreshButton.addEventListener('click', function () {
  setAiUpdateBusy(true)
  aiUpdateStatus.textContent = l('proSettingsRefreshingModels')
  invalidateCommitModels()
  agentCall('agentRefreshModels', {}, function (result) {
    setAiUpdateBusy(false)
    if (!result || !result.ok) {
      aiUpdateStatus.textContent = (result && result.message) || l('proSettingsAiUpdateFailed')
      refreshCommitModels()
      return
    }
    aiUpdateStatus.textContent = l('proSettingsModelsUpdated').replace('%s', String((result.models || []).length))
    if (result.warnings && result.warnings.length) aiUpdateStatus.textContent += ' ' + l('proSettingsModelsRetained').replace('%s', result.warnings.join(', '))
    refreshCommitModels()
  })
})

componentsCheckButton.addEventListener('click', function () {
  setAiUpdateBusy(true)
  aiUpdateStatus.textContent = l('proSettingsCheckingComponents')
  agentCall('agentCheckUpdates', {}, function (result) {
    setAiUpdateBusy(false)
    renderComponentUpdate(result)
  })
})

componentsUpdateButton.addEventListener('click', function () {
  setAiUpdateBusy(true)
  aiUpdateStatus.textContent = l('proSettingsUpdatingComponents')
  agentCall('agentUpdateComponents', {}, function (result) {
    setAiUpdateBusy(false)
    renderComponentUpdate(result)
    if (result && result.updated) {
      invalidateCommitModels()
      refreshCommitModels()
    }
  })
})

agentCall('agentComponentStatus', {}, renderComponentUpdate)

commitModelSelect.addEventListener('change', function () {
  dbInvoke('db:kvSet', { scope: 'ai_config', key: 'commitModel', value: commitModelSelect.value || null })
})

/* =====================================================================
   Profiles tab (moved from pages/profiles/profiles.js)
   ===================================================================== */

window.initializeProSettingsProfiles({
  settings: settings,
  l: l,
  closeProviderAddDialog: function () {
    if (!addOverlay.hidden) closeAddDialog()
  }
})

/* =====================================================================
   Simple preference tabs (Editor / Terminal)
   ===================================================================== */

function bindNumberField (inputId, key, fallback, min, max) {
  var el = document.getElementById(inputId)
  settings.get(key, function (value) {
    el.value = (typeof value === 'number' && !isNaN(value)) ? value : fallback
  })
  el.addEventListener('change', function () {
    var n = parseInt(el.value, 10)
    if (isNaN(n)) n = fallback
    n = Math.min(max, Math.max(min, n))
    el.value = n
    settings.set(key, n)
  })
}

function bindTextField (inputId, key) {
  var el = document.getElementById(inputId)
  settings.get(key, function (value) {
    el.value = value || ''
  })
  el.addEventListener('change', function () {
    settings.set(key, el.value.trim() || null)
  })
}

function bindCheckboxField (inputId, key) {
  var el = document.getElementById(inputId)
  settings.get(key, function (value) {
    el.checked = value === 'on'
  })
  el.addEventListener('change', function () {
    settings.set(key, el.checked ? 'on' : 'off')
  })
}

bindNumberField('editor-font-size', 'editorFontSize', 13, 8, 40)
bindNumberField('editor-tab-size', 'editorTabSize', 2, 1, 8)
bindCheckboxField('editor-word-wrap', 'editorWordWrap')

bindNumberField('terminal-font-size', 'terminalFontSize', 13, 8, 40)
bindTextField('terminal-shell', 'terminalShell')

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
  return settingsLifecycle.refresh('figma-status', 'global', function () {
    return new Promise(function (resolve) { figmaCall('status', resolve) })
  }).then(function (result) {
    if (result.current) renderFigmaStatus(result.value, null)
    return result
  })
}

function figmaAction (action, payload) {
  figmaSetBusy(true)
  settingsLifecycle.invalidate('figma-status')
  figmaCall(action, function (result) {
    if (result && typeof result === 'object') {
      figmaStatus = Object.assign({}, figmaStatus, result)
    }
    figmaSetBusy(false)
    var error = (result && result.ok === false) ? (result.error || result.message) : null
    settingsLifecycle.invalidate('figma-status')
    refreshFigmaStatus().then(function (statusResult) {
      if (statusResult && statusResult.current && error) renderFigmaStatus(statusResult.value, error)
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

/* =====================================================================
   Tools tab — read-only directory of the agent's tools and skills
   ===================================================================== */

var toolsLoaded = false
var toolsBuiltinList = document.getElementById('tools-builtin-list')
var toolsCustomList = document.getElementById('tools-custom-list')
var toolsSkillsList = document.getElementById('tools-skills-list')
var toolsRefreshBtn = document.getElementById('tools-refresh')

/* ---- tool detail dialog (also the future home of per-tool settings) ---- */
var toolDetailOverlay = document.getElementById('tool-detail-overlay')
var toolDetailTitle = document.getElementById('tool-detail-title')
var toolDetailSubtitle = document.getElementById('tool-detail-subtitle')
var toolDetailDesc = document.getElementById('tool-detail-description')
var toolDetailMeta = document.getElementById('tool-detail-meta')
var toolDetailSubWrap = document.getElementById('tool-detail-subtools-wrap')
var toolDetailSub = document.getElementById('tool-detail-subtools')

function openToolDetail (item) {
  toolDetailTitle.textContent = item.title
  toolDetailSubtitle.hidden = !item.subtitle
  toolDetailSubtitle.textContent = item.subtitle || ''
  toolDetailDesc.textContent = item.description || ''

  toolDetailMeta.textContent = ''
  toolDetailMeta.hidden = !(item.meta && item.meta.length)
  ;(item.meta || []).forEach(function (entry) {
    var row = document.createElement('div')
    row.className = 'pro-kv-row'
    var k = document.createElement('div')
    k.className = 'pro-kv-k'
    k.textContent = entry[0]
    var v = document.createElement('div')
    v.className = 'pro-kv-v'
    v.textContent = entry[1]
    row.appendChild(k)
    row.appendChild(v)
    toolDetailMeta.appendChild(row)
  })

  toolDetailSub.textContent = ''
  toolDetailSubWrap.hidden = !(item.actions && item.actions.length)
  ;(item.actions || []).forEach(function (action) {
    var chip = document.createElement('span')
    chip.className = 'pro-tool-chip'
    chip.textContent = action
    toolDetailSub.appendChild(chip)
  })

  toolDetailOverlay.hidden = false
}

function closeToolDetail () {
  toolDetailOverlay.hidden = true
}

document.getElementById('tool-detail-close').addEventListener('click', closeToolDetail)
toolDetailOverlay.addEventListener('click', function (e) {
  if (e.target === toolDetailOverlay) closeToolDetail()
})
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !toolDetailOverlay.hidden) closeToolDetail()
})

/* item shape: { title, name, description, actions, meta } — name is the raw
tool/skill id shown as a badge when it differs from the title */
function makeToolItem (item) {
  var wrap = document.createElement('div')
  wrap.className = 'pro-tool-item'

  var row = document.createElement('div')
  row.className = 'pro-tool-row'
  row.setAttribute('role', 'button')
  row.tabIndex = 0

  var hasActions = !!(item.actions && item.actions.length)
  var subtools = null
  if (hasActions) {
    var chevron = document.createElement('button')
    chevron.className = 'pro-tool-chevron'
    chevron.setAttribute('aria-label', 'expand')
    var chevronIcon = document.createElement('i')
    chevronIcon.className = 'i carbon:chevron-right'
    chevron.appendChild(chevronIcon)
    chevron.addEventListener('click', function (e) {
      e.stopPropagation()
      var expanded = subtools.hidden
      subtools.hidden = !expanded
      chevron.classList.toggle('expanded', expanded)
    })
    /* keep Enter/Space on the chevron from also triggering the row's
    open-popup keydown */
    chevron.addEventListener('keydown', function (e) {
      e.stopPropagation()
    })
    row.appendChild(chevron)
  } else {
    var slot = document.createElement('span')
    slot.className = 'pro-tool-chevron-slot'
    row.appendChild(slot)
  }

  var nameEl = document.createElement('span')
  nameEl.className = 'pro-tool-name'
  nameEl.textContent = item.title
  row.appendChild(nameEl)

  if (item.name && item.name !== item.title) {
    var badge = document.createElement('span')
    badge.className = 'pro-tool-meta'
    badge.textContent = item.name
    row.appendChild(badge)
  }
  if (item.badge) {
    var extra = document.createElement('span')
    extra.className = 'pro-tool-meta'
    extra.textContent = item.badge
    row.appendChild(extra)
  }

  function open () { openToolDetail(item) }
  row.addEventListener('click', open)
  row.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
  wrap.appendChild(row)

  if (hasActions) {
    subtools = document.createElement('div')
    subtools.className = 'pro-tool-subtools'
    subtools.hidden = true
    item.actions.forEach(function (action) {
      var chip = document.createElement('span')
      chip.className = 'pro-tool-chip'
      chip.textContent = action
      subtools.appendChild(chip)
    })
    wrap.appendChild(subtools)
  }
  return wrap
}

function fillToolList (listEl, items, emptyText) {
  listEl.textContent = ''
  if (!items || !items.length) {
    var empty = document.createElement('div')
    empty.className = 'pro-tool-empty'
    empty.textContent = emptyText
    listEl.appendChild(empty)
    return
  }
  items.forEach(function (item) {
    listEl.appendChild(makeToolItem(item))
  })
}

function renderSkillsGroup (title, dirPath, skills) {
  var group = document.createElement('div')
  group.className = 'pro-skill-group'

  var head = document.createElement('div')
  head.className = 'pro-skill-group-head'
  var titleEl = document.createElement('span')
  titleEl.className = 'pro-skill-group-title'
  titleEl.textContent = title
  head.appendChild(titleEl)
  if (dirPath) {
    var dirEl = document.createElement('span')
    dirEl.className = 'pro-skill-group-dir'
    dirEl.textContent = dirPath
    dirEl.title = dirPath
    head.appendChild(dirEl)
  }
  group.appendChild(head)

  if (!skills.length) {
    var empty = document.createElement('div')
    empty.className = 'pro-tool-empty'
    empty.textContent = l('proSettingsNoSkills')
    group.appendChild(empty)
    return group
  }
  var card = document.createElement('div')
  card.className = 'pro-field-card'
  skills.forEach(function (skill) {
    card.appendChild(makeToolItem({
      title: skill.name,
      name: null,
      subtitle: skill.path,
      description: skill.description,
      badge: skill.disabled ? l('proSettingsSkillManual') : null,
      meta: [
        [l('proSettingsSkillScope'), skill.scope === 'project' ? l('proSettingsSkillsProject') : l('proSettingsSkillsGlobal')]
      ]
    }))
  })
  group.appendChild(card)
  return group
}

function renderAgentTools (data) {
  if (toolsRefreshBtn) toolsRefreshBtn.disabled = false
  if (!data || data.ok === false) {
    var msg = (data && data.message) || l('proSettingsToolsUnavailable')
    fillToolList(toolsBuiltinList, [], msg)
    fillToolList(toolsCustomList, [], msg)
    toolsSkillsList.textContent = ''
    var empty = document.createElement('div')
    empty.className = 'pro-tool-empty'
    empty.textContent = msg
    toolsSkillsList.appendChild(empty)
    return
  }

  fillToolList(toolsBuiltinList, (data.builtin || []).map(function (tool) {
    return { title: tool.name, name: null, description: tool.description }
  }), l('proSettingsNoTools'))
  fillToolList(toolsCustomList, (data.custom || []).map(function (tool) {
    return {
      title: tool.label || tool.name,
      name: tool.name,
      subtitle: tool.name,
      description: tool.description,
      actions: tool.actions
    }
  }), l('proSettingsNoTools'))

  toolsSkillsList.textContent = ''
  var skills = data.skills || []
  var dirs = data.skillDirs || {}
  toolsSkillsList.appendChild(renderSkillsGroup(
    l('proSettingsSkillsProject'),
    dirs.project,
    skills.filter(function (s) { return s.scope === 'project' })
  ))
  toolsSkillsList.appendChild(renderSkillsGroup(
    l('proSettingsSkillsGlobal'),
    dirs.user,
    skills.filter(function (s) { return s.scope !== 'project' })
  ))
}

function loadAgentTools () {
  toolsLoaded = true
  /* the deep-link selectTab at the top of this file can run before
  toolsRefreshBtn is assigned below */
  if (toolsRefreshBtn) toolsRefreshBtn.disabled = true
  agentCall('agentListTools', {
    cwd: (window.minViewResource && window.minViewResource.rootPath) || null
  }, renderAgentTools)
}

toolsRefreshBtn.addEventListener('click', loadAgentTools)
