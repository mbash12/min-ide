/* Correlates synchronous window-state requests with replies from a particular
   renderer. Dependencies are injected so races can be tested without Electron. */

module.exports = function createTabStateRequests (options) {
  options = options || {}
  var setTimer = options.setTimeout || setTimeout
  var clearTimer = options.clearTimeout || clearTimeout
  var timeoutMs = options.timeoutMs || 15000
  var fallback = options.fallback || function () { return { workspaces: [] } }
  var warn = options.warn || function () {}
  var pending = new Map()
  var nextId = 0

  function cleanup (request) {
    clearTimer(request.timer)
    if (request.contents && request.destroyedListener && request.contents.removeListener) {
      request.contents.removeListener('destroyed', request.destroyedListener)
    }
  }

  function finish (id, state) {
    var request = pending.get(id)
    if (!request) return false
    pending.delete(id)
    cleanup(request)
    if (!state || !Array.isArray(state.workspaces)) state = fallback()
    request.event.returnValue = state
    return true
  }

  function fail (id, reason) {
    if (!pending.has(id)) return false
    warn('Could not read tab state from another window: ' + reason)
    return finish(id, fallback())
  }

  function begin (event, contents) {
    var id = 'tab-state-' + (++nextId)
    var request = {
      event: event,
      senderId: contents.id,
      contents: contents,
      timer: null,
      destroyedListener: null
    }
    pending.set(id, request)
    request.timer = setTimer(function () { fail(id, 'request timed out') }, timeoutMs)
    request.destroyedListener = function () { fail(id, 'source window was destroyed') }
    if (contents.once) contents.once('destroyed', request.destroyedListener)

    try {
      if (contents.isDestroyed && contents.isDestroyed()) {
        fail(id, 'source window was destroyed')
      } else {
        contents.send('read-tab-state', id)
      }
    } catch (error) {
      fail(id, error && error.message ? error.message : 'request could not be sent')
    }
    return id
  }

  function receive (senderId, payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.requestId !== 'string') return false
    var request = pending.get(payload.requestId)
    if (!request || request.senderId !== senderId) return false
    return finish(payload.requestId, payload.state)
  }

  return { begin: begin, receive: receive }
}
