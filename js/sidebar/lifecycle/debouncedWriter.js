/* Debounces keyed state writes and serializes writes to the same key. This
 * keeps rapid tree expansion from producing a queue of obsolete snapshots. */
module.exports = function createDebouncedWriter (write, delay) {
  const pending = new Map()
  const timers = new Map()
  const writing = new Map()
  let disposed = false

  function flush (key) {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    if (!pending.has(key)) return writing.get(key) || Promise.resolve()

    const value = pending.get(key)
    pending.delete(key)
    const previous = writing.get(key) || Promise.resolve()
    const operation = previous.catch(function () {}).then(function () {
      return write(key, value)
    })
    writing.set(key, operation)

    return operation.catch(function () {}).then(function () {
      if (writing.get(key) === operation) writing.delete(key)
      if (pending.has(key) && !timers.has(key) && !disposed) schedule(key, pending.get(key))
    })
  }

  function schedule (key, value) {
    if (disposed) return
    pending.set(key, value)
    const oldTimer = timers.get(key)
    if (oldTimer !== undefined) clearTimeout(oldTimer)
    timers.set(key, setTimeout(function () {
      timers.delete(key)
      flush(key)
    }, delay || 0))
  }

  function cancel (key) {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    pending.delete(key)
  }

  function dispose () {
    disposed = true
    timers.forEach(function (timer) { clearTimeout(timer) })
    timers.clear()
    pending.clear()
  }

  return { schedule: schedule, flush: flush, cancel: cancel, dispose: dispose }
}
