module.exports = function createRendererRequests ({ send, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let nextId = 0
  const pending = new Map()
  const owners = new Map()

  function release (id) {
    const request = pending.get(id)
    if (!request) return null
    pending.delete(id)
    clearTimer(request.timer)
    const owner = owners.get(request.sender)
    owner.ids.delete(id)
    if (owner.ids.size === 0) {
      request.sender.removeListener('destroyed', owner.closed)
      owners.delete(request.sender)
    }
    return request
  }

  function ask (sender, action, payload, timeout = 8000) {
    if (!sender || sender.isDestroyed()) return Promise.reject(new Error('No browser window'))
    return new Promise(function (resolve, reject) {
      const id = ++nextId
      let owner = owners.get(sender)
      if (!owner) {
        owner = { ids: new Set(), closed: null }
        owner.closed = function () {
          Array.from(owner.ids).forEach(id => {
            const request = release(id)
            if (request) request.reject(new Error('Browser window closed'))
          })
        }
        owners.set(sender, owner)
        sender.once('destroyed', owner.closed)
      }
      owner.ids.add(id)
      const timer = setTimer(function () {
        const request = release(id)
        if (request) request.reject(new Error('Timed out waiting for ' + action))
      }, timeout)
      pending.set(id, { sender, resolve, reject, timer })
      try {
        send(sender, { id, action, payload: payload || {} })
      } catch (error) {
        release(id)
        reject(error)
      }
    })
  }

  function receive (sender, data) {
    const request = data && pending.get(data.id)
    if (!request || request.sender !== sender) return false
    release(data.id)
    if (data.error) request.reject(new Error(data.error))
    else request.resolve(data.result)
    return true
  }

  return { ask, receive }
}
