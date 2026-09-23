/* Regression tests for Google UA navigation and native OAuth popups. Run with
 * node scripts/googleAuth.test.js. Uses hidden Electron views, a disposable
 * profile and a loopback server; no Google account or external service needed. */
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { EventEmitter, once } = require('events')
const electron = require('electron')

if (typeof electron === 'string') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'min-google-auth-'))
  const child = require('child_process').spawn(electron, [__filename, '--auth-test-dir=' + scratch], { stdio: 'inherit' })
  const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  child.once('error', function (error) {
    console.error(error)
    cleanup()
    process.exitCode = 1
  })
  child.once('exit', function (code) {
    cleanup()
    process.exitCode = code == null ? 1 : code
  })
} else {
  run().catch(function (error) {
    console.error(error)
    electron.app.exit(1)
  })
}

async function run () {
  const { app, session, WebContentsView } = electron
  const scratch = process.argv.find(arg => arg.startsWith('--auth-test-dir=')).slice('--auth-test-dir='.length)
  app.setPath('userData', path.join(scratch, 'profile'))
  app.disableHardwareAcceleration()
  const watchdog = setTimeout(() => {
    console.error('Google auth regression tests timed out')
    app.exit(1)
  }, 45000)
  const messages = new EventEmitter()
  const handlers = new Map()
  const views = []
  const ownerWindow = {}
  const settingsValues = {}
  const context = {
    require,
    __dirname: path.resolve(__dirname, '..'),
    console,
    process,
    URL,
    setTimeout,
    clearTimeout,
    app,
    session,
    settings: { get: name => settingsValues[name] },
    ipc: {
      on: (name, fn) => { if (name === 'getPageUserAgent') electron.ipcMain.on(name, fn) },
      handle () {}
    },
    windows: { getCurrent: () => ownerWindow, getAll: () => [] },
    getWindowWebContents: () => ({ send: (channel, message) => messages.emit(message.event, message) }),
    filterPopups: url => !url.endsWith('/blocked-popup'),
    WebContentsView: class {
      constructor (options) {
        const view = new WebContentsView(options)
        views.push(view)
        const setHandler = view.webContents.setWindowOpenHandler.bind(view.webContents)
        view.webContents.setWindowOpenHandler = handler => {
          handlers.set(view.webContents, handler)
          setHandler(handler)
        }
        return view
      }
    }
  }
  context.global = context
  const source = ['UASwitcher', 'viewManager'].map(file => fs.readFileSync(path.join(__dirname, '../main/' + file + '.js'), 'utf8')).join('\n;\n')
  // Stay in Electron's JS context: native WebFrameMain wrappers created in a
  // separate vm context lack the Electron prototype used by executeJavaScript.
  // eslint-disable-next-line no-new-func
  const loadModules = new Function(...Object.keys(context), source + `
    return {
      createView, loadURLInView, temporaryPopupViews, getPageUserAgent,
      isGoogleAccountURL, getDefaultViewWebPreferences,
      setAccountMatcher: fn => { isGoogleAccountURL = fn },
      setPreferences: fn => { getDefaultViewWebPreferences = fn },
      setWindowResolver: fn => { getWindowFromViewContents = fn }
    }
  `)
  Object.assign(context, loadModules(...Object.values(context)))
  const defaultPrefs = context.getDefaultViewWebPreferences
  const preload = path.join(scratch, 'preload.js')
  fs.writeFileSync(preload, 'var electron = require("electron"); var ipc = electron.ipcRenderer;\n' + fs.readFileSync(path.join(__dirname, '../js/preload/googleAuth.js'), 'utf8'))
  context.setPreferences(() => Object.assign(defaultPrefs(), {
    preload,
    backgroundThrottling: false
  }))
  context.setWindowResolver(() => ownerWindow)
  const bounds = JSON.stringify({ x: 0, y: 0, width: 800, height: 600 })
  const createView = (id, partition, existingId) => context.createView(existingId, id, { partition }, bounds, [])
  let passed = 0
  async function check (name, fn) {
    await fn()
    console.log('PASS ' + name)
    passed++
  }

  await check('Google URL matching excludes lookalike hosts and non-web schemes', async () => {
    for (const url of ['https://accounts.google.com/signin', 'https://test.accounts.google.com/', 'https://accounts.youtube.com/']) {
      assert.equal(context.isGoogleAccountURL(url), true)
    }
    for (const url of ['https://accounts.google.com.evil.test/', 'https://accounts.google.com@evil.test/', 'https://example.com/?next=accounts.google.com', 'file://accounts.google.com/test', 'invalid']) {
      assert.equal(context.isGoogleAccountURL(url), false)
    }
  })

  await check('a custom UA is preserved and header normalization is case insensitive', async () => {
    const customUA = 'Mozilla/5.0 CustomBrowser/1.0 Firefox/130.0'
    const fakeApp = new EventEmitter()
    fakeApp.userAgentFallback = app.userAgentFallback
    const uaSource = fs.readFileSync(path.join(__dirname, '../main/UASwitcher.js'), 'utf8')
    // eslint-disable-next-line no-new-func
    const custom = new Function('app', 'settings', 'ipc', 'process', 'URL', 'session', uaSource + '\nreturn { applyUAForURL, getPageUserAgent, enableGoogleUASwitcher }')(
      fakeApp, { get: () => customUA }, { on () {} }, process, URL, {}
    )
    let headerHandler
    custom.enableGoogleUASwitcher({ webRequest: { onBeforeSendHeaders: fn => { headerHandler = fn } } })
    const contents = { setUserAgent: () => assert.fail('custom UA changed') }
    custom.applyUAForURL(contents, 'https://accounts.google.com/signin')
    assert.equal(custom.getPageUserAgent(contents, 'https://accounts.google.com/signin'), null)
    const headers = { 'user-agent': customUA, 'sec-ch-ua': 'Chromium', 'Sec-Ch-UA-Platform': 'Windows', Cookie: 'test=value' }
    headerHandler({ url: 'https://accounts.google.com/signin', requestHeaders: headers }, result => {
      assert.equal(result.cancel, false)
      assert.deepEqual(result.requestHeaders, { 'user-agent': customUA, Cookie: 'test=value' })
    })
  })

  // Route Google pages through a loopback fixture, while retaining the real UA
  // switcher, Electron navigation events and network header interception.
  context.setAccountMatcher(url => {
    try { return new URL(url).pathname.startsWith('/google/') } catch (e) { return false }
  })
  const requests = []
  const server = http.createServer(async function (req, res) {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, headers: req.headers, method: req.method, body })
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Cache-Control', 'no-store')
    const redirects = {
      '/start': '/google/challenge',
      '/frame-redirect': '/frame-done',
      '/google/complete': '/cookie-bridge',
      '/cookie-bridge': '/google/consent',
      '/google/consent': '/callback',
      '/google/popup': '/popup-callback',
      '/post-entry': '/google/post-challenge'
    }
    if (redirects[req.url]) {
      res.writeHead(req.url === '/post-entry' ? 307 : 302, { Location: redirects[req.url] })
      res.end()
    } else if (req.url === '/google/challenge') {
      res.end('<iframe src="/frame-redirect"></iframe><script>window.initialUA = navigator.userAgent; window.ready = new Promise(resolve => { window.onload = async () => { await fetch("/probe"); resolve(true) } })</script>')
    } else if (req.url === '/popup-callback') {
      res.end('<script>window.opener.postMessage({ authenticated: true, ua: navigator.userAgent }, location.origin)</script>')
    } else {
      res.end('<!doctype html><title>Auth fixture</title><p>Ready</p>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const lastRequest = url => requests.filter(req => req.url === url).at(-1)
  const isFirefox = ua => /Firefox\//.test(ua)
  const assertFirefoxHeaders = request => {
    assert.ok(isFirefox(request.headers['user-agent']), request.url)
    assert.ok(!Object.keys(request.headers).some(name => name.startsWith('sec-ch-')), request.url)
  }
  await app.whenReady()
  const view = createView('auth', 'persist:auth-profile')
  const wc = view.webContents
  const load = url => context.loadURLInView('auth', base + url)
  const nextPage = async fn => {
    const finished = once(wc, 'did-finish-load')
    await fn()
    await finished
  }

  await check('2FA keeps its UA after iframe redirects, including subsequent requests', async () => {
    await load('/start')
    await wc.executeJavaScript('window.ready')
    const userAgent = await wc.executeJavaScript('navigator.userAgent')
    assert.ok(isFirefox(userAgent))
    assert.equal(context.getPageUserAgent(wc), userAgent)
    assert.equal(await wc.executeJavaScript('window.initialUA'), userAgent)
    assert.equal(requests.filter(req => req.url === '/start').length, 1)
    assert.equal(await wc.executeJavaScript('navigator.userAgentData'), undefined)
    for (const url of ['/google/challenge', '/frame-done', '/probe']) assertFirefoxHeaders(lastRequest(url))
    assert.equal(lastRequest('/probe').headers['user-agent'], userAgent)
  })

  await check('same-document navigation and another tab cannot change the challenge identity', async () => {
    const userAgent = context.getPageUserAgent(wc)
    await wc.executeJavaScript('history.pushState({}, "", "/challenge-history"); fetch("/after-history")')
    assert.equal(context.getPageUserAgent(wc), userAgent)
    assertFirefoxHeaders(lastRequest('/after-history'))
    const other = createView('other', 'persist:auth-profile')
    await context.loadURLInView('other', base + '/app')
    assert.equal(isFirefox(await other.webContents.executeJavaScript('navigator.userAgent')), false)
    assert.equal(context.getPageUserAgent(wc), userAgent)
  })

  await check('2FA completion keeps one UA through auth redirects and restores it after the callback', async () => {
    await nextPage(() => wc.executeJavaScript('location.href = "/google/complete"'))
    for (const url of ['/google/complete', '/cookie-bridge', '/google/consent', '/callback']) {
      assertFirefoxHeaders(lastRequest(url))
      assert.equal(requests.filter(req => req.url === url).length, 1)
    }
    assert.ok(isFirefox(await wc.executeJavaScript('navigator.userAgent')))
    await load('/app')
    assert.equal(isFirefox(await wc.executeJavaScript('navigator.userAgent')), false)
    assert.equal(lastRequest('/app').headers['user-agent'], await wc.executeJavaScript('navigator.userAgent'))
  })

  await check('an embedded Google frame uses its own identity without changing the parent page', async () => {
    await wc.executeJavaScript('window.frameReady = new Promise(resolve => { const frame = document.createElement("iframe"); frame.src = "/google/embedded"; frame.onload = () => resolve(frame.contentWindow.navigator.userAgent); document.body.append(frame) }); void 0')
    assert.ok(isFirefox(await wc.executeJavaScript('window.frameReady')))
    assert.equal(isFirefox(await wc.executeJavaScript('navigator.userAgent')), false)
    assertFirefoxHeaders(lastRequest('/google/embedded'))
  })

  await check('a POST redirected into Google keeps its body and is never replayed', async () => {
    const postView = createView('post-auth', 'persist:auth-profile')
    await context.loadURLInView('post-auth', base + '/app')
    const finished = once(postView.webContents, 'did-finish-load')
    await postView.webContents.executeJavaScript('const form = document.createElement("form"); form.method = "POST"; form.action = "/post-entry"; form.innerHTML = \'<input name="state" value="redirect-state">\'; document.body.append(form); form.submit()')
    await finished
    for (const url of ['/post-entry', '/google/post-challenge']) {
      assert.equal(requests.filter(req => req.url === url).length, 1)
      assert.equal(lastRequest(url).method, 'POST')
      assert.equal(lastRequest(url).body, 'state=redirect-state')
    }
    assertFirefoxHeaders(lastRequest('/google/post-challenge'))
    assert.ok(isFirefox(await postView.webContents.executeJavaScript('navigator.userAgent')))
  })

  async function openPopup (parent, code) {
    const created = once(messages, 'did-create-popup')
    await parent.executeJavaScript(code, true)
    const [message] = await created
    const popup = context.temporaryPopupViews[message.args[0]]
    assert.ok(popup)
    return { popup, message }
  }

  await check('featureless Google popup returns its result through the original opener', async () => {
    await wc.session.cookies.set({ url: base, name: 'auth-session', value: 'profile-cookie' })
    await wc.executeJavaScript('window.authResult = new Promise(resolve => addEventListener("message", e => resolve(e.data), { once: true })); void 0')
    const { popup, message } = await openPopup(wc, 'window.authPopup = window.open("/google/popup", "auth"); void 0')
    const result = await wc.executeJavaScript('window.authResult')
    assert.equal(result.authenticated, true)
    assert.ok(isFirefox(result.ua))
    assert.equal(await wc.executeJavaScript('!!window.authPopup'), true)
    assert.equal(popup.webContents.session, wc.session)
    assert.match(lastRequest('/popup-callback').headers.cookie, /auth-session=profile-cookie/)
    assert.ok(lastRequest('/popup-callback').headers.referer)
    createView('adopted', 'incorrect-new-partition', message.args[0])
    const nested = await openPopup(popup.webContents, 'window.open("/nested", "nested"); void 0')
    assert.equal(nested.popup.webContents.session, wc.session)
  })

  await check('target=_blank forms retain the POST body', async () => {
    const { popup } = await openPopup(wc, 'const form = document.createElement("form"); form.method = "POST"; form.action = "/post-callback"; form.target = "_blank"; form.innerHTML = \'<input name="state" value="oauth-state">\'; document.body.append(form); form.submit()')
    if (popup.webContents.isLoading()) await once(popup.webContents, 'did-finish-load')
    const request = lastRequest('/post-callback')
    assert.equal(request.method, 'POST')
    assert.equal(request.body, 'state=oauth-state')
    assert.match(request.headers['content-type'], /application\/x-www-form-urlencoded/)
    assert.equal(popup.webContents.session, wc.session)
  })

  await check('private popup and nested popup inherit the actual parent session after adoption', async () => {
    const privateView = createView('private', 'private-parent')
    await context.loadURLInView('private', base + '/private')
    await privateView.webContents.session.cookies.set({ url: base, name: 'auth-session', value: 'private-cookie' })
    const { popup, message } = await openPopup(privateView.webContents, 'window.open("/private-child", "child"); void 0')
    createView('private-adopted', 'private-adopted', message.args[0])
    if (popup.webContents.isLoading()) await once(popup.webContents, 'did-finish-load')
    const nested = await openPopup(popup.webContents, 'window.open("/private-nested", "nested"); void 0')
    if (nested.popup.webContents.isLoading()) await once(nested.popup.webContents, 'did-finish-load')
    assert.equal(nested.popup.webContents.session, privateView.webContents.session)
    assert.notEqual(nested.popup.webContents.session, wc.session)
    assert.match(lastRequest('/private-nested').headers.cookie, /auth-session=private-cookie/)
  })

  await check('deferred background tabs load once and preserve referrer, POST data and focus intent', async () => {
    const response = handlers.get(wc)({
      url: base + '/background',
      features: '',
      disposition: 'background-tab',
      referrer: { url: base + '/app', policy: 'default' },
      postBody: { contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: Buffer.from('state=background') }] }
    })
    assert.equal(response.action, 'allow')
    const created = once(messages, 'did-create-popup')
    const background = response.createWindow(response.overrideBrowserWindowOptions)
    const [message] = await created
    await once(background, 'did-finish-load')
    assert.equal(message.args[2], false)
    assert.equal(background.session, wc.session)
    assert.equal(lastRequest('/background').headers.referer, base + '/app')
    assert.equal(lastRequest('/background').method, 'POST')
    assert.equal(lastRequest('/background').body, 'state=background')
    assert.equal(requests.filter(req => req.url === '/background').length, 1)
  })

  await check('popup filtering still runs before any window is created', async () => {
    assert.equal(handlers.get(wc)({ url: base + '/blocked-popup' }).action, 'deny')
  })

  for (const view of views) {
    if (!view.webContents.isDestroyed()) view.webContents.destroy()
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  clearTimeout(watchdog)
  console.log(passed + ' Google auth regression checks passed')
  app.exit(0)
}
