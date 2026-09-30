/* global ipc, l */
/* The question the main process asks before the AI assistant writes a file or
runs a command outside its workspace (main/lib/agent/approval.js). Questions
are answered one at a time: promptModal shows a single dialog, and a second
one would cancel the first. A question the main process withdraws (the turn
was stopped, the session ended) closes its dialog without an answer. */

const promptModal = require('promptModal.js')

const MAX_DETAIL_LENGTH = 500

const INTRO_KEYS = {
  bash: 'agentApprovalRunCommand',
  write: 'agentApprovalWriteFile',
  edit: 'agentApprovalEditFile'
}

let queue = Promise.resolve()
let current = null
const withdrawn = new Set()

function buildMessage (request) {
  let detail = String(request.detail || '')
  if (detail.length > MAX_DETAIL_LENGTH) detail = detail.slice(0, MAX_DETAIL_LENGTH) + '…'
  return [
    l(INTRO_KEYS[request.toolName] || 'agentApprovalRunCommand'),
    detail,
    (request.reasons || []).join('\n')
  ].join('\n\n')
}

function ask (request) {
  queue = queue.then(async function () {
    if (withdrawn.delete(request.requestId)) return
    current = request.requestId
    let allow = false
    try {
      allow = await promptModal.confirm({
        title: l('agentApprovalTitle'),
        message: buildMessage(request),
        ok: l('agentApprovalAllow'),
        cancel: l('agentApprovalDeny')
      })
    } finally {
      current = null
    }
    if (withdrawn.delete(request.requestId)) return
    ipc.send('agent-approval-respond', { requestId: request.requestId, allow: allow === true })
  }).catch(function () {})
}

ipc.on('agent-approval-request', function (e, request) {
  if (request && typeof request.requestId === 'number') ask(request)
})

ipc.on('agent-approval-cancel', function (e, data) {
  if (!data) return
  withdrawn.add(data.requestId)
  if (current === data.requestId) promptModal.dismiss()
})

module.exports = { buildMessage: buildMessage }
