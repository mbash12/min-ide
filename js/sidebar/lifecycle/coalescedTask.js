/* Coalesces a burst of notifications into one deferred callback. invalidate()
 * also releases the pending timer when an explicit refresh supersedes it. */
module.exports = function createCoalescedTask (callback, delay) {
  let timer = null
  let pendingValue
  let hasPendingValue = false
  let generation = 0

  return {
    schedule: function (value) {
      pendingValue = value
      hasPendingValue = true
      if (timer !== null) return

      const scheduledGeneration = generation
      timer = setTimeout(function () {
        timer = null
        if (scheduledGeneration !== generation || !hasPendingValue) return
        const value = pendingValue
        pendingValue = undefined
        hasPendingValue = false
        callback(value)
      }, delay || 0)
    },
    invalidate: function () {
      generation++
      if (timer !== null) clearTimeout(timer)
      timer = null
      pendingValue = undefined
      hasPendingValue = false
    }
  }
}
