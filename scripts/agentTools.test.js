const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { pathToFileURL } = require('url')

const typePromise = import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs')).href)

async function harness (t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'min-tools-test-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const bridgeCalls = []
  const context = vm.createContext({
    require,
    fs,
    path,
    console,
    setTimeout,
    clearTimeout,
    app: { getPath: () => cwd },
    browserVisualPreview: descriptor => ({ content: { type: 'image', data: 'fixture', mimeType: 'image/png' }, info: Object.assign({}, descriptor, { previewToCSS: { offsetX: 10, offsetY: 20, scaleX: 0.5, scaleY: 0.5 } }) }),
    ipc: { on () {} },
    minFigmaEngine: { status: () => ({ context: { fileKey: 'file', nodeId: '1:2' }, bridge: { pluginConnected: true } }) },
    minFigmaBridge: { command: async (action, args) => { bridgeCalls.push({ action, args }); return { ok: true, payload: { id: '1:2', name: 'Card', type: 'FRAME', css: 'color: red;', fontJson: '[{"family":"Inter"}]', textExtract: 'Full text' } } } },
    minDocumentStore: { getForAI: (workspace, id) => id === 'private' ? { ok: false, error: 'Document not found or unavailable' } : { ok: true, document: { id: id, title: 'Test', markdown: 'abcdefghij' } } }
  })
  context.global = context
  for (const file of ['browserCommands', 'browserControl', 'toolResults', 'agentTools']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/' + file + '.js'), 'utf8'), context)
  const { Type } = await typePromise
  const tools = context.createMinCustomTools(t => t, Type, cwd, 'task', 'workspace')
  return { context, cwd, tools, bridgeCalls, tool: name => tools.find(t => t.name === name), payload: result => JSON.parse(result.content[0].text) }
}

test('catalog budget excludes repeated step schemas; action help stays precise and usable offline', async t => {
  const h = await harness(t)
  const metrics = h.tools.map(tool => ({ name: tool.name, schemaChars: JSON.stringify(tool.parameters).length, promptChars: [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join('\n').length }))
  const size = metrics.reduce((sum, tool) => sum + tool.schemaChars + tool.promptChars, 0)
  assert.ok(size < 26000, 'catalog expanded to ' + size + ' characters')
  assert.ok(metrics.find(m => m.name === 'playbook').schemaChars < 6500)
  const browser = h.tool('browser')
  const help = h.payload(await browser.execute('help', { action: 'help', topic: 'assert' }))
  assert.match(help.parameters.expected, /Expected/)
  assert.equal(help.example.condition, 'text')
  assert.ok(!Object.hasOwn(help.parameters, 'files'))
  assert.equal(h.payload(await browser.execute('help-batch', { action: 'help', topic: 'batch' })).example.steps.length, 3)
  assert.equal(h.payload(await h.tool('figma').execute('help', { action: 'help' })).examples[0].action, 'export')
  assert.equal(h.bridgeCalls.length, 0)
  console.log('Tool catalog characters: ' + size + ' (baseline 61157); ' + Math.round((1 - size / 61157) * 100) + '% reduction')
})

test('compact inspect retains exact geometry, rendered fonts, requested CSS and readiness', async t => {
  const h = await harness(t)
  const style = Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['property-' + i, 'some css value']))
  style.gap = '17.25px'
  const element = { tag: 'div', rect: { x: 10.25, y: 22.5, width: 100.75, height: 50.125 }, styles: style, geometryApproximate: true }
  const raw = Object.assign({ ok: true, children: Array(10).fill(element), ancestors: Array(3).fill(element), renderedFonts: [{ familyName: 'Inter' }], textRects: [{ x: 1 }], ready: { timedOut: true } }, element)
  const compact = h.context.minToolBrowserPayload(raw, { action: 'inspect', properties: 'gap' })
  assert.equal(compact.styles.gap, '17.25px')
  assert.equal(compact.rect.width, 100.75)
  assert.equal(compact.children[0].geometryApproximate, true)
  assert.equal(compact.renderedFonts[0].familyName, 'Inter')
  assert.equal(compact.ready.timedOut, true)
  assert.ok(JSON.stringify(compact).length < JSON.stringify(raw).length / 4)
  assert.equal(h.context.minToolBrowserPayload(raw, { action: 'inspect', detail: 'full' }).textRects.length, 1)
  assert.equal(raw.children[0].styles.gap, '17.25px')
})

test('large results and failures stay bounded with lossless files and explicit truncation', async t => {
  const h = await harness(t)
  const raw = { ok: true, count: 200, entries: Array.from({ length: 200 }, (_, i) => ({ id: i, message: 'entry ' + i + ' ' + 'x'.repeat(2000) })) }
  const result = h.context.minToolJsonResult(raw, false, { cwd: h.cwd })
  const payload = h.payload(result)
  assert.ok(result.content[0].text.length <= 12000)
  assert.equal(payload.count, 200)
  assert.equal(payload._output.truncated, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(payload._output.fullResultPath, 'utf8')), raw)
  const failure = { ok: false, error: 'Assertion failed', condition: 'text', expected: 'A', actual: 'B', diagnostics: raw }
  assert.throws(() => h.context.minToolJsonResult(failure, true, { cwd: h.cwd }), err => {
    const value = JSON.parse(err.message)
    assert.equal(value.ok, false)
    assert.equal(value.expected, 'A')
    assert.equal(value.actual, 'B')
    assert.ok(err.message.length <= 12000)
    assert.equal(JSON.parse(fs.readFileSync(value._output.fullResultPath)).diagnostics.entries.length, 200)
    return true
  })
  h.context.fs = Object.assign({}, fs, { mkdirSync () { throw new Error('read-only') } })
  const unsaved = h.payload(h.context.minToolJsonResult(raw, false, { cwd: h.cwd }))
  assert.match(unsaved._output.saveError, /read-only/)
  assert.equal(unsaved._output.fullResultPath, undefined)
})

test('visual payloads avoid redundant images without losing coordinate maps or pass/fail', async t => {
  const h = await harness(t)
  const raw = { ok: true, diff: { changedPixels: 0, mismatchRatio: 0 }, assertion: { passed: true }, images: ['reference', 'actual', 'diff'].map(label => ({ label: label, path: '/' + label + '.png', cssRect: { x: 10, y: 20, width: 100, height: 100 } })) }
  const imageCount = result => result.content.filter(part => part.type === 'image').length
  assert.equal(imageCount(h.context.minToolVisualResult(raw)), 0)
  raw.diff.changedPixels = 20
  raw.assertion.passed = false
  const auto = h.context.minToolVisualResult(raw)
  assert.equal(imageCount(auto), 1)
  assert.equal(h.payload(auto).assertion.passed, false)
  assert.equal(auto.details.images[2].previewToCSS.scaleX, 0.5)
  assert.equal(h.payload(auto).images.length, 3)
  assert.equal(imageCount(h.context.minToolVisualResult(raw, false, { images: 'all' })), 3)
  assert.equal(imageCount(h.context.minToolVisualResult(raw, false, { images: 'none' })), 0)
})

test('batch validates the entire plan before mutations, pins scope, and stops without replay', async t => {
  const h = await harness(t)
  const c = h.context
  const calls = []
  c.browserControlListTabs = async () => ({ ok: true, taskId: 'task', workspaceId: 'workspace', tabs: [{ id: 'first' }], selected: 'first' })
  c.browserTestingHasLocator = params => !!params.testId
  c.browserTestingLocate = async params => ({ ok: true, ref: 'f1', tabId: params.tabId })
  c.browserControlAct = async (action, params) => { calls.push(params); return { ok: true } }
  c.browserControlPointer = async (action, params) => { calls.push(params); return { ok: true } }
  c.browserTestingRun = async params => { calls.push(params); return { ok: false, error: 'wrong status', actual: 'Loading', expected: 'Done' } }
  const scope = { taskId: 'task', workspaceId: 'workspace' }
  const fill = { action: 'fill', testId: 'email', value: 'example' }
  const invalid = await c.minBrowser.runStep(Object.assign({ action: 'batch', steps: [fill, { action: 'click', testId: 'save', unknow: true }] }, scope))
  assert.equal(invalid.completed, 0)
  assert.equal(invalid.validationIndex, 1)
  assert.equal(calls.length, 0)
  const result = await c.minBrowser.runStep(Object.assign({ action: 'batch', steps: [fill, { action: 'assert', testId: 'status', condition: 'text', expected: 'Done' }, { action: 'click', testId: 'save' }] }, scope))
  assert.equal(result.ok, false)
  assert.equal(result.stoppedAt, 1)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.tabId === 'first' && call.taskId === 'task' && call.workspaceId === 'workspace'))
  assert.equal(result.results[1].actual, 'Loading')
  assert.equal((await c.minBrowser.runStep({ action: 'batch', steps: [{ action: 'batch', steps: [] }] })).ok, false)
})

test('diagnostics prioritize errors and report pages avoid duplicate scenario trees', async t => {
  const h = await harness(t)
  const entries = Array.from({ length: 40 }, (_, i) => ({ level: i === 37 ? 'error' : 'info', message: String(i) }))
  const diag = h.context.minToolBrowserPayload({ ok: true, entries, dropped: 3 }, { action: 'diagnostics', limit: 3 })
  assert.equal(diag.entries[0].message, '37')
  assert.equal(diag.count, 40)
  assert.equal(diag.nextOffset, 3)
  assert.equal(diag.dropped, 3)
  const report = { ok: false, status: 'failed', summary: { failed: 1 }, scenarios: [{ results: Array(50).fill({}) }], results: Array.from({ length: 50 }, (_, i) => ({ index: i, ok: i !== 37, status: i === 37 ? 'failed' : 'passed', actual: i })) }
  const page = h.context.minToolReportPayload({ ok: true, report }, { status: 'failed' })
  assert.equal(page.report.ok, false)
  assert.equal(page.count, 1)
  assert.equal(page.report.results[0].index, 37)
  assert.equal(page.report.scenarios, undefined)
  assert.equal(page.nextOffset, null)
})

test('Figma fields and document pages expose exact requested data, preserving private-document denial', async t => {
  const h = await harness(t)
  const figma = h.tool('figma')
  const fonts = h.payload(await figma.execute('fonts', { action: 'node-data', fields: 'fonts' }))
  assert.equal(fonts.fonts[0].family, 'Inter')
  assert.equal(fonts.css, undefined)
  assert.equal(fonts.text, undefined)
  const full = h.payload(await figma.execute('full', { action: 'node-data', detail: 'full' }))
  assert.equal(full.text, 'Full text')
  const doc = h.tool('docs')
  const first = h.payload(await doc.execute('first', { operation: 'readDocument', id: 'public', limit: 4 }))
  const next = h.payload(await doc.execute('next', { operation: 'readDocument', id: 'public', offset: first.nextOffset, limit: 4 }))
  assert.equal(first.document.markdown + next.document.markdown, 'abcdefgh')
  assert.equal(next.nextOffset, 8)
  await assert.rejects(doc.execute('private', { operation: 'readDocument', id: 'private' }), /not found or unavailable/)
})
