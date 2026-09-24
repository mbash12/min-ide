/* tests for the omp provider replica layer (main/agentOAuth.js): the file is
written for the concatenated main bundle, so load it in a vm context with the
same globals the bundle provides and exercise the exported internals */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')

function loadModule (fetchStub) {
  const context = vm.createContext({
    require,
    __dirname: path.resolve(__dirname, '..'),
    fs,
    path,
    console,
    process,
    URL,
    URLSearchParams,
    Buffer,
    Promise,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchStub || fetch,
    openTabInWindow () {},
    global: null
  })
  context.global = context
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/agentOAuth.js'), 'utf8'), context)
  return context.agentOAuth
}

function fakeJwt (expSeconds) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return b64({ alg: 'none' }) + '.' + b64({ exp: expSeconds, sub: 'user|123' }) + '.sig'
}

test('pkce produces a verifier and a sha256 challenge', async () => {
  const { _internals } = loadModule()
  const { verifier, challenge } = _internals.pkce()
  assert.equal(typeof verifier, 'string')
  assert.ok(verifier.length > 80)
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
  assert.equal(challenge, expected)
})

test('dotGet walks nested paths and survives missing keys', async () => {
  const { _internals } = loadModule()
  const body = { data: { zai: { access_token: 'tok' }, user: { id: 'u1' } } }
  assert.equal(_internals.dotGet(body, 'data.zai.access_token'), 'tok')
  assert.equal(_internals.dotGet(body, 'data.user.id'), 'u1')
  assert.equal(_internals.dotGet(body, 'data.missing.path'), undefined)
  assert.equal(_internals.dotGet(null, 'a.b'), undefined)
})

test('jwtExpiryMs reads the exp claim minus skew', async () => {
  const { _internals } = loadModule()
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = fakeJwt(exp)
  assert.equal(_internals.jwtExpiryMs(token, 300000), exp * 1000 - 300000)
  assert.equal(_internals.jwtExpiryMs('not-a-jwt', 0), undefined)
})

test('parseAuthorizationInput accepts url, code#state, query and bare code', async () => {
  const { _internals } = loadModule()
  const parse = _internals.parseAuthorizationInput
  /* vm-context objects fail deepStrictEqual's prototype check - compare fields */
  const fields = parsed => ({ code: parsed.code, state: parsed.state })
  assert.deepEqual(fields(parse('https://x/cb?code=abc&state=s1')), { code: 'abc', state: 's1' })
  assert.deepEqual(fields(parse('abc#s2')), { code: 'abc', state: 's2' })
  assert.deepEqual(fields(parse('code=abc&state=s3')), { code: 'abc', state: 's3' })
  assert.deepEqual(fields(parse('barecode')), { code: 'barecode', state: undefined })
  assert.deepEqual(fields(parse('')), { code: undefined, state: undefined })
})

test('extractCredentials maps token json via the spec paths', async () => {
  const { _internals } = loadModule()
  const spec = {
    credential: {
      access: 'data.zai.access_token',
      refresh: 'data.zai.access_token',
      expires: { mode: 'never' },
      extra: { email: 'data.user.email', accountId: 'data.user.id' }
    }
  }
  const creds = await _internals.extractCredentials(spec, {
    data: { zai: { access_token: 'minted' }, user: { email: 'a@b.c', id: 'u1' } }
  })
  assert.equal(creds.access, 'minted')
  assert.equal(creds.refresh, 'minted')
  assert.equal(creds.email, 'a@b.c')
  assert.equal(creds.accountId, 'u1')
  assert.ok(creds.expires > Date.now() + 300 * 24 * 3600 * 1000)
})

test('extractCredentials computes seconds expiry with skew', async () => {
  const { _internals } = loadModule()
  const spec = { credential: { access: 'access_token', refresh: 'refresh_token', expires: { mode: 'seconds', path: 'expires_in', skewMs: 300000 } } }
  const before = Date.now()
  const creds = await _internals.extractCredentials(spec, { access_token: 'a', refresh_token: 'r', expires_in: 3600 })
  assert.equal(creds.access, 'a')
  assert.equal(creds.refresh, 'r')
  const expected = before + 3600 * 1000 - 300000
  assert.ok(Math.abs(creds.expires - expected) < 5000)
})

test('code flow: manual code input completes exchange against token endpoint', async t => {
  /* fake provider: token endpoint asserts the standard authorization_code
  grant body and returns tokens; the flow completes via manual code paste */
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push({ url: req.url, body, contentType: req.headers['content-type'] })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 7200 }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const { _internals } = loadModule()
  const spec = {
    clientId: 'cid-1',
    authorizeUrl: 'https://auth.example.com/authorize',
    pkce: true,
    scopes: ['scope-a', 'scope-b'],
    callback: { manualOnly: true, redirectUri: 'custom://cb' },
    token: { url: `http://127.0.0.1:${port}/token`, body: 'form' },
    credential: { access: 'access_token', refresh: 'refresh_token', expires: { mode: 'seconds', path: 'expires_in' } },
    refresh: {}
  }

  let authUrl = null
  const creds = await _internals.runCodeFlow(spec, {
    onAuth (info) { authUrl = info.url },
    async onManualCodeInput () {
      const state = new URL(authUrl).searchParams.get('state')
      return `custom://cb?code=the-code&state=${state}`
    }
  })

  assert.equal(creds.access, 'acc-1')
  assert.equal(creds.refresh, 'ref-1')
  assert.equal(requests.length, 1)
  const sent = new URLSearchParams(requests[0].body)
  assert.equal(sent.get('grant_type'), 'authorization_code')
  assert.equal(sent.get('client_id'), 'cid-1')
  assert.equal(sent.get('code'), 'the-code')
  assert.equal(sent.get('redirect_uri'), 'custom://cb')
  assert.ok(sent.get('code_verifier'))
  /* authorize url carries pkce challenge + scopes */
  const url = new URL(authUrl)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('scope'), 'scope-a scope-b')
})

test('code flow closes the unused loopback listener when manual code input wins', async t => {
  const tokenServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'acc-manual', expires_in: 60 }))
    })
  })
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve))
  t.after(() => tokenServer.close())

  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const callbackPort = probe.address().port
  await new Promise(resolve => probe.close(resolve))

  const { _internals } = loadModule()
  const spec = {
    clientId: 'cid-manual',
    authorizeUrl: 'https://auth.example.com/authorize',
    callback: { port: callbackPort, path: '/callback', timeoutMs: 60000 },
    token: { url: `http://127.0.0.1:${tokenServer.address().port}/token`, body: 'form' },
    credential: { access: 'access_token', expires: { mode: 'never' } }
  }
  await _internals.runCodeFlow(spec, {
    async onManualCodeInput () { return 'manual-code' }
  })

  const released = await new Promise(resolve => {
    const listener = http.createServer()
    listener.once('error', () => resolve(false))
    listener.listen(callbackPort, '127.0.0.1', () => listener.close(() => resolve(true)))
  })
  assert.equal(released, true)
})

test('code flow: loopback callback server completes exchange', async t => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push(body)
      res.end(JSON.stringify({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 60 }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const tokenPort = server.address().port

  /* free loopback port for the oauth callback listener */
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const cbPort = probe.address().port
  probe.close()

  const { _internals } = loadModule()
  const spec = {
    clientId: 'cid-2',
    authorizeUrl: 'https://auth.example.com/authorize',
    pkce: true,
    callback: { port: cbPort, path: '/callback', hostname: '127.0.0.1' },
    token: { url: `http://127.0.0.1:${tokenPort}/token`, body: 'form' },
    credential: { access: 'access_token', refresh: 'refresh_token', expires: { mode: 'seconds', path: 'expires_in' } },
    refresh: {}
  }

  let authUrl = null
  const flow = _internals.runCodeFlow(spec, {
    onAuth (info) { authUrl = info.url }
  })
  /* give the listener a tick to bind, then simulate the browser redirect */
  await new Promise(resolve => setTimeout(resolve, 150))
  const state = new URL(authUrl).searchParams.get('state')
  await new Promise(function (resolve, reject) {
    http.get(`http://127.0.0.1:${cbPort}/callback?code=cb-code&state=${state}`, res => {
      res.resume()
      res.on('end', resolve)
    }).on('error', reject)
  })
  const creds = await flow
  assert.equal(creds.access, 'acc-2')
  const sent = new URLSearchParams(requests[0])
  assert.equal(sent.get('code'), 'cb-code')
  assert.equal(sent.get('redirect_uri'), `http://127.0.0.1:${cbPort}/callback`)
})

test('state mismatch is rejected', async () => {
  const { _internals } = loadModule()
  const spec = {
    clientId: 'cid',
    authorizeUrl: 'https://auth.example.com/authorize',
    callback: { manualOnly: true, redirectUri: 'custom://cb' },
    token: { url: 'http://127.0.0.1:1/unused', body: 'form' },
    credential: { access: 'access_token' },
    refresh: {}
  }
  await assert.rejects(
    _internals.runCodeFlow(spec, {
      onAuth () {},
      async onManualCodeInput () { return 'custom://cb?code=x&state=wrong-state' }
    }),
    /state mismatch/
  )
})

test('cursor login polls until tokens arrive', async () => {
  let calls = 0
  const accessToken = fakeJwt(Math.floor(Date.now() / 1000) + 1800)
  const stub = async (url) => {
    calls++
    assert.ok(String(url).startsWith('https://api2.cursor.sh/auth/poll'))
    if (calls < 3) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ accessToken, refreshToken: 'cur-ref' }) }
  }
  const { _internals } = loadModule(stub)
  let shown = null
  const creds = await _internals.cursorLogin({
    onAuth (info) { shown = info.url },
    onProgress () {}
  })
  assert.equal(creds.access, accessToken)
  assert.equal(creds.refresh, 'cur-ref')
  assert.ok(shown && shown.startsWith('https://cursor.com/loginDeepControl'))
  assert.ok(new URL(shown).searchParams.get('challenge'))
  assert.ok(creds.expires > Date.now())
})

test('cursor refresh posts the refresh token', async () => {
  const accessToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600)
  let authHeader = null
  const stub = async (url, init) => {
    assert.equal(url, 'https://api2.cursor.sh/auth/exchange_user_api_key')
    authHeader = init.headers.Authorization
    return { ok: true, status: 200, json: async () => ({ accessToken, refreshToken: 'new-ref' }) }
  }
  const { _internals } = loadModule(stub)
  const creds = await _internals.cursorRefresh({ access: 'old', refresh: 'old-ref', expires: 0 })
  assert.equal(authHeader, 'Bearer old-ref')
  assert.equal(creds.access, accessToken)
  assert.equal(creds.refresh, 'new-ref')
})

test('refresh: providers without a refresh grant keep stored credentials', async () => {
  const { _internals } = loadModule()
  const devin = _internals.specs.devin
  const stored = { access: 'tok', refresh: 'tok', expires: Date.now() + 1e9 }
  const out = await _internals.runRefresh(devin, stored)
  assert.deepEqual(out, stored)
})

test('refresh: standard grant posts refresh_token and merges prior fields', async t => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push(body)
      res.end(JSON.stringify({ access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 3600 }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const { _internals } = loadModule()
  const spec = {
    clientId: 'cid-3',
    token: { url: `http://127.0.0.1:${server.address().port}/token`, body: 'form' },
    credential: { access: 'access_token', refresh: 'refresh_token', expires: { mode: 'seconds', path: 'expires_in' } },
    refresh: {}
  }
  const out = await _internals.runRefresh(spec, { access: 'old', refresh: 'old-ref', expires: 1, projectId: 'keep-me' })
  assert.equal(out.access, 'new-acc')
  assert.equal(out.refresh, 'new-ref')
  assert.equal(out.projectId, 'keep-me')
  const sent = new URLSearchParams(requests[0])
  assert.equal(sent.get('grant_type'), 'refresh_token')
  assert.equal(sent.get('refresh_token'), 'old-ref')
  assert.equal(sent.get('client_id'), 'cid-3')
})

test('devin spec matches the omp KDL contract', async () => {
  const { _internals } = loadModule()
  const devin = _internals.specs.devin
  assert.equal(devin.authorizeUrl, 'https://app.devin.ai/auth/cli/continue')
  assert.equal(devin.callback.port, 59653)
  assert.equal(devin.token.url, 'https://api.devin.ai/auth/cli/token')
  assert.equal(devin.token.standard, false)
  assert.equal(devin.credential.access, 'token')
  assert.equal(devin.refresh, null)
})

test('replica registry exposes the omp provider set', async () => {
  const agentOAuth = loadModule()
  for (const id of ['cursor', 'devin', 'gitlab-duo', 'google-antigravity', 'google-gemini-cli', 'zai-coding-plan']) {
    assert.ok(agentOAuth.replicaIds.includes(id), id + ' registered')
    assert.ok(agentOAuth.replicaLabels[id], id + ' labelled')
  }
})
