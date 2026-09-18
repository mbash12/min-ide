/* global ipc */
/* Restricted bridge for the internal Docs editor page. The page is sandboxed;
only workspace-scoped document operations are relayed to the main process. */

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://') || !e.data || e.data.message !== 'docs-invoke') return

  const channels = {
    list: 'db:listDocuments',
    get: 'db:getDocument',
    create: 'db:createDocument',
    update: 'db:updateDocument',
    delete: 'db:deleteDocument'
  }
  const channel = channels[e.data.action]
  if (!channel) return

  const requestId = e.data.requestId
  ipc.invoke(channel, e.data.payload).then(function (result) {
    if (result && result.ok !== false && ['create', 'update', 'delete'].indexOf(e.data.action) !== -1) {
      ipc.send('docsChanged', {
        workspaceId: e.data.payload && e.data.payload.workspaceId,
        document: result.document || null,
        deletedId: e.data.action === 'delete' ? e.data.payload.id : null
      })
    }
    window.postMessage({
      message: 'docs-result',
      requestId: requestId,
      result: result
    }, window.location.toString())
  }).catch(function (err) {
    window.postMessage({
      message: 'docs-result',
      requestId: requestId,
      result: { ok: false, error: err && err.message ? err.message : 'Docs request failed' }
    }, window.location.toString())
  })
})
