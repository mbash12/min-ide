/* global ipc */
/* Restricted bridge for the internal Notes editor page. The page is sandboxed;
only global note operations are relayed to the main process. Notes never reach
the AI agent: there are no agent tools for them anywhere in the bundle. */

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://') || !e.data || e.data.message !== 'notes-invoke') return

  const channels = {
    list: 'db:listNotes',
    get: 'db:getNote',
    create: 'db:createNote',
    update: 'db:updateNote',
    delete: 'db:deleteNote'
  }
  const channel = channels[e.data.action]
  if (!channel) return

  const requestId = e.data.requestId
  ipc.invoke(channel, e.data.payload).then(function (result) {
    if (result && result.ok !== false && ['create', 'update', 'delete'].indexOf(e.data.action) !== -1) {
      ipc.send('notesChanged', {
        note: result.note || null,
        deletedId: e.data.action === 'delete' ? e.data.payload.id : null
      })
    }
    window.postMessage({
      message: 'notes-result',
      requestId: requestId,
      result: result
    }, window.location.toString())
  }).catch(function (err) {
    window.postMessage({
      message: 'notes-result',
      requestId: requestId,
      result: { ok: false, error: err && err.message ? err.message : 'Notes request failed' }
    }, window.location.toString())
  })
})
