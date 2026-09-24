const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const createTabStateRequests = require('../main/lib/window/tabStateRequests.js')

function harness () {
  const timers = new Map()
  const warnings = []
  let nextTimer = 0
  const requests = createTabStateRequests({
    timeoutMs: 100,
    setTimeout: fn => {
      const timerId = ++nextTimer
      timers.set(timerId, fn)
      return timerId
    },
    clearTimeout: timerId => timers.delete(timerId),
    warn: message => warnings.push(message)
  })
  function source (id) {
    const contents = new EventEmitter()
    contents.id = id
    contents.messages = []
    contents.isDestroyed = () => false
    contents.send = (...args) => contents.messages.push(args)
    return contents
  }
  return { requests, source, timers, warnings }
}

test('tab-state replies are correlated by request and expected renderer', () => {
  const h = harness()
  const sourceA = h.source(21)
  const sourceB = h.source(22)
  const eventA = { returnValue: undefined }
  const eventB = { returnValue: undefined }
  const requestA = h.requests.begin(eventA, sourceA)
  const requestB = h.requests.begin(eventB, sourceB)

  assert.deepEqual(sourceA.messages, [['read-tab-state', requestA]])
  assert.deepEqual(sourceB.messages, [['read-tab-state', requestB]])
  assert.equal(h.requests.receive(sourceB.id, { requestId: requestA, state: { workspaces: ['wrong'] } }), false)
  assert.equal(eventA.returnValue, undefined)

  assert.equal(h.requests.receive(sourceB.id, { requestId: requestB, state: { workspaces: ['b'] } }), true)
  assert.equal(h.requests.receive(sourceA.id, { requestId: requestA, state: { workspaces: ['a'] } }), true)
  assert.deepEqual(eventA.returnValue, { workspaces: ['a'] })
  assert.deepEqual(eventB.returnValue, { workspaces: ['b'] })
  assert.equal(h.timers.size, 0)
  assert.equal(h.warnings.length, 0)
})

test('untagged stale state replies cannot be mistaken for a current request', () => {
  const h = harness()
  const source = h.source(31)
  const first = { returnValue: undefined }
  const second = { returnValue: undefined }
  const firstId = h.requests.begin(first, source)
  h.requests.begin(second, source)

  assert.equal(h.requests.receive(source.id, { workspaces: ['ambiguous'] }), false)
  assert.equal(first.returnValue, undefined)
  assert.equal(second.returnValue, undefined)

  assert.equal(h.requests.receive(source.id, { requestId: firstId, state: { workspaces: ['first'] } }), true)
  assert.equal(h.requests.receive(source.id, { workspaces: ['late legacy response'] }), false)
  assert.deepEqual(first.returnValue, { workspaces: ['first'] })
  assert.equal(second.returnValue, undefined)
  assert.equal(h.requests.receive(source.id, { requestId: source.messages[1][1], state: { workspaces: ['second'] } }), true)
  assert.deepEqual(second.returnValue, { workspaces: ['second'] })
})

test('a destroyed source or timed-out request releases its synchronous caller safely', () => {
  const h = harness()
  const deadSource = h.source(41)
  const deadEvent = { returnValue: undefined }
  h.requests.begin(deadEvent, deadSource)
  deadSource.emit('destroyed')
  assert.deepEqual(deadEvent.returnValue, { workspaces: [] })

  const slowSource = h.source(42)
  const slowEvent = { returnValue: undefined }
  const slowId = h.requests.begin(slowEvent, slowSource)
  const timer = Array.from(h.timers.values())[0]
  timer()
  assert.deepEqual(slowEvent.returnValue, { workspaces: [] })
  assert.equal(h.requests.receive(slowSource.id, { requestId: slowId, state: { workspaces: ['late'] } }), false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.warnings.length, 2)
})
