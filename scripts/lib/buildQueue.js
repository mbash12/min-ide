// Collapse file watcher bursts and never let builds write the same output
// concurrently. Changes during a build get one follow-up build.
module.exports = function createBuildQueue (build) {
  let running = null
  let dirty = false
  return function schedule () {
    dirty = true
    if (running) return running
    running = Promise.resolve().then(async function () {
      while (dirty) {
        dirty = false
        await build()
      }
    }).finally(function () {
      running = null
      if (dirty) return schedule()
    })
    return running
  }
}
