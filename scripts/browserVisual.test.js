/* Integration tests using Min's installed Electron and production browser tools.
 * All windows stay hidden. No external browser or automation library is used. */
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const vm = require('vm')
const { pathToFileURL } = require('url')
const http = require('http')
const { app, BaseWindow, WebContentsView } = require('electron')

const scratchArg = process.argv.find(arg => arg.indexOf('--min-visual-test-dir=') === 0)
const scratch = scratchArg ? scratchArg.slice('--min-visual-test-dir='.length) : fs.mkdtempSync(path.join(os.tmpdir(), 'min-visual-test-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true')
const watchdog = setTimeout(function () {
  console.error('Visual tests timed out')
  if (!scratchArg) fs.rmSync(scratch, { recursive: true, force: true })
  app.exit(1)
}, 90000)

const fixture = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;background:white;font:16px/20px sans-serif;height:1400px}
#card{position:absolute;left:40px;top:50px;width:120px;height:80px;box-sizing:border-box;padding:10px;background:rgb(24,90,200);display:flex;gap:12px}
#marker{position:absolute;left:200px;top:30px;width:20px;height:10px;background:rgb(255,0,0)}
#title{position:absolute;left:40px;top:160px;font-size:24px;line-height:30px}
#host{position:absolute;left:350px;top:50px}
iframe{position:absolute;left:300px;top:200px;width:140px;height:80px;border:4px solid black}
</style><div id="card"><span>Card</span></div><div id="marker"></div><div id="title">Visual fixture</div>
<div id="host"></div><iframe srcdoc="<style>body{margin:0}button{position:absolute;left:12px;top:10px;width:70px;height:25px}</style><button id='inner'>Inside</button>"></iframe>
<input type="file" id="upload" style="position:absolute;left:40px;top:250px">
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button id="shadow" style="width:80px;height:30px">Shadow</button>'</script>`

async function main () {
  await app.whenReady()
  console.log('Electron ready; creating hidden WebContentsView')
  const win = new BaseWindow({ show: false, width: 320, height: 240 })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false, sandbox: true, offscreen: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 320, height: 240 })
  let shown = false
  win.on('show', function () { shown = true })
  const wc = view.webContents
  const events = {}
  const requests = []
  const context = vm.createContext({
    require,
    fs,
    path,
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    __dirname: path.resolve(__dirname, '..'),
    app,
    isPathInside: (root, candidate) => candidate.startsWith(root + path.sep),
    viewMap: { tab: view },
    ipc: { on: (name, fn) => { events[name] = fn }, handle () {} },
    windows: { getCurrent: () => win, getState: () => ({ selectedView: 'tab' }) },
    getWindowWebContents: () => wc,
    sendIPCToWindow: (window, channel, data) => {
      if (channel !== 'browser-control') return
      requests.push(data.payload)
      const allowed = data.payload.workspaceId === 'workspace' && data.payload.taskId === 'task' && (!data.payload.tabId || data.payload.tabId === 'tab')
      const result = { ok: true, tabId: 'tab', taskId: 'task', workspaceId: 'workspace' }
      if (data.action === 'listTabs') Object.assign(result, { tabs: [{ id: 'tab' }], selected: 'tab' })
      events['browser-control-result']({}, { id: data.id, result: allowed ? result : { ok: false, error: 'Tab not found in this workspace' } })
    }
  })
  context.global = context
  for (const source of ['browserCommands', 'browserControl', 'browserVisual', 'browserTesting', 'designOverlay', 'toolResults', 'agentTools', 'playbook']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/' + source + '.js'), 'utf8'), context)
  }
  if (process.env.MIN_VISUAL_TEST_TRACE) {
    for (const name of ['browserVisualEvaluate', 'browserVisualCapture', 'browserVisualPrepared']) {
      const fn = context[name]
      context[name] = async function () {
        console.log('start ' + name + (name === 'browserVisualEvaluate' ? ' ' + arguments[1].name : ''))
        const result = await fn.apply(null, arguments)
        console.log('done ' + name)
        return result
      }
    }
  }
  const run = params => context.minBrowser.runStep(Object.assign({ taskId: 'task', workspaceId: 'workspace', outputDir: scratch }, params))
  const ok = result => { assert.equal(result.ok, true, result.error); return result }
  let passed = 0
  async function check (name, fn) {
    console.log('Checking: ' + name)
    await fn()
    passed++
    console.log('ok ' + passed + ' - ' + name)
  }
  let reference
  try {
    console.log('Loading local fixture')
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture))
    console.log('Fixture loaded')
    await check('viewport and DPR are independent of native view bounds; screenshot matches them', async () => {
      const viewport = ok(await run({ action: 'viewport', width: 640, height: 400, dpr: 2 }))
      assert.equal(viewport.viewport.width, 640)
      assert.equal(viewport.viewport.height, 400)
      assert.equal(viewport.viewport.dpr, 2)
      assert.equal(view.getBounds().width, 320)
      reference = ok(await run({ action: 'screenshot' }))
      assert.equal(reference.width, 1280)
      assert.equal(reference.height, 800)
      assert.equal(reference.ready.fontsReady, true)
      assert.equal(reference.ready.timedOut, false)
    })
    await check('inspection by coordinates, selector, shadow root, and iframe reports CSS geometry/styles/fonts', async () => {
      const inspected = ok(await run({ action: 'inspect', x: 150, y: 120 }))
      assert.equal(inspected.id, 'card')
      assert.deepEqual(JSON.parse(JSON.stringify(inspected.rect)), { x: 40, y: 50, width: 120, height: 80 })
      assert.equal(inspected.styles['padding-left'], '10px')
      assert.equal(inspected.styles.gap, '12px')
      const title = ok(await run({ action: 'inspect', selector: '#title' }))
      assert.equal(title.text, 'Visual fixture')
      assert.equal(title.styles['font-size'], '24px')
      assert.ok(title.renderedFonts.length > 0)
      assert.ok(title.textRects.length > 0)
      const shadow = ok(await run({ action: 'inspect', x: 360, y: 60 }))
      assert.equal(shadow.id, 'shadow')
      const inner = ok(await run({ action: 'inspect', selector: '#inner' }))
      assert.equal(inner.rect.x, 316)
      assert.equal(inner.rect.y, 214)
      assert.equal(ok(await run({ action: 'inspect', x: 320, y: 220 })).id, 'inner')
    })
    await check('element and area captures share viewport CSS coordinates at DPR 2', async () => {
      const element = ok(await run({ action: 'screenshot', selector: '#marker' }))
      const area = ok(await run({ action: 'screenshot', clip: { x: 200, y: 30, width: 20, height: 10 } }))
      assert.equal(element.width, 40)
      assert.equal(element.height, 20)
      assert.deepEqual(fs.readFileSync(element.path), fs.readFileSync(area.path))
      const preview = context.browserVisualPreview(element.images[0])
      assert.equal(preview.info.previewToCSS.scaleX, 0.5)
      assert.equal(preview.info.previewToCSS.offsetX, 200)
    })
    await check('compare returns identical pixels, exact changed area, and cropped-reference mapping', async () => {
      const same = ok(await run({ action: 'compare', referencePath: reference.path, referenceScale: 2 }))
      assert.equal(same.diff.changedPixels, 0)
      await wc.executeJavaScript("document.getElementById('marker').style.background='blue'")
      const changed = ok(await run({ action: 'compare', referencePath: reference.path, referenceScale: 2 }))
      assert.equal(changed.diff.changedPixels, 800)
      assert.equal(changed.diff.bounds.x, 200)
      assert.equal(changed.diff.bounds.width, 20)
      assert.equal(changed.images.length, 3)
      const region = ok(await run({ action: 'compare', referencePath: reference.path, referenceScale: 2, clip: { x: 200, y: 30, width: 20, height: 10 } }))
      assert.equal(region.diff.mismatchRatio, 1)
      const cropped = region.images.find(i => i.label === 'reference').path
      const remapped = ok(await run({ action: 'compare', referencePath: cropped, referenceScale: 2, selector: '#marker', referenceClip: { x: 0, y: 0, width: 20, height: 10 } }))
      assert.equal(remapped.diff.changedPixels, 800)
      assert.equal((await run({ action: 'compare', referencePath: reference.path })).ok, false)
      assert.equal((await run({ action: 'compare', referencePath: reference.path, path: reference.path })).ok, false)
      assert.equal((await run({ action: 'screenshot', clip: { x: 630, y: 0, width: 20, height: 10 } })).ok, false)
    })
    await check('overlay lifecycle preserves independent viewport; visual capture masks and restores overlay', async () => {
      ok(await context.minDesignOverlay.set('tab', { image: reference.path, cssWidth: 640, viewport: { w: 500, h: 350, dpr: 1 } }))
      assert.equal(ok(await run({ action: 'viewport' })).viewport.width, 640)
      await wc.executeJavaScript('window.__minDesignOverlayApply({opacity:1})')
      if (process.env.MIN_VISUAL_TEST_TRACE) console.log('overlay before', await wc.executeJavaScript("JSON.stringify({inline:document.getElementById('__min-design-overlay').style.display,visible:window.__minDesignOverlayState.visible,computed:getComputedStyle(document.getElementById('__min-design-overlay')).display})"))
      const clean = ok(await run({ action: 'compare', referencePath: reference.path, referenceScale: 2, includeOverlay: true }))
      assert.equal(clean.diff.changedPixels, 800, 'compare must ignore even an explicitly requested overlay')
      if (process.env.MIN_VISUAL_TEST_TRACE) console.log('overlay after', await wc.executeJavaScript("JSON.stringify({inline:document.getElementById('__min-design-overlay').style.display,visible:window.__minDesignOverlayState.visible,computed:getComputedStyle(document.getElementById('__min-design-overlay')).display})"))
      assert.equal(await wc.executeJavaScript("getComputedStyle(document.getElementById('__min-design-overlay')).display"), 'block')
      assert.equal((await run({ action: 'compare', referencePath: reference.path, referenceScale: 2, threshold: -1 })).ok, false)
      assert.equal(await wc.executeJavaScript("getComputedStyle(document.getElementById('__min-design-overlay')).display"), 'block', 'error cleanup restores CSS')
      assert.equal(ok(await run({ action: 'viewport', operation: 'reset' })).viewport.width, 500)
      ok(await run({ action: 'viewport', width: 640, height: 400, dpr: 2 }))
      await context.minDesignOverlay.clear('tab')
      assert.equal(ok(await run({ action: 'viewport' })).viewport.width, 640)
    })
    await check('upload and borrowed debugger cleanup preserve viewport emulation', async () => {
      const file = path.join(scratch, 'upload.txt')
      fs.writeFileSync(file, 'file fixture')
      ok(await run({ action: 'upload', selector: '#upload', path: file }))
      assert.equal(await wc.executeJavaScript("document.getElementById('upload').files.length"), 1)
      await assert.rejects(context.browserVisualWithDebugger(wc, async () => { throw new Error('borrowed failure') }), /borrowed failure/)
      assert.equal(ok(await run({ action: 'viewport' })).viewport.dpr, 2)
    })
    await check('tool results include image blocks and coordinate metadata; playbooks accept visual actions', async () => {
      ok(await run({ action: 'scroll', direction: 'top' }))
      const { Type } = await import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs')).href)
      const tools = context.createMinCustomTools(t => t, Type, scratch, 'task', 'workspace')
      const browser = tools.find(t => t.name === 'browser')
      const playbook = tools.find(t => t.name === 'playbook')
      const { Check } = await import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/value/index.mjs')).href)
      assert.equal(Check(browser.parameters, { action: 'fill', label: 'Email', value: '' }), true)
      assert.equal(Check(browser.parameters, { action: 'assert', testId: 'status', condition: 'count', expected: 2 }), true)
      assert.equal(Check(playbook.parameters, { operation: 'save', name: 'typed', setup: [{ action: 'viewport', width: '{{width}}', height: 800 }], steps: [{ action: 'assert', label: 'Email', condition: 'value', expected: '{{email}}' }] }), true)
      await assert.rejects(browser.execute('assert-failure', { action: 'assert', selector: '#card', condition: 'text', expected: 'wrong', timeout: 0 }), function (err) {
        return JSON.parse(err.message).actual === 'Card'
      })
      assert.ok(browser.parameters.properties.clip)
      const shot = await browser.execute('s', { action: 'screenshot', selector: '#marker' })
      assert.equal(shot.content.filter(c => c.type === 'image').length, 1)
      assert.equal(shot.details.images[0].previewToCSS.scaleX, 0.5)
      const compared = await browser.execute('c', { action: 'compare', referencePath: reference.path, referenceScale: 2, images: 'all' })
      assert.equal(compared.content.filter(c => c.type === 'image').length, 3)
      assert.ok(!JSON.stringify(compared.details).includes('base64'))
      ok(context.validatePlaybook({ name: 'visual', steps: [{ action: 'viewport' }, { action: 'compare', referencePath: reference.path }, { action: 'inspect', selector: '#card' }] }))
    })
    await check('resource waits and stalled capture are bounded and restore styles/session state', async () => {
      const sockets = new Set()
      const server = http.createServer(function () {})
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const url = 'http://127.0.0.1:' + server.address().port + '/pending.png'
        await wc.executeJavaScript("var pendingImage=document.createElement('img');pendingImage.id='pending-image';pendingImage.style='position:absolute;left:0;top:0;width:20px;height:20px';pendingImage.src=" + JSON.stringify(url) + ';document.body.appendChild(pendingImage);true')
        const pending = ok(await run({ action: 'screenshot', timeout: 150 }))
        assert.equal(pending.ready.timedOut, true)
        assert.equal(pending.ready.pendingImages, 1)
      } finally {
        await wc.executeJavaScript("document.getElementById('pending-image').remove()")
        sockets.forEach(socket => socket.destroy())
        await new Promise(resolve => server.close(resolve))
      }
      const send = wc.debugger.sendCommand.bind(wc.debugger)
      wc.debugger.sendCommand = function (method, params) {
        if (method === 'Page.captureScreenshot') return new Promise(function () {})
        return send(method, params)
      }
      wc.setBackgroundThrottling(true)
      try {
        const timedOut = await run({ action: 'screenshot', timeout: 150 })
        assert.equal(timedOut.ok, false)
        assert.match(timedOut.error, /compositor/)
        assert.equal(wc.getBackgroundThrottling(), true)
      } finally {
        wc.debugger.sendCommand = send
        wc.setBackgroundThrottling(false)
      }
      const recovered = ok(await run({ action: 'viewport' }))
      assert.equal(recovered.viewport.width, 640)
      assert.equal(recovered.viewport.dpr, 2)
      assert.notEqual(await wc.executeJavaScript('getComputedStyle(document.body).caretColor'), 'rgba(0, 0, 0, 0)')
      ok(await run({ action: 'screenshot', selector: '#marker' }))
    })
    await check('viewport survives navigation, mobile metrics work, reset restores native size', async () => {
      await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture))
      assert.equal(ok(await run({ action: 'viewport' })).viewport.width, 640)
      const overflow = ok(await run({ action: 'viewport', width: 375, height: 667, dpr: 2, mobile: true }))
      assert.equal(overflow.configured.width, 375)
      assert.equal(overflow.viewport.layoutWidth, 375)
      const scaled = await run({ action: 'screenshot' })
      assert.equal(scaled.ok, false)
      assert.match(scaled.error, /Page scale/)
      await wc.loadURL('data:text/html,' + encodeURIComponent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:white}</style><div style="width:100px;height:50px;background:red">Mobile</div>'))
      const mobile = ok(await run({ action: 'viewport' }))
      assert.equal(mobile.viewport.width, 375)
      assert.equal(mobile.viewport.dpr, 2)
      assert.equal(ok(await run({ action: 'screenshot' })).width, 750)
      const reset = ok(await run({ action: 'viewport', operation: 'reset' }))
      assert.equal(reset.source, 'window')
      assert.equal(reset.viewport.width, 320)
      assert.equal(wc.debugger.isAttached(), false)
    })
    const testingFixture = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Testing fixture</title>
      <style>body{font:16px sans-serif}button,input{display:block;margin:5px}#covered{position:absolute;left:400px;top:80px;width:100px;height:40px}#cover{position:absolute;left:400px;top:80px;width:120px;height:60px;z-index:2;background:white}</style>
      <form id="form"><label for="email">Email address</label><input id="email" data-testid="email" placeholder="Email" aria-labelledby="email-name"><span id="email-name">Account email</span>
      <input id="other" aria-label="Other"><button type="submit" data-testid="submit">Submit</button></form>
      <label><input type="checkbox" data-testid="agree">Agree</label><input id="password" type="password" aria-label="Password">
      <button disabled id="disabled">Disabled</button><input readonly id="readonly">
      <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
      <button id="covered">Covered</button><div id="cover"></div><div data-testid="status">Idle</div><div id="hidden" hidden>Hidden</div>
      <div id="editable" contenteditable="true">old</div>
      <script>window.submits=0;window.checks=0;window.clicks=0;
      document.querySelector('[data-testid="agree"]').onchange=e=>{if(e.isTrusted)window.checks++};
      document.getElementById('form').onsubmit=e=>{e.preventDefault();window.submits++;document.querySelector('[data-testid="status"]').textContent='Done'};
      document.querySelectorAll('.duplicate').forEach((b,i)=>b.onclick=()=>{window.clicks++;window.clicked=i});</script>`
    const testingUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(testingFixture)
    await wc.loadURL(testingUrl)
    ok(await run({ action: 'viewport', width: 640, height: 700, dpr: 1 }))
    await check('semantic locators are strict, include ARIA names, and retain identity through rerenders', async () => {
      assert.equal(ok(await run({ action: 'find', role: 'textbox', name: 'Account email' })).matches[0].testId, 'email')
      assert.equal(ok(await run({ action: 'find', label: 'Account email' })).count, 1)
      assert.equal(ok(await run({ action: 'find', placeholder: 'Email' })).count, 1)
      assert.equal(ok(await run({ action: 'find', selector: '#hidden' })).count, 0)
      assert.equal(ok(await run({ action: 'find', selector: '#hidden', includeHidden: true })).count, 1)
      const ambiguous = await run({ action: 'click', role: 'button', name: 'Duplicate', timeout: 0 })
      assert.equal(ambiguous.ok, false)
      assert.equal(ambiguous.matches.length, 2)
      assert.equal((await run({ action: 'click', selector: '.duplicate', nth: 7, timeout: 0 })).ok, false)
      assert.equal(await wc.executeJavaScript('window.clicks'), 0)
      const found = ok(await run({ action: 'find', role: 'button', name: 'Duplicate' }))
      await wc.executeJavaScript("var old=document.querySelectorAll('.duplicate')[1];var next=old.cloneNode(true);next.onclick=()=>{window.clicks++;window.clicked=1};old.replaceWith(next)")
      ok(await run({ action: 'click', ref: found.matches[1].ref }))
      assert.equal(await wc.executeJavaScript('window.clicked'), 1)
      assert.equal(await wc.executeJavaScript('window.clicks'), 1)
    })
    await check('fill/check are idempotent; native keyboard Tab, shortcut and Enter perform browser defaults', async () => {
      ok(await run({ action: 'fill', testId: 'email', value: 'first' }))
      ok(await run({ action: 'fill', testId: 'email', value: 'second' }))
      ok(await run({ action: 'assert', testId: 'email', condition: 'value', expected: 'second', timeout: 0 }))
      ok(await run({ action: 'press', testId: 'email', key: 'Control+a' }))
      ok(await run({ action: 'press', key: 'Backspace' }))
      ok(await run({ action: 'assert', testId: 'email', condition: 'value', expected: '', timeout: 0 }))
      ok(await run({ action: 'press', key: 'Tab' }))
      assert.equal(await wc.executeJavaScript('document.activeElement.id'), 'other')
      ok(await run({ action: 'press', testId: 'email', key: 'Enter' }))
      assert.equal(await wc.executeJavaScript('window.submits'), 1)
      ok(await run({ action: 'check', testId: 'agree', checked: true }))
      ok(await run({ action: 'check', testId: 'agree', checked: true }))
      assert.equal(await wc.executeJavaScript('window.checks'), 1)
      ok(await run({ action: 'assert', testId: 'agree', condition: 'checked', expected: true }))
      ok(await run({ action: 'check', testId: 'agree', checked: false }))
      ok(await run({ action: 'fill', selector: '#editable', value: 'new content' }))
      ok(await run({ action: 'assert', selector: '#editable', condition: 'text', expected: 'new content' }))
      assert.equal((await run({ action: 'fill', selector: '#readonly', value: 'x', timeout: 0 })).ok, false)
      assert.equal((await run({ action: 'click', selector: '#disabled', timeout: 0 })).ok, false)
      assert.equal((await run({ action: 'click', selector: '#covered' })).ok, false)
    })
    await check('assertions poll real DOM changes and report expected/actual; hidden/detached/count are precise', async () => {
      await wc.executeJavaScript("document.querySelector('[data-testid=status]').textContent='Loading';setTimeout(()=>document.querySelector('[data-testid=status]').textContent='Ready',240);true")
      const delayed = ok(await run({ action: 'assert', testId: 'status', condition: 'text', expected: 'Ready', timeout: 1200 }))
      assert.ok(delayed.attempts > 1)
      const wrong = await run({ action: 'assert', testId: 'status', condition: 'text', expected: 'Done', timeout: 0 })
      assert.equal(wrong.ok, false)
      assert.equal(wrong.expected, 'Done')
      assert.equal(wrong.actual, 'Ready')
      ok(await run({ action: 'wait', selector: '#hidden', condition: 'hidden', timeout: 0 }))
      ok(await run({ action: 'assert', selector: '#missing', condition: 'detached', timeout: 0 }))
      assert.equal((await run({ action: 'assert', selector: '#missing', condition: 'text', expected: 'x', not: true, timeout: 0 })).ok, false)
      ok(await run({ action: 'assert', selector: '.duplicate', condition: 'count', expected: 2, timeout: 0 }))
      ok(await run({ action: 'assert', selector: '#disabled', condition: 'disabled', timeout: 0 }))
      ok(await run({ action: 'assert', testId: 'email', condition: 'attribute', attribute: 'placeholder', expected: 'Email' }))
      ok(await run({ action: 'assert', testId: 'email', condition: 'css', property: 'display', expected: 'block' }))
      ok(await run({ action: 'assert', condition: 'title', expected: 'Testing fixture' }))
      ok(await run({ action: 'fill', label: 'Password', value: 'test-secret' }))
      const privateValue = await run({ action: 'assert', label: 'Password', condition: 'value', expected: 'wrong-secret', timeout: 0 })
      assert.equal(privateValue.ok, false)
      assert.ok(!JSON.stringify(privateValue).includes('secret'))
    })
    await check('bounded diagnostics observe errors and reset explicitly', async () => {
      ok(await run({ action: 'diagnostics', operation: 'clear' }))
      await wc.executeJavaScript("console.error('fixture failure');true")
      const result = await run({ action: 'assert', condition: 'no-errors' })
      assert.equal(result.ok, false)
      assert.equal(result.actual, 1)
      assert.equal(result.diagnostics.entries[0].message, 'fixture failure')
      await wc.executeJavaScript("for(var n=0;n<205;n++)console.log('bounded '+n);true")
      const bounded = ok(await run({ action: 'diagnostics' }))
      assert.equal(bounded.entries.length, 200)
      assert.ok(bounded.dropped > 0)
      assert.equal((await run({ action: 'assert', condition: 'no-errors' })).ok, false)
      ok(await run({ action: 'diagnostics', operation: 'clear' }))
      ok(await run({ action: 'assert', condition: 'no-errors' }))
    })
    await check('playbook repeats a real form test and saves screenshots/diffs on failure', async () => {
      ok(context.savePlaybook(scratch, {
        name: 'form-test',
        repeat: 2,
        setup: [{ action: 'navigate', url: testingUrl }],
        steps: [{ action: 'fill', testId: 'email', value: 'test@example.test' }, { action: 'click', testId: 'submit' }, { action: 'assert', testId: 'status', condition: 'text', expected: 'Done' }],
        teardown: [{ action: 'fill', testId: 'email', value: '' }]
      }, 'workspace'))
      const report = ok(await context.runPlaybook(scratch, 'form-test', {}, { workspaceId: 'workspace', taskId: 'task' }))
      assert.equal(report.summary.passed, 10)
      assert.equal(await wc.executeJavaScript('window.submits'), 1)
      assert.equal(await wc.executeJavaScript('document.getElementById("email").value'), '')
      assert.ok(fs.existsSync(report.reportPath))
      const reference = ok(await run({ action: 'screenshot', selector: '[data-testid=status]' }))
      await wc.executeJavaScript("document.querySelector('[data-testid=status]').style.color='red'")
      const compared = ok(await run({ action: 'compare', selector: '[data-testid=status]', referencePath: reference.path, referenceClip: { x: 0, y: 0, width: reference.rect.width, height: reference.rect.height }, maxMismatchRatio: 0 }))
      assert.equal(compared.assertion.passed, false)
      assert.equal(compared.images.length, 3)
      ok(context.savePlaybook(scratch, { name: 'fail-test', steps: [{ action: 'assert', testId: 'status', condition: 'text', expected: 'Wrong', timeout: 0 }] }, 'workspace'))
      const failed = await context.runPlaybook(scratch, 'fail-test', {}, { workspaceId: 'workspace', taskId: 'task' })
      assert.equal(failed.ok, false)
      assert.equal(failed.results[0].actual, 'Done')
      assert.ok(fs.existsSync(failed.results[0].evidence.path))
    })
    await check('scoped snapshots/find/read paginate without ref collisions and redact passwords', async () => {
      ok(await run({ action: 'fill', label: 'Password', value: 'snapshot-secret' }))
      const first = ok(await run({ action: 'snapshot', selector: '#form', limit: 2 }))
      assert.equal(first.total, 3)
      assert.equal(first.nextOffset, 2)
      const second = ok(await run({ action: 'snapshot', selector: '#form', limit: 2, offset: first.nextOffset }))
      assert.equal(second.refs, 1)
      assert.equal(second.nextOffset, null)
      const firstRef = first.snapshot.match(/\[(s\d+_\d+)\]/)[1]
      const secondRef = second.snapshot.match(/\[(s\d+_\d+)\]/)[1]
      assert.notEqual(firstRef, secondRef)
      ok(await run({ action: 'fill', ref: firstRef, value: 'old-ref-still-correct' }))
      ok(await run({ action: 'assert', testId: 'email', condition: 'value', expected: 'old-ref-still-correct' }))
      const overview = ok(await run({ action: 'snapshot' }))
      assert.ok(!overview.snapshot.includes('snapshot-secret'))
      assert.ok(overview.snapshot.includes('[redacted]'))
      const page = ok(await run({ action: 'find', selector: '.duplicate', limit: 1, offset: 1 }))
      assert.equal(page.count, 2)
      assert.equal(page.matches.length, 1)
      ok(await run({ action: 'click', ref: page.matches[0].ref }))
      assert.equal(await wc.executeJavaScript('window.clicked'), 1)
      const read = ok(await run({ action: 'read', selector: '[data-testid=status]', limit: 2, offset: 1 }))
      assert.equal(read.text, 'on')
      assert.equal(read.nextOffset, 3)
      await wc.executeJavaScript("document.querySelector('[data-testid=status]').style.setProperty('--fixture-gap','17.25px')")
      const inspected = ok(await run({ action: 'inspect', testId: 'status', properties: '--fixture-gap,color' }))
      assert.equal(inspected.styles['--fixture-gap'], '17.25px')
      assert.deepEqual(Object.keys(inspected.styles).sort(), ['--fixture-gap', 'color'])
    })
    await check('real browser batch preflights all steps and stops after the first failed assertion', async () => {
      const before = await wc.executeJavaScript('window.submits')
      const invalid = await run({ action: 'batch', steps: [{ action: 'click', testId: 'submit' }, { action: 'fill', testId: 'email', vlaue: 'wrong field' }] })
      assert.equal(invalid.completed, 0)
      assert.equal(invalid.validationIndex, 1)
      assert.equal(await wc.executeJavaScript('window.submits'), before)
      const result = await run({
        action: 'batch',
        steps: [
          { action: 'fill', testId: 'email', value: 'batch@example.test' },
          { action: 'click', testId: 'submit' },
          { action: 'assert', testId: 'status', condition: 'text', expected: 'Incorrect', timeout: 0 },
          { action: 'click', testId: 'submit' }
        ]
      })
      assert.equal(result.ok, false)
      assert.equal(result.stoppedAt, 2)
      assert.equal(result.completed, 2)
      assert.equal(result.results[2].actual, 'Done')
      assert.equal(await wc.executeJavaScript('window.submits'), before + 1)
      ok(await run({ action: 'batch', steps: [{ action: 'fill', testId: 'email', value: 'ok' }, { action: 'assert', testId: 'email', condition: 'value', expected: 'ok' }] }))
    })
    await check('scope restrictions and hidden-window operation survive visual actions', async () => {
      assert.equal((await run({ action: 'screenshot', workspaceId: 'outside' })).ok, false)
      assert.equal((await run({ action: 'inspect', selector: '#card', tabId: 'outside' })).ok, false)
      assert.ok(requests.filter(r => r.ensureView).every(r => r.focus === false))
      await wc.loadURL('about:blank#/pages/settings/')
      assert.equal((await run({ action: 'screenshot' })).ok, false)
      assert.equal(shown, false)
      assert.equal(win.isVisible(), false)
    })
    console.log(passed + ' integration checks passed using Electron ' + process.versions.electron)
  } finally {
    wc.close()
    win.close()
  }
}

main().then(function () {
  clearTimeout(watchdog)
  if (!scratchArg) fs.rmSync(scratch, { recursive: true, force: true })
  app.exit(0)
}, function (err) {
  console.error(err)
  clearTimeout(watchdog)
  if (!scratchArg) fs.rmSync(scratch, { recursive: true, force: true })
  app.exit(1)
})
