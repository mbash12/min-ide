// Favicon bursts share one decoder. Pending work for the same tab is replaced
// and handlers always belong to the image being decoded, never another tab.
module.exports = function createImageQueue (createImage, schedule = fn => setTimeout(fn, 0)) {
  const pending = new Map()
  let running = false
  function next () {
    if (running || pending.size === 0) return
    running = true
    schedule(function () {
      const [key, job] = pending.entries().next().value
      pending.delete(key)
      if (!job.isCurrent()) {
        running = false
        next()
        return
      }
      const image = createImage()
      const timer = setTimeout(finish, 8000)
      let finished = false
      function finish () {
        if (finished) return
        finished = true
        clearTimeout(timer)
        image.onload = image.onerror = null
        image.src = ''
        running = false
        next()
      }
      image.onload = function () {
        try {
          if (job.isCurrent()) job.loaded(image)
        } catch (error) {
          // Cross-origin images can be displayed even when canvas reads fail.
        } finally {
          finish()
        }
      }
      image.onerror = finish
      image.src = job.url
    })
  }
  return function enqueue (key, job) {
    pending.set(key, job)
    next()
  }
}
