const test = require('node:test')
const assert = require('node:assert/strict')
const createBuildQueue = require('./lib/buildQueue.js')
const createImageQueue = require('../js/webviews/imageQueue.js')

function deferred () {
  let complete
  let fail
  const promise = new Promise((resolve, reject) => { complete = resolve; fail = reject })
  return { promise, resolve: complete, reject: fail }
}

test('watcher bursts coalesce and changes during a build run serially afterward', async () => {
  const first = deferred()
  let calls = 0
  let active = 0
  const schedule = createBuildQueue(async () => {
    assert.equal(++active, 1)
    if (++calls === 1) await first.promise
    active--
  })
  const result = schedule()
  assert.equal(schedule(), result)
  await Promise.resolve()
  for (let i = 0; i < 20; i++) assert.equal(schedule(), result)
  first.resolve()
  await result
  assert.equal(calls, 2)
  assert.equal(active, 0)
})

test('a failed build does not lose a newer watcher change or block later builds', async () => {
  const first = deferred()
  let calls = 0
  const schedule = createBuildQueue(async () => {
    if (++calls === 1) await first.promise
  })
  const result = schedule()
  const rejected = assert.rejects(result, /invalid source/)
  await Promise.resolve()
  schedule()
  first.reject(new Error('invalid source'))
  await rejected
  assert.equal(calls, 2)
  await schedule()
  assert.equal(calls, 3)
})

test('favicon decoding coalesces pending tabs and discards stale navigation results', () => {
  const images = []
  const scheduled = []
  const loaded = []
  const enqueue = createImageQueue(() => {
    const image = {}
    images.push(image)
    return image
  }, fn => scheduled.push(fn))
  let current = true
  function job (url, isCurrent = () => true) {
    return { url, isCurrent, loaded: image => loaded.push(image.src) }
  }
  enqueue('a', job('old-a', () => current))
  scheduled.shift()()
  enqueue('b', job('old-b'))
  enqueue('b', job('new-b'))
  enqueue('closed', job('closed-icon', () => false))
  current = false
  images[0].onload()
  scheduled.shift()()
  assert.equal(images[1].src, 'new-b')
  images[1].onload()
  scheduled.shift()()
  assert.deepEqual(loaded, ['new-b'])
  assert.equal(images.length, 2)
  assert.equal(scheduled.length, 0)
})

test('a failed favicon cannot stall the queue or finish the next decode twice', () => {
  const images = []
  const scheduled = []
  const loaded = []
  const enqueue = createImageQueue(() => {
    const image = {}
    images.push(image)
    return image
  }, fn => scheduled.push(fn))
  function job (url) { return { url, isCurrent: () => true, loaded: image => loaded.push(image.src) } }
  enqueue('a', job('a'))
  scheduled.shift()()
  enqueue('b', job('b'))
  enqueue('c', job('c'))
  const lateError = images[0].onerror
  lateError()
  scheduled.shift()()
  lateError()
  assert.equal(scheduled.length, 0)
  images[1].onload()
  scheduled.shift()()
  images[2].onload()
  assert.deepEqual(loaded, ['b', 'c'])
})
