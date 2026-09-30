const test = require('node:test')
const assert = require('node:assert/strict')
const { createLifecycleCoordinator } = require('../main/lib/agent/lifecycleCoordinator')
const { serializeAgentEvent, serializeMessages } = require('../main/lib/agent/sessionSerialization')
const { createScopeLoader, createStreamingRenderer } = require('../js/sidebar/agentPanelLifecycle')

function deferred () {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise(function (resolve, reject) {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise: promise, resolve: resolveDeferred, reject: rejectDeferred }
}

test('session setup coalesces identical requests and a newer context prevents stale publication', async () => {
  const lifecycle = createLifecycleCoordinator()
  const setupStarted = deferred()
  const finishSetup = deferred()
  let setupCount = 0
  const published = []
  const first = lifecycle.run('task-1', 'workspace-a', 'ensure', async function (context) {
    setupCount++
    setupStarted.resolve()
    await finishSetup.promise
    if (!context.isCurrent()) return null
    published.push('workspace-a')
    return 'workspace-a'
  })
  const duplicate = lifecycle.run('task-1', 'workspace-a', 'ensure', async function () {
    setupCount++
    return 'duplicate'
  })
  await setupStarted.promise
  assert.equal(duplicate, first)

  const second = lifecycle.run('task-1', 'workspace-b', 'ensure', async function (context) {
    if (!context.isCurrent()) return null
    published.push('workspace-b')
    return 'workspace-b'
  })
  finishSetup.resolve()
  assert.equal(await first, null)
  assert.equal(await second, 'workspace-b')
  assert.equal(setupCount, 1)
  assert.deepEqual(published, ['workspace-b'])
})

test('teardown is ordered after in-flight setup and before later setup', async () => {
  const lifecycle = createLifecycleCoordinator()
  const started = deferred()
  const finish = deferred()
  const order = []
  const setup = lifecycle.run('task-1', 'context', 'first', async function (context) {
    order.push('setup-start')
    started.resolve()
    await finish.promise
    if (!context.isCurrent()) return null
    order.push('setup-publish')
  })
  await started.promise
  const teardown = lifecycle.invalidateAndRun('task-1', async function () {
    order.push('teardown')
  })
  const nextSetup = lifecycle.run('task-1', 'context', 'after-close', async function () {
    order.push('next-setup')
  })
  finish.resolve()
  await Promise.all([setup, teardown, nextSetup])
  assert.deepEqual(order, ['setup-start', 'teardown', 'next-setup'])
})

test('same-context restore requests queue behind the initial prompt setup without cancelling it', async () => {
  const lifecycle = createLifecycleCoordinator()
  const setupStarted = deferred()
  const finishSetup = deferred()
  const order = []
  const context = 'workspace-a/task-a'
  const promptSetup = lifecycle.run('task-a', context, 'ensure', async function (ticket) {
    order.push('prompt-start')
    setupStarted.resolve()
    await finishSetup.promise
    assert.equal(ticket.isCurrent(), true)
    order.push('prompt-published')
    return 'session'
  })
  await setupStarted.promise
  const stateRead = lifecycle.run('task-a', context, 'restoreRecent', async function (ticket) {
    order.push('restore')
    assert.equal(ticket.isCurrent(), true)
    return 'session'
  })
  finishSetup.resolve()
  assert.equal(await promptSetup, 'session')
  assert.equal(await stateRead, 'session')
  assert.deepEqual(order, ['prompt-start', 'prompt-published', 'restore'])
})

test('scope loading ignores late replies from a previous visit to the same task', async () => {
  const requests = []
  const results = []
  const loader = createScopeLoader({
    load: function (scope) {
      const pending = deferred()
      requests.push({ scope: scope, pending: pending })
      return pending.promise
    },
    onResult: function (scope, value, active) {
      results.push({ scope: scope, value: value, active: active })
    }
  })
  const a = { workspaceId: 'a', taskId: 'same', cwd: '/a' }
  const b = { workspaceId: 'b', taskId: 'same', cwd: '/b' }
  const firstA = loader.refresh(a)
  const fromB = loader.refresh(b)
  const secondA = loader.refresh(a)
  await Promise.resolve()
  assert.equal(requests.length, 3)

  requests[0].pending.resolve({ id: 'stale-a' })
  requests[1].pending.resolve({ id: 'cached-b' })
  requests[2].pending.resolve({ id: 'current-a' })
  await Promise.all([firstA, fromB, secondA])
  assert.deepEqual(results.map(result => [result.value.id, result.active]), [
    ['cached-b', false],
    ['current-a', true]
  ])
})

test('stream renderer batches deltas and cancels a detached bubble timer', () => {
  const timers = []
  const rendered = []
  const scrolled = []
  const renderer = createStreamingRenderer({
    setTimeout: fn => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    render: (element, text) => rendered.push([element, text]),
    scroll: () => scrolled.push(true)
  })
  const firstBubble = {}
  renderer.schedule(firstBubble, 'one')
  renderer.schedule(firstBubble, 'one two')
  assert.equal(timers.length, 1)
  timers[0]()
  assert.deepEqual(rendered, [[firstBubble, 'one two']])
  assert.equal(scrolled.length, 1)

  const secondBubble = {}
  renderer.schedule(secondBubble, 'stale')
  const staleTimer = timers[1]
  renderer.cancel()
  staleTimer()
  assert.equal(rendered.length, 1)
  assert.equal(scrolled.length, 1)
})

test('agent event and history serialization keeps text, tool details and compaction summaries', () => {
  assert.deepEqual(serializeAgentEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hello' }
  }), { type: 'delta', deltaType: 'text', delta: 'hello' })
  assert.deepEqual(serializeAgentEvent({
    type: 'tool_execution_start',
    toolName: 'browser',
    args: { action: 'click', selector: '#submit' }
  }), { type: 'tool_start', toolName: 'browser', detail: 'click #submit' })
  assert.deepEqual(serializeMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'read', args: { path: '/tmp/a' } },
          { type: 'text', text: 'answer' }
        ]
      },
      { role: 'compactionSummary', summary: 'older context' }
    ]
  }), [
    { role: 'user', text: 'question' },
    { role: 'tools', items: [{ name: 'read', status: 'done', detail: '/tmp/a' }], expanded: false },
    { role: 'assistant', text: 'answer' },
    { role: 'compact', text: 'older context' }
  ])
})
