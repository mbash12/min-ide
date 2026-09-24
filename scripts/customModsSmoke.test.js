/* Full Min renderer + main process smoke test, using an isolated profile.
   Run through runCustomModsSmoke.js after npm run build. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { app, ipcMain, webContents } = require('electron')
const scratchArg = process.argv.find(arg => arg.startsWith('--min-smoke-dir='))
if (!scratchArg) throw new Error('Run through scripts/runCustomModsSmoke.js')
const scratch = scratchArg.slice('--min-smoke-dir='.length)
const root = path.resolve(__dirname, '..')
const profile = path.join(scratch, 'profile')
fs.mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const tab = { id: 'seed-tab', url: 'min://newtab', title: '', selected: true, lastActivity: Date.now(), kind: 'web' }
fs.writeFileSync(path.join(profile, 'sessionRestore.json'), JSON.stringify({ version: 3, state: { workspaces: [{ id: 'seed', name: 'Smoke', activeTaskId: 'seed-task', tasks: [{ id: 'seed-task', tabs: [tab] }] }] } }))
const errors = []
app.on('web-contents-created', (event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.on('console-message', event => {
    const text = event.message || ''
    if (/Uncaught|Task state listener failed/.test(text)) errors.push({ message: text, source: event.sourceId, line: event.lineNumber, url: contents.getURL() })
  })
  contents.on('render-process-gone', (event, details) => { errors.push('Renderer exited: ' + details.reason) })
})
const watchdog = setTimeout(() => { console.error('Custom feature smoke timed out'); app.exit(1) }, 90000)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Execute the actual compiled entry point; only window visibility is changed
// by this harness so it never takes focus while testing the application.
const entry = new Module(path.join(root, 'main.build.js'), module)
entry.filename = path.join(root, 'main.build.js')
entry.paths = Module._nodeModulePaths(root)
entry._compile(fs.readFileSync(entry.filename, 'utf8').replace('new BaseWindow({', 'new BaseWindow({ show: false,'), entry.filename)

async function run () {
  await app.whenReady()
  let ui
  for (let i = 0; i < 300; i++) {
    ui = webContents.getAllWebContents().find(contents => contents.getURL() === 'min://app/index.html')
    if (ui && await ui.executeJavaScript('Boolean(window.sidebar && window.workspaceDrawer && window.workspaces && window.tabs)').catch(() => false)) break
    await delay(50)
  }
  assert.ok(ui, 'main renderer loaded')
  assert.deepEqual(errors, [], 'startup has no renderer errors')
  const pending = new Map()
  ipcMain.on('browser-control-result', (event, data) => {
    const finish = pending.get(data.id)
    if (finish) { pending.delete(data.id); finish(data) }
  })
  let id = 0
  async function control (action, payload) {
    const requestId = 'smoke-' + (++id)
    const result = new Promise(resolve => pending.set(requestId, resolve))
    ui.send('browser-control', { id: requestId, action, payload })
    const reply = await result
    assert.ok(!reply.error, reply.error)
    assert.equal(reply.result.ok, true, reply.result.error)
    return reply.result
  }
  const setup = await ui.executeJavaScript(`(() => {
    for (let w = 0; w < 40; w++) {
      workspaces.add({ id: 'stress-' + w, name: 'Workspace ' + w, tasks: Array.from({ length: 5 }, (_, t) => ({
        id: 'task-' + w + '-' + t,
        tabs: Array.from({ length: 20 }, (_, i) => ({ id: 'tab-' + w + '-' + t + '-' + i, kind: 'web', url: i === 0 ? 'min://newtab' : '', title: '', selected: i === 0, lastActivity: 1 }))
      })) }, undefined, false)
    }
    const start = performance.now()
    for (let i = 0; i < 5000; i++) {
      const id = 'tab-' + (i % 40) + '-4-19'
      const task = workspaces.findTaskContainingTab(id)
      task.tabs.update(id, { title: String(i) }, false)
    }
    workspaceDrawer.show()
    const rows = document.querySelectorAll('.ws-row').length
    const first = document.querySelector('.ws-row')
    workspaceDrawer.render()
    const retained = document.querySelector('.ws-row') === first
    workspaceDrawer.hide()
    return { tabs: workspaces.index.tabs.size, lookupMs: performance.now() - start, rows, retained }
  })()`)
  assert.equal(setup.tabs, 4001)
  assert.equal(setup.rows, 41)
  assert.equal(setup.retained, true, 'unchanged drawer rows stay attached')
  for (let i = 0; i < 35; i++) {
    const w = i % 10
    await control('resolveTab', { workspaceId: 'stress-' + w, taskId: 'task-' + w + '-0', tabId: 'tab-' + w + '-0-0', ensureView: true })
  }
  await delay(350)
  const selected = await ui.executeJavaScript('({ workspace: workspaces.getSelected().id, task: tasks.getSelected().id, tab: tabs.getSelected(), sidebar: sidebar.currentWorkspaceId })')
  assert.deepEqual(selected, { workspace: 'stress-4', task: 'task-4-0', tab: 'tab-4-0-0', sidebar: 'stress-4' })
  // Delayed page events from a background workspace must not touch this task.
  ui.send('view-event', { event: 'page-title-updated', tabId: 'tab-0-0-0', args: ['Background title', true] })
  await delay(100)
  assert.equal(await ui.executeJavaScript('workspaces.findTask(\'task-0-0\').tabs.get(\'tab-0-0-0\').title'), 'Background title')
  ui.send('view-event', { event: 'page-title-updated', tabId: 'tab-0-0-0', generation: 'obsolete-view', args: ['Stale title', true] })
  await delay(30)
  assert.equal(await ui.executeJavaScript('workspaces.findTask(\'task-0-0\').tabs.get(\'tab-0-0-0\').title'), 'Background title')
  ui.send('view-event', { event: 'did-stop-loading', tabId: 'tab-0-0-0', args: [] })
  await ui.executeJavaScript(`(() => {
    const task = workspaces.findTask('task-1-0')
    task.tabs.destroy('tab-1-0-19')
    workspaces.destroy('stress-2')
    return workspaces.findTaskContainingTab('tab-2-0-0') === null
  })()`)
  await delay(100)
  assert.deepEqual(errors, [], 'switching, background events and removal have no renderer errors')
  const surfaces = await require('./lib/customSurfaceSmoke.js')(ui, scratch)
  assert.deepEqual(errors, [], 'internal surfaces have no renderer errors')
  console.log('Custom feature smoke passed:', JSON.stringify({ ...setup, switches: 35, surfaces, errors: errors.length }))
}
run().then(() => { clearTimeout(watchdog); app.exit(0) }, error => {
  console.error(error)
  console.error('Renderer errors:', errors)
  clearTimeout(watchdog)
  app.exit(1)
})
