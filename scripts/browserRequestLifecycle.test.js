const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const createRequests = require('../main/lib/browser/rendererRequests.js')

test('many concurrent browser commands share one teardown hook and release it when finished', async () => {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const sent = []
  const requests = createRequests({ send: (sender, message) => sent.push(message) })
  const results = Array.from({ length: 100 }, () => requests.ask(sender, 'listTabs'))
  assert.equal(sender.listenerCount('destroyed'), 1)
  sent.forEach(message => requests.receive(sender, { id: message.id, result: 'done' }))
  assert.equal((await Promise.all(results)).length, 100)
  assert.equal(sender.listenerCount('destroyed'), 0)
})

test('window destruction rejects pending commands immediately and late replies are ignored', async () => {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const requests = createRequests({ send () {} })
  const result = requests.ask(sender, 'snapshot')
  sender.emit('destroyed')
  await assert.rejects(result, /window closed/)
  assert.equal(requests.receive(sender, { id: 1, result: 'late' }), false)
  assert.equal(sender.listenerCount('destroyed'), 0)
})

test('only the requested renderer can satisfy a command and transport errors clean up', async () => {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const requests = createRequests({ send () {} })
  const result = requests.ask(sender, 'listTabs')
  assert.equal(requests.receive({}, { id: 1, result: 'wrong' }), false)
  requests.receive(sender, { id: 1, result: 'right' })
  assert.equal(await result, 'right')
  const broken = createRequests({ send () { throw new Error('send failed') } })
  await assert.rejects(broken.ask(sender, 'listTabs'), /send failed/)
  assert.equal(sender.listenerCount('destroyed'), 0)
})
