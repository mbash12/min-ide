/* global ipc */
/* Custom Data Store Client Helper
Provides a clean promise-based API to interact with the Centralized Database Service (dbService.js)
from any UI window or webview page.
*/

const pendingCalls = {}
let callCounter = 0

if (typeof window !== 'undefined') {
  window.addEventListener('message', function (e) {
    if (e.data && e.data.message === 'dbInvokeResult' && e.data.callId) {
      const pending = pendingCalls[e.data.callId]
      if (pending) {
        delete pendingCalls[e.data.callId]
        if (e.data.error) {
          pending.reject(new Error(e.data.error))
        } else {
          pending.resolve(e.data.result)
        }
      }
    }
  })
}

function invokeDB (action, payload) {
  return new Promise((resolve, reject) => {
    // If running in main UI process where ipcRenderer is available
    if (typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke(action, payload).then(resolve).catch(reject)
      return
    }
    if (typeof ipc !== 'undefined' && ipc.invoke) {
      ipc.invoke(action, payload).then(resolve).catch(reject)
      return
    }

    // Otherwise relay via postMessage (for webviews)
    const callId = 'call-' + (++callCounter) + '-' + Date.now()
    pendingCalls[callId] = { resolve, reject }
    window.postMessage({
      message: 'dbInvoke',
      callId: callId,
      action: action,
      payload: payload
    }, window.location.toString())
  })
}

const customDataStore = {
  // User Preferences
  getPreference: (key) => invokeDB('db:getPreference', key),
  setPreference: (key, value) => invokeDB('db:setPreference', { key, value }),

  // Workspace Profiles
  getProfiles: () => invokeDB('db:getProfiles'),
  saveProfile: (profile) => invokeDB('db:saveProfile', profile),
  deleteProfile: (profileId) => invokeDB('db:deleteProfile', profileId),

  // Workspace Snapshots
  getSnapshots: (workspaceId) => invokeDB('db:getSnapshots', workspaceId),
  saveSnapshot: (snapshot) => invokeDB('db:saveSnapshot', snapshot),
  deleteSnapshot: (snapshotId) => invokeDB('db:deleteSnapshot', snapshotId),

  // Design Documents
  getDesigns: (workspaceId) => invokeDB('db:getDesigns', workspaceId),
  saveDesign: (design) => invokeDB('db:saveDesign', design),
  deleteDesign: (designId) => invokeDB('db:deleteDesign', designId),

  // Workspace cascade cleanup (documents, designs, snapshots, activities)
  deleteWorkspaceDocuments: (workspaceId) => invokeDB('db:deleteWorkspaceData', workspaceId),

  // Workspace Documents
  listDocuments: (workspaceId) => invokeDB('db:listDocuments', workspaceId),
  getDocument: (workspaceId, id) => invokeDB('db:getDocument', { workspaceId, id }),
  createDocument: (workspaceId, title) => invokeDB('db:createDocument', { workspaceId, title }),
  updateDocument: (workspaceId, id, changes) => invokeDB('db:updateDocument', Object.assign({ workspaceId, id }, changes || {})),
  deleteDocument: (workspaceId, id) => invokeDB('db:deleteDocument', { workspaceId, id }),

  // Tab Activity Logs
  logTabActivity: (activity) => invokeDB('db:logTabActivity', activity),
  getTabActivities: (workspaceId, limit) => invokeDB('db:getTabActivities', { workspaceId, limit })
}

if (typeof module !== 'undefined') {
  module.exports = customDataStore
}
