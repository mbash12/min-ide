const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

function harness (t, handler) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'min-playbook-test-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const calls = []
  const events = []
  const scope = { taskId: 'task', workspaceId: 'workspace' }
  const context = vm.createContext({
    require,
    fs,
    path,
    console,
    app: { getPath: () => cwd },
    ipc: { handle () {} },
    isPathInside: (root, candidate) => candidate.startsWith(root + path.sep),
    windows: { getAll: () => [{}] },
    getWindowWebContents: () => ({ send: (channel, data) => events.push(data) }),
    minBrowser: {
      tabs: async (operation, params) => {
        assert.equal(params.workspaceId, 'workspace')
        return { ok: true, taskId: 'task', tabs: [{ id: 'first' }], selected: 'first' }
      },
      runStep: async step => {
        calls.push(JSON.parse(JSON.stringify(step)))
        assert.equal(step.taskId, 'task')
        assert.equal(step.workspaceId, 'workspace')
        if (handler) return handler(step, context)
        return { ok: true, tabId: step.tabId }
      }
    }
  })
  context.global = context
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/browserCommands.js'), 'utf8'), context)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/playbook.js'), 'utf8'), context)
  function save (book) { const result = context.savePlaybook(cwd, Object.assign({ name: 'test' }, book), 'workspace'); assert.equal(result.ok, true, result.error) }
  return { context, calls, events, cwd, scope, save, run: (vars, options) => context.runPlaybook(cwd, 'test', vars || {}, Object.assign({}, scope, options)) }
}

test('v1 recipes survive; stable locators and validated hooks/cases are persisted', t => {
  const h = harness(t)
  h.save({ steps: [{ action: 'fill', label: 'Email', value: 'hello' }] })
  const loaded = h.context.getPlaybook(h.cwd, 'test', 'workspace')
  assert.equal(loaded.playbook.steps[0].label, 'Email')
  assert.equal(loaded.playbook.repeat, 1)
  assert.equal(loaded.playbook.setup.length, 0)
  for (const invalid of [
    { steps: [{ action: 'click', ref: 'f1' }] },
    { steps: [{ action: 'constructor' }] },
    { steps: [{ action: 'assert', taskId: 'outside' }] },
    { steps: [{ action: 'assert' }], repeat: 0 },
    { steps: [{ action: 'assert' }], cases: [{}] }
  ]) assert.equal(h.context.savePlaybook(h.cwd, Object.assign({ name: 'invalid' }, invalid), 'workspace').ok, false)
})

test('all variables preflight before mutations; nested whole placeholders preserve types', async t => {
  const h = harness(t)
  h.save({ vars: { width: 640, enabled: false }, steps: [{ action: 'viewport', width: '{{width}}', height: 400, mobile: '{{enabled}}' }, { action: 'screenshot', clip: { x: '{{missing}}', y: 0, width: 10, height: 10 } }] })
  const invalid = await h.run()
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /Missing playbook variable: missing/)
  assert.equal(h.calls.length, 0)
  const valid = await h.run({ missing: 2 })
  assert.equal(valid.ok, true, valid.error)
  const step = h.calls.find(c => c.action === 'viewport')
  assert.equal(step.width, 640)
  assert.equal(step.mobile, false)
  assert.equal(h.calls.find(c => c.action === 'screenshot').clip.x, 2)
  assert.equal((await h.run([])).ok, false)
})

test('setup/teardown repeat for each data case, with pinned task/tab and persistent history', async t => {
  const h = harness(t)
  h.save({
    repeat: 2,
    vars: { value: 'default' },
    cases: [{ name: 'a', vars: { value: 'A' } }, { name: 'b', vars: { value: 'B' } }],
    setup: [{ action: 'navigate', url: 'https://example.test/{{value}}' }],
    steps: [{ action: 'fill', label: 'Email', value: '{{value}}' }, { action: 'assert', condition: 'value', label: 'Email', expected: '{{value}}' }],
    teardown: [{ action: 'fill', label: 'Email', value: '' }]
  })
  const result = await h.run({ value: 'override' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.scenarios.length, 4)
  assert.equal(result.summary.passed, 16)
  assert.equal(h.calls.filter(c => c.action === 'navigate').length, 4)
  assert.ok(h.calls.every(c => c.tabId === 'first'))
  assert.ok(h.calls.filter(c => c.action === 'navigate').every(c => c.url.endsWith('/override')))
  assert.equal(JSON.parse(fs.readFileSync(result.reportPath)).status, 'passed')
  assert.equal(h.context.listPlaybooks(h.cwd, 'workspace').playbooks[0].lastRun.runId, result.runId)
  assert.equal(h.context.playbookReports(h.cwd, 'test', 'workspace').reports.length, 1)
  assert.equal(h.context.playbookReports(h.cwd, 'test', 'workspace', result.runId).report.summary.passed, 16)
  assert.equal(h.context.playbookReports(h.cwd, 'test', 'workspace', '../../x').ok, false)
  const override = await h.run({}, { repeat: 1 })
  assert.equal(override.summary.scenarios, 2)
  assert.equal(h.context.playbookReports(h.cwd, 'test', 'workspace').reports.length, 2)
})

test('continueOnError cannot turn failures green; assertion evidence reaches saved report', async t => {
  const h = harness(t, async step => {
    if (step.action === 'assert') return { ok: false, error: 'wrong value', expected: 'ready', actual: 'loading', condition: 'text', attempts: 3 }
    if (step.action === 'screenshot') return { ok: true, path: path.join(step.outputDir, 'failure.png'), images: [] }
    return { ok: true }
  })
  h.save({ steps: [{ action: 'assert', selector: '#state', continueOnError: true }, { action: 'click', testId: 'next' }], teardown: [{ action: 'fill', label: 'Email', value: '' }] })
  const result = await h.run()
  assert.equal(result.ok, false)
  assert.equal(result.summary.failed, 1)
  assert.equal(result.summary.passed, 2)
  assert.equal(result.results[0].actual, 'loading')
  assert.ok(result.results[0].evidence.path.endsWith('failure.png'))
  assert.equal(h.events.at(-1).ok, false)
  assert.equal(JSON.parse(fs.readFileSync(result.reportPath)).results[0].expected, 'ready')
})

test('exceptions skip later body steps, always attempt teardown, and unlock next run', async t => {
  const h = harness(t, async step => {
    if (step.action === 'click') throw new Error('closed tab')
    if (step.action === 'screenshot') throw new Error('cannot capture closed tab')
    return { ok: true }
  })
  h.save({ steps: [{ action: 'click', testId: 'submit' }, { action: 'assert', testId: 'result' }], teardown: [{ action: 'fill', label: 'Email', value: '' }] })
  for (let i = 0; i < 2; i++) {
    const result = await h.run()
    assert.equal(result.ok, false)
    assert.equal(result.results[1].status, 'skipped')
    assert.equal(result.results[2].phase, 'teardown')
    assert.equal(result.results[2].status, 'passed')
    assert.match(result.results[0].evidence.error, /closed tab/)
  }
  assert.equal(h.calls.filter(c => c.action === 'click').length, 2)
})

test('visual thresholds fail runs while retaining the diff image evidence', async t => {
  const h = harness(t, async step => step.action === 'compare' ? { ok: true, assertion: { passed: false, expected: 0.01, actual: 0.2, ready: true }, images: [{ label: 'diff', path: '/diff.png' }] } : { ok: true })
  h.save({ steps: [{ action: 'compare', referencePath: '/ref.png', maxMismatchRatio: 0.01 }] })
  const result = await h.run()
  assert.equal(result.ok, false)
  assert.equal(result.results[0].images[0].label, 'diff')
  assert.equal(h.calls.filter(c => c.action === 'screenshot').length, 0)
})

test('cancel is workspace scoped, never replays actions, and finishes teardown', async t => {
  const h = harness(t, async (step, context) => {
    if (step.action === 'click') {
      assert.equal(context.cancelPlaybook('outside', 'test').ok, false)
      assert.equal(context.cancelPlaybook('workspace', 'other').ok, false)
      assert.equal(context.cancelPlaybook('workspace', 'test').ok, true)
    }
    return { ok: true }
  })
  h.save({ repeat: 3, steps: [{ action: 'click', testId: 'submit' }, { action: 'assert', testId: 'done' }], teardown: [{ action: 'fill', label: 'Email', value: '' }] })
  const result = await h.run()
  assert.equal(result.status, 'cancelled')
  assert.equal(result.ok, false)
  assert.equal(result.summary.plannedScenarios, 3)
  assert.equal(h.calls.filter(c => c.action === 'click').length, 1)
  assert.equal(h.calls.filter(c => c.action === 'fill').length, 1)
  assert.equal(h.context.cancelPlaybook('workspace').ok, false)
})

test('explicit tab operations advance the pinned tab and foreign initial tabs fail', async t => {
  const h = harness(t, async step => step.action === 'tabs' ? { ok: true, id: 'second' } : { ok: true })
  h.save({ steps: [{ action: 'tabs', operation: 'new' }, { action: 'assert', condition: 'title', expected: 'x' }] })
  assert.equal((await h.run({}, { tabId: 'outside' })).ok, false)
  assert.equal(h.calls.length, 0)
  const result = await h.run()
  assert.equal(result.ok, true, result.error)
  assert.equal(h.calls.find(c => c.action === 'assert').tabId, 'second')
})

test('renderer resolves the requested task and validates workspace before switching', () => {
  const switches = []
  const tab = { id: 'tab', kind: 'web', url: 'https://example.test' }
  const task = { id: 'task', tabs: { get: id => id ? tab : [tab], has: id => id === tab.id, getSelected: () => tab.id } }
  const home = { id: 'workspace', tasks: { get: id => id === task.id ? task : null, getSelected: () => task } }
  const browserUI = { switchToWorkspace: id => switches.push(id), switchToTask: id => switches.push(id) }
  const webviews = { hasViewForTab: () => true }
  const context = vm.createContext({
    require: name => name === 'browserUI.js' ? browserUI : webviews,
    module: {},
    ipc: {},
    tasks: { getSelected: () => task },
    workspaces: { get: id => id === home.id ? home : null, findWorkspaceContainingTask: id => id === task.id ? home : null, getSelected: () => ({ id: 'outside' }) }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/browserControlRenderer.js'), 'utf8'), context)
  assert.equal(context.handleBrowserControl('listTabs', { taskId: 'task', workspaceId: 'workspace' }).taskId, 'task')
  assert.equal(context.handleBrowserControl('listTabs', { workspaceId: 'workspace' }).taskId, 'task')
  assert.equal(context.handleBrowserControl('listTabs', { taskId: 'task', workspaceId: 'outside' }).ok, false)
  assert.throws(() => context.resolveTab({ taskId: 'task', workspaceId: 'outside', ensureView: true }), /Task not found/)
  assert.equal(switches.length, 0)
  assert.equal(context.resolveTab({ workspaceId: 'workspace', tabId: 'foreign' }).ok, false)
})
