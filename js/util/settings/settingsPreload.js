/* global ipc */
window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data && e.data.message && e.data.message === 'getSettingsData') {
    ipc.send('getSettingsData')
  }

  if (e.data && e.data.message && e.data.message === 'setSetting') {
    ipc.send('setSetting', { key: e.data.key, value: e.data.value })
  }

  /* Profile management is rendered in a webview, while workspace state lives
  in the main renderer. Ask that renderer to update live tasks before the
  profile page removes the shared profile record. */
  if (e.data && e.data.message === 'profileDeleteRequested' && e.data.profileId) {
    ipc.send('profileDeleteRequested', e.data.profileId)
  }
  if (e.data && e.data.message === 'profileDeleted' && e.data.profileId) {
    ipc.send('profileDeleted', e.data.profileId)
  }
  if (e.data && e.data.message === 'profileClearDataRequested' && e.data.profileId !== undefined) {
    ipc.send('profileClearDataRequested', { profileId: e.data.profileId, types: e.data.types })
  }

  /* AI provider tab of the Pro Settings page (min://proSettings): pages run
  with context
  isolation, so they can't call ipc directly — relay these requests and send
  the results back as postMessage events */
  if (e.data && e.data.message === 'agentTestKey') {
    ipc.invoke('agent-test-key', e.data.key).then(function (result) {
      window.postMessage({ message: 'agentTestKeyResult', result: result }, window.location.toString())
    })
  }

  if (e.data && e.data.message === 'agentFetchModels') {
    ipc.invoke('agent-fetch-models').then(function (models) {
      window.postMessage({ message: 'agentFetchModelsResult', models: models }, window.location.toString())
    })
  }

  if (e.data && e.data.message === 'figmaEngine') {
    var allowed = ['status', 'start', 'stop', 'setVisible', 'revealLogin', 'hide']
    if (allowed.indexOf(e.data.action) === -1) return
    ipc.invoke('figmaEngine:' + e.data.action, e.data.payload).then(function (result) {
      window.postMessage({
        message: 'figmaEngineResult',
        action: e.data.action,
        callId: e.data.callId,
        result: result
      }, window.location.toString())
    }).catch(function (err) {
      window.postMessage({
        message: 'figmaEngineResult',
        action: e.data.action,
        callId: e.data.callId,
        result: { ok: false, error: err ? err.message : 'Engine error' }
      }, window.location.toString())
    })
  }

  /* Universal database IPC relay for webviews. Only db:* handlers are allowed. */
  if (e.data && e.data.message === 'dbInvoke' && e.data.action) {
    const allowedDbActions = [
      'db:getPreference', 'db:setPreference',
      'db:getProfiles', 'db:saveProfile', 'db:deleteProfile',
      'db:getSnapshots', 'db:saveSnapshot', 'db:deleteSnapshot',
      'db:getDesigns', 'db:saveDesign', 'db:deleteDesign',
      'db:logTabActivity', 'db:getTabActivities'
    ]
    if (allowedDbActions.indexOf(e.data.action) === -1) {
      return
    }
    const callId = e.data.callId
    ipc.invoke(e.data.action, e.data.payload).then(function (result) {
      window.postMessage({ message: 'dbInvokeResult', callId: callId, result: result }, window.location.toString())
    }).catch(function (err) {
      window.postMessage({ message: 'dbInvokeResult', callId: callId, error: err ? err.message : 'DB Error' }, window.location.toString())
    })
  }
})

ipc.on('receiveSettingsData', function (e, data) {
  if (window.location.toString().startsWith('min://')) { // probably redundant, but might as well check
    window.postMessage({ message: 'receiveSettingsData', settings: data }, window.location.toString())
  }
})

ipc.on('profileDeleteResult', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'profileDeleteResult', result: data }, window.location.toString())
  }
})

ipc.on('profileClearDataResult', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'profileClearDataResult', result: data }, window.location.toString())
  }
})
