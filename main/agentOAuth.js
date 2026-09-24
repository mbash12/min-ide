/* global openTabInWindow, net, minOmpUpdates */
/* OMP provider replicas: ports of oh-my-pi's OAuth provider flows
(https://github.com/can1357/oh-my-pi, pi-catalog auth/*.kdl + pi-ai
registry/oauth/*.ts) onto the pi SDK extension API the installed SDK exposes
(ProviderConfigInput.oauth / OAuthLoginCallbacks). Min keeps its own pi SDK
runtime; this module only adds provider definitions and their login flows.

Wire coverage: the replicated providers use proprietary chat transports
(Devin's devin-agent over Connect/protobuf, Cursor's aiserver over HTTP/2,
Google's Code Assist API, GitLab Duo's agent wire, Z.AI's zcode endpoint).
They register auth-only for now — sign-in stores a working credential in the
SDK's auth.json; models appear once the matching stream implementation is
ported into ProviderConfigInput.streamSimple/models.

OAuth network calls use plain fetch + node:http so everything runs in the
Electron main process. Requires are file-local because the concatenated main
bundle shares one scope. */

const oauthNodeCrypto = require('crypto')
const oauthNodeHttp = require('http')
const oauthStartCallbackServer = require(require('path').join(__dirname, 'main/lib/oauth/loopbackCallback.js'))(oauthNodeHttp)

/* Electron's net.fetch rides the Chromium network stack (honors the app's
configured proxy); plain fetch is the fallback for the node test harness */
const oauthFetch = (typeof net !== 'undefined' && net && net.fetch) ? function (...args) { return net.fetch(...args) } : fetch

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function oauthB64Url (buf) {
  return Buffer.from(buf).toString('base64url')
}

function oauthGeneratePKCE () {
  const verifier = oauthB64Url(oauthNodeCrypto.randomBytes(96))
  const challenge = oauthB64Url(oauthNodeCrypto.createHash('sha256').update(verifier).digest())
  return { verifier: verifier, challenge: challenge }
}

function oauthDecodeB64 (value) {
  return Buffer.from(value, 'base64').toString('utf8')
}

function oauthDotGet (obj, pathExpr) {
  if (!pathExpr) return undefined
  return String(pathExpr).split('.').reduce(function (acc, key) {
    if (acc == null || typeof acc !== 'object') return undefined
    return acc[key]
  }, obj)
}

function oauthJwtExpiryMs (token, skewMs) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (payload && typeof payload.exp === 'number') {
      return payload.exp * 1000 - (skewMs || 0)
    }
  } catch (e) {}
  return undefined
}

function oauthSleep (ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) {
      reject(new Error('Login cancelled'))
      return
    }
    const timer = setTimeout(function () {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort () {
      clearTimeout(timer)
      reject(new Error('Login cancelled'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function oauthThrowIfAborted (signal) {
  if (signal && signal.aborted) throw new Error('Login cancelled')
}

/* filled query template: "code {code} verifier {code_verifier}" style;
unknown placeholders resolve to the empty string (omp's template() semantic) */
function oauthFillTemplate (str, values) {
  return String(str).replace(/\{(\w+)\}/g, function (m, name) {
    return values[name] !== undefined ? String(values[name]) : ''
  })
}

/* ------------------------------------------------------------------ */
/* generic oauth-code flow (port of omp's auth/*.kdl login "oauth-code") */
/* ------------------------------------------------------------------ */

/* Accepts a pasted redirect URL, "code#state", query string, or bare code —
same shape pi's own codex flow accepts. */
function oauthParseAuthorizationInput (input) {
  const value = String(input || '').trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') || undefined,
      state: url.searchParams.get('state') || undefined
    }
  } catch (e) {}
  if (value.indexOf('#') !== -1) {
    const parts = value.split('#')
    return { code: parts[0], state: parts[1] }
  }
  if (value.indexOf('code=') !== -1) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') || undefined,
      state: params.get('state') || undefined
    }
  }
  return { code: value }
}

/* one token-style POST. When tokenSpec.standard is kept (default), the
grant's baseline params merge first and the rule's declared params override —
mirrors omp's postTokenRequest. */
async function oauthTokenRequest (tokenSpec, fields, signal, standardParams) {
  let body
  const headers = Object.assign({}, tokenSpec.headers)
  const params = {}
  if (tokenSpec.standard !== false) {
    Object.keys(standardParams || {}).forEach(function (key) {
      if (standardParams[key] !== undefined) params[key] = standardParams[key]
    })
  }
  Object.keys(tokenSpec.params || {}).forEach(function (key) {
    params[key] = oauthFillTemplate(tokenSpec.params[key], fields)
  })
  if (tokenSpec.body === 'json') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(params)
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(params).toString()
  }
  const response = await oauthFetch(tokenSpec.url, { method: 'POST', headers: headers, body: body, signal: signal })
  if (!response.ok) {
    const text = await response.text().catch(function () { return '' })
    throw new Error('OAuth token request failed (' + response.status + '): ' + (text || response.statusText))
  }
  return response.json()
}

/* spec.credential maps token JSON onto {access, refresh, expires, ...extra}:
   access/refresh are dot paths into the response; expires describes how the
   lifetime is reported (seconds-from-now, seconds-from-field, jwt claim, or
   never); userinfo can fetch the account email afterwards. */
async function oauthExtractCredentials (spec, tokenJson, signal) {
  const cred = spec.credential || {}
  const access = oauthDotGet(tokenJson, cred.access || 'access_token')
  if (!access) throw new Error('OAuth response missing access token')
  const refresh = oauthDotGet(tokenJson, cred.refresh || 'refresh_token') || access
  const expiresSpec = cred.expires || { mode: 'seconds', path: 'expires_in' }
  let expires = Date.now() + 365 * 24 * 3600 * 1000
  if (expiresSpec.mode === 'seconds') {
    const secs = Number(oauthDotGet(tokenJson, expiresSpec.path || 'expires_in'))
    const from = expiresSpec.from ? Number(oauthDotGet(tokenJson, expiresSpec.from)) * 1000 : Date.now()
    if (isFinite(secs)) expires = from + secs * 1000 - (expiresSpec.skewMs || 0)
  } else if (expiresSpec.mode === 'jwt') {
    expires = oauthJwtExpiryMs(access, expiresSpec.skewMs) || (Date.now() + (expiresSpec.fallbackMs || 365 * 24 * 3600 * 1000))
  }
  const credentials = { access: access, refresh: refresh, expires: expires }
  Object.keys(cred.extra || {}).forEach(function (key) {
    const val = oauthDotGet(tokenJson, cred.extra[key])
    if (val !== undefined) credentials[key] = val
  })

  if (spec.userinfo) {
    try {
      const res = await oauthFetch(spec.userinfo.url, { headers: { Authorization: 'Bearer ' + access }, signal: signal })
      if (res.ok) {
        const info = await res.json()
        if (spec.userinfo.email && info[spec.userinfo.email]) credentials.email = info[spec.userinfo.email]
        if (spec.userinfo.accountId && info[spec.userinfo.accountId]) credentials.accountId = info[spec.userinfo.accountId]
      }
    } catch (e) {}
  }
  return credentials
}

/* Runs one full authorize -> callback/manual-code -> token-exchange flow.
   callbacks follow the SDK's OAuthLoginCallbacks surface (onAuth, onPrompt,
   onManualCodeInput, onProgress, onSelect, signal). */
async function oauthRunCodeFlow (spec, callbacks) {
  const signal = callbacks && callbacks.signal
  oauthThrowIfAborted(signal)

  const redirectUri = spec.callback.redirectUri ||
    'http://' + (spec.callback.hostname || '127.0.0.1') + ':' + spec.callback.port + (spec.callback.path || '/callback')

  const values = {
    redirect_uri: redirectUri,
    client_id: spec.clientId,
    code_verifier: '',
    code_challenge: '',
    state: ''
  }
  let verifier = null
  if (spec.pkce) {
    const pair = oauthGeneratePKCE()
    verifier = pair.verifier
    values.code_verifier = pair.verifier
    values.code_challenge = pair.challenge
  }
  const state = spec.state === 'uuid' ? oauthNodeCrypto.randomUUID() : oauthB64Url(oauthNodeCrypto.randomBytes(16))
  values.state = state

  const authUrl = new URL(spec.authorizeUrl)
  authUrl.searchParams.set('client_id', spec.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('state', state)
  if (spec.scopes && spec.scopes.length) authUrl.searchParams.set('scope', spec.scopes.join(' '))
  if (spec.pkce) {
    authUrl.searchParams.set('code_challenge', values.code_challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
  }
  Object.keys(spec.authorizeParams || {}).forEach(function (key) {
    authUrl.searchParams.set(key, spec.authorizeParams[key])
  })

  /* waits for either the loopback redirect or the user pasting the final
  redirect URL/code — whichever resolves first. Manual paste also covers
  remote sessions and custom-scheme redirects (zai's zcode://). A channel
  that fails early (port taken, prompt cancelled) doesn't kill the other. */
  const channels = []
  const channelController = new AbortController()
  let signalAbortListener = null
  let signalAbortError = null
  if (!spec.callback.manualOnly) {
    const callbackPromise = oauthStartCallbackServer({
      port: spec.callback.port,
      hostname: spec.callback.hostname,
      path: spec.callback.path,
      timeoutMs: spec.callback.timeoutMs
    }, channelController.signal)
    /* a late rejection after the other channel won would otherwise surface
    as an unhandled rejection */
    callbackPromise.catch(function () {})
    channels.push(callbackPromise.then(function (result) { return { result: result } }))
  }
  if (callbacks && callbacks.onManualCodeInput) {
    const manualPromise = Promise.resolve()
      .then(function () { return callbacks.onManualCodeInput() })
    manualPromise.catch(function () {})
    channels.push(manualPromise.then(function (input) { return { input: input } }))
  }

  if (callbacks && callbacks.onAuth) {
    callbacks.onAuth({ url: authUrl.toString(), instructions: spec.instructions })
  }

  if (!channels.length) throw new Error('No OAuth completion channel available')

  let code = null
  let codeState = null
  let first
  try {
    const channelRace = Promise.any(channels)
    if (!signal) {
      first = await channelRace
    } else {
      const abortRace = new Promise(function (resolve, reject) {
        signalAbortListener = function () {
          channelController.abort()
          signalAbortError = new Error('Login cancelled')
          reject(signalAbortError)
        }
        if (signal.aborted) signalAbortListener()
        else signal.addEventListener('abort', signalAbortListener, { once: true })
      })
      first = await Promise.race([channelRace, abortRace])
    }
  } catch (error) {
    if (error === signalAbortError) throw error
    const reasons = (error && error.errors) || []
    throw reasons[0] || new Error('OAuth flow failed')
  } finally {
    channelController.abort()
    if (signal && signalAbortListener) signal.removeEventListener('abort', signalAbortListener)
  }
  if (first.result) {
    code = first.result.code
    codeState = first.result.state
  } else {
    const parsed = oauthParseAuthorizationInput(first.input)
    code = parsed.code
    codeState = parsed.state
  }

  if (!code) throw new Error('OAuth flow produced no authorization code')
  if (codeState && state && codeState !== state) throw new Error('OAuth state mismatch')
  oauthThrowIfAborted(signal)

  /* providers may echo `code#state`; the fragment wins over callback state
  (omp's exchangeToken does the same split) */
  let exchangeCode = code
  let exchangeState = codeState
  const fragment = code.indexOf('#')
  if (fragment >= 0) {
    exchangeCode = code.slice(0, fragment)
    exchangeState = code.slice(fragment + 1) || codeState
  }

  const tokenFields = Object.assign({}, values, {
    code: exchangeCode,
    state: exchangeState,
    client_secret: spec.clientSecret
  })
  const tokenJson = await oauthTokenRequest(spec.token, tokenFields, signal, {
    grant_type: 'authorization_code',
    client_id: spec.clientId,
    client_secret: spec.clientSecret,
    code: exchangeCode,
    redirect_uri: redirectUri,
    code_verifier: verifier || undefined
  })
  return oauthExtractCredentials(spec, tokenJson, signal)
}

/* Standard refresh_token grant for providers that keep "refresh" enabled in
their KDL; providers with refresh "none" re-login instead. */
function oauthRefreshSpec (spec) {
  if (!spec.refresh) return null
  return {
    url: (spec.refresh.url || spec.token.url),
    body: spec.refresh.body || spec.token.body,
    headers: spec.token.headers,
    standard: spec.refresh.standard,
    params: spec.refresh.params || {}
  }
}

async function oauthRunRefresh (spec, credentials, signal) {
  const refreshSpec = oauthRefreshSpec(spec)
  if (!refreshSpec) {
    /* non-refreshable credentials (devin's long-lived token, zai's never-
    expiring minted key): hand the stored credential back unchanged */
    return credentials
  }
  const json = await oauthTokenRequest(refreshSpec, { refresh_token: credentials.refresh, client_secret: spec.clientSecret }, signal, {
    grant_type: 'refresh_token',
    client_id: spec.clientId,
    client_secret: spec.clientSecret,
    refresh_token: credentials.refresh
  })
  const renewed = await oauthExtractCredentials(spec, json, signal)
  /* keep prior fields the refreshed payload may have dropped (projectId,
  enterprise urls, account ids) */
  return Object.assign({}, credentials, renewed)
}

/* ------------------------------------------------------------------ */
/* cursor: PKCE deep-link + polling flow (port of omp registry/oauth/   */
/* cursor.ts — no loopback server; cursor.com polls by uuid+verifier)   */
/* ------------------------------------------------------------------ */

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll'
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'
const CURSOR_POLL_MAX_ATTEMPTS = 150
const CURSOR_POLL_BASE_DELAY = 1000
const CURSOR_POLL_MAX_DELAY = 10000
const CURSOR_POLL_BACKOFF = 1.2

function oauthCursorTokenExpiry (token) {
  return oauthJwtExpiryMs(token, 5 * 60 * 1000) || (Date.now() + 3600 * 1000)
}

async function oauthCursorLogin (callbacks) {
  const signal = callbacks && callbacks.signal
  const pair = oauthGeneratePKCE()
  const uuid = oauthNodeCrypto.randomUUID()
  const loginUrl = CURSOR_LOGIN_URL + '?' + new URLSearchParams({
    challenge: pair.challenge,
    uuid: uuid,
    mode: 'login',
    redirectTarget: 'cli'
  }).toString()

  if (callbacks && callbacks.onAuth) callbacks.onAuth({ url: loginUrl })
  if (callbacks && callbacks.onProgress) callbacks.onProgress('Waiting for browser authentication...')

  let delay = CURSOR_POLL_BASE_DELAY
  let consecutiveErrors = 0
  for (let attempt = 0; attempt < CURSOR_POLL_MAX_ATTEMPTS; attempt++) {
    await oauthSleep(delay, signal)
    oauthThrowIfAborted(signal)
    let response
    try {
      response = await oauthFetch(CURSOR_POLL_URL + '?uuid=' + uuid + '&verifier=' + pair.verifier, { signal: signal })
    } catch (err) {
      consecutiveErrors++
      if (consecutiveErrors >= 3) throw new Error('Too many consecutive errors during Cursor auth polling')
      continue
    }
    if (response.status === 404) {
      consecutiveErrors = 0
      delay = Math.min(delay * CURSOR_POLL_BACKOFF, CURSOR_POLL_MAX_DELAY)
      continue
    }
    if (response.ok) {
      const data = await response.json()
      return {
        access: data.accessToken,
        refresh: data.refreshToken,
        expires: oauthCursorTokenExpiry(data.accessToken)
      }
    }
    throw new Error('Cursor auth poll failed: ' + response.status)
  }
  throw new Error('Cursor authentication polling timeout')
}

async function oauthCursorRefresh (credentials, signal) {
  const response = await oauthFetch(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + credentials.refresh,
      'Content-Type': 'application/json'
    },
    body: '{}',
    signal: signal
  })
  if (!response.ok) {
    const text = await response.text().catch(function () { return '' })
    throw new Error('Cursor token refresh failed: ' + (text || response.status))
  }
  const data = await response.json()
  return {
    access: data.accessToken,
    refresh: data.refreshToken || credentials.refresh,
    expires: oauthCursorTokenExpiry(data.accessToken)
  }
}

/* ------------------------------------------------------------------ */
/* google code-assist project hook (port of omp's after-exchange hooks) */
/* ------------------------------------------------------------------ */

async function oauthGoogleCloudCodeProject (accessToken, endpoint, signal) {
  const headers = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  }
  const load = await oauthFetch(endpoint + '/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    signal: signal
  })
  if (!load.ok) throw new Error('loadCodeAssist failed (' + load.status + ')')
  let info = await load.json()
  let projectId = info.cloudaicompanionProject
  if (!projectId) {
    /* account not onboarded yet: start onboarding and poll until the project
    appears (omp does the same, up to 5 minutes) */
    const onboard = await oauthFetch(endpoint + '/v1internal:onboardUser', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ tierId: 'free-tier', metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
      signal: signal
    })
    if (!onboard.ok) throw new Error('onboardUser failed (' + onboard.status + ')')
    let operation = await onboard.json()
    const deadline = Date.now() + 5 * 60 * 1000
    while (operation && operation.done !== true && Date.now() < deadline) {
      await oauthSleep(5000, signal)
      const poll = await oauthFetch(endpoint + '/v1internal/' + operation.name, { headers: headers, signal: signal })
      if (poll.ok) operation = await poll.json()
      else break
    }
    const refreshed = await oauthFetch(endpoint + '/v1internal:loadCodeAssist', { method: 'POST', headers: headers, body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }), signal: signal })
    if (refreshed.ok) info = await refreshed.json()
    projectId = info.cloudaicompanionProject
  }
  return projectId || null
}

/* ------------------------------------------------------------------ */
/* provider replica specs (translated from omp auth/*.kdl)              */
/* ------------------------------------------------------------------ */

const OMP_OAUTH_CODE_SPECS = {
  devin: {
    name: 'Devin',
    authorizeUrl: 'https://app.devin.ai/auth/cli/continue',
    pkce: true,
    state: 'uuid',
    authorizeParams: { prompt: 'select_account' },
    instructions: 'Sign in to Devin in your browser.',
    callback: { port: 59653, path: '/callback', hostname: '127.0.0.1' },
    token: {
      url: 'https://api.devin.ai/auth/cli/token',
      body: 'json',
      standard: false,
      headers: { Accept: 'application/json' },
      params: { code: '{code}', code_verifier: '{code_verifier}' }
    },
    credential: {
      access: 'token',
      refresh: 'token',
      expires: { mode: 'jwt', fallbackMs: 365 * 24 * 3600 * 1000 },
      extra: {}
    },
    refresh: null
  },
  'gitlab-duo': {
    name: 'GitLab Duo',
    envVars: { GITLAB_CLIENT_ID: 'clientId', GITLAB_REDIRECT_URI: 'redirectUri' },
    clientId: 'da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    scopes: ['api'],
    pkce: true,
    instructions: 'Complete GitLab login in the browser. If GitLab responds with "The redirect URI included is not valid", register your own GitLab OAuth application and set GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI.',
    callback: { port: 8080, path: '/callback', hostname: 'localhost' },
    token: { url: 'https://gitlab.com/oauth/token', body: 'form' },
    credential: {
      access: 'access_token',
      refresh: 'refresh_token',
      expires: { mode: 'seconds', path: 'expires_in', from: 'created_at', skewMs: 300000 }
    },
    refresh: {}
  },
  'google-gemini-cli': {
    name: 'Google Cloud Code Assist (Gemini CLI)',
    clientId: oauthDecodeB64(''),
    clientSecret: oauthDecodeB64(''),
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    instructions: 'Complete the sign-in in your browser.',
    callback: { port: 8085, path: '/oauth2callback', hostname: '127.0.0.1' },
    token: {
      url: 'https://oauth2.googleapis.com/token',
      body: 'form',
      params: {
        client_id: '{client_id}',
        client_secret: oauthDecodeB64('')
      }
    },
    credential: {
      access: 'access_token',
      refresh: 'refresh_token',
      expires: { mode: 'seconds', path: 'expires_in', skewMs: 300000 }
    },
    userinfo: { url: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json', email: 'email' },
    refresh: {},
    afterExchange: function (credentials, signal) {
      return oauthGoogleCloudCodeProject(credentials.access, 'https://cloudcode-pa.googleapis.com', signal)
        .then(function (projectId) { if (projectId) credentials.projectId = projectId })
        .catch(function () {})
    }
  },
  'google-antigravity': {
    name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
    clientId: oauthDecodeB64(''),
    clientSecret: oauthDecodeB64(''),
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs'
    ],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    instructions: 'Complete the sign-in in your browser.',
    callback: { port: 51121, path: '/oauth-callback', hostname: '127.0.0.1' },
    token: {
      url: 'https://oauth2.googleapis.com/token',
      body: 'form',
      params: {
        client_id: '{client_id}',
        client_secret: oauthDecodeB64('')
      }
    },
    credential: {
      access: 'access_token',
      refresh: 'refresh_token',
      expires: { mode: 'seconds', path: 'expires_in', skewMs: 300000 }
    },
    userinfo: { url: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json', email: 'email' },
    refresh: {},
    afterExchange: function (credentials, signal) {
      return oauthGoogleCloudCodeProject(credentials.access, 'https://daily-cloudcode-pa.googleapis.com', signal)
        .then(function (projectId) { if (projectId) credentials.projectId = projectId })
        .catch(function () {})
    }
  },
  'zai-coding-plan': {
    name: 'Z.AI (GLM Coding Plan)',
    envVars: { ZAI_OAUTH_CLIENT_ID: 'clientId', ZAI_OAUTH_REDIRECT_URI: 'redirectUri', ZAI_OAUTH_AUTHORIZE_URL: 'authorizeUrl', ZAI_OAUTH_TOKEN_URL: 'tokenUrl' },
    clientId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
    authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
    pkce: false,
    instructions: 'Complete Z.ai login in the browser, then paste the final redirect URL or authorization code here.',
    callback: { manualOnly: true, redirectUri: 'zcode://zai-auth/callback' },
    token: {
      url: 'https://zcode.z.ai/api/v1/oauth/token',
      body: 'json',
      standard: false,
      params: { provider: 'zai', code: '{code}', redirect_uri: '{redirect_uri}', state: '{state}' }
    },
    credential: {
      access: 'data.zai.access_token',
      refresh: 'data.zai.access_token',
      expires: { mode: 'never' },
      extra: { email: 'data.user.email', accountId: 'data.user.id' }
    },
    refresh: null
  }
}

/* ------------------------------------------------------------------ */
/* replica registry -> ProviderConfigInput                              */
/* ------------------------------------------------------------------ */

function oauthCodeFlowFor (spec) {
  return function (callbacks) {
    return oauthRunCodeFlow(spec, callbacks).then(function (credentials) {
      if (spec.afterExchange) {
        return Promise.resolve(spec.afterExchange(credentials, callbacks && callbacks.signal))
          .then(function () { return credentials })
      }
      return credentials
    })
  }
}

function oauthGetApiKey (credentials) {
  return credentials.access
}

/* ------------------------------------------------------------------ */
/* vendored omp transports                                             */
/* ------------------------------------------------------------------ */

/* main/vendor/omp/bundle.mjs is built by scripts/buildOmpProviders.mjs
straight from the installed @oh-my-pi/* packages — no code is copied, so
syncing to a newer omp is `npm update` + re-running that script. Loaded
lazily: it's an ESM bundle while this file runs inside the CJS main
concatenation. */
var ompBundlePromise = null
function loadOmpBundle () {
  if (!ompBundlePromise) {
    ompBundlePromise = Promise.resolve().then(async function () {
      const pathMod = require('path')
      const { pathToFileURL } = require('url')
      const active = typeof minOmpUpdates !== 'undefined' && minOmpUpdates.activeBundle()
      if (active) {
        try { return await import(pathToFileURL(active.path).href) } catch (err) {
          console.warn('OMP update could not load; using bundled components', err.message)
        }
      }
      return import(pathToFileURL(pathMod.join(__dirname, 'main/vendor/omp/bundle.mjs')).href)
    }).catch(function (err) {
      console.warn('omp provider bundle unavailable; replicas stay auth-only', err)
      return null
    })
  }
  return ompBundlePromise
}

/* OMP ModelSpec -> ProviderConfigInput.models[] entry. applyExtension()
spreads the definition wholesale, so unknown fields ride along harmlessly —
but normalize the fields the SDK actually reads. apiOverride rewrites the
api so extension.streamSimple dispatch (model.api === extension.api) hits
our vendored stream even when the model's real wire is a standard one
(gitlab-duo routes internally via model.id). */
function ompToPiModel (spec, apiOverride) {
  if (!spec || !spec.id) return null
  return {
    id: spec.id,
    name: spec.name || spec.id,
    api: apiOverride || spec.api,
    baseUrl: spec.baseUrl,
    reasoning: !!spec.reasoning,
    input: Array.isArray(spec.input) && spec.input.length ? spec.input.slice() : ['text'],
    cost: spec.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow || 0,
    maxTokens: spec.maxTokens || 0,
    compat: spec.compat,
    headers: spec.headers
  }
}

function ompCredentialToken (credential) {
  if (!credential) return null
  if (credential.type === 'oauth') return credential.access || null
  if (credential.type === 'api_key') return credential.key || null
  return null
}

/* google streams expect options.apiKey to be a JSON blob carrying token +
projectId (+ refresh/expiry for staleness checks), not a bare token */
function oauthGoogleApiKey (credentials) {
  return JSON.stringify({
    token: credentials.access,
    projectId: credentials.projectId,
    refreshToken: credentials.refresh,
    expiresAt: credentials.expires,
    email: credentials.email
  })
}

/* wraps an omp discovery fn: resolves the token from the SDK credential,
returns undefined when there's nothing to query. Discovery failures reach
the SDK, which preserves the stored catalog and reports a refresh warning. */
function ompRefreshModels (fetcher, apiOverride) {
  return function (context) {
    const credential = context && context.credential
    const token = ompCredentialToken(credential)
    if (!token || (context && context.allowNetwork === false)) return Promise.resolve(undefined)
    return Promise.resolve(fetcher(credential, context))
      .then(function (specs) {
        if (!specs || !specs.length) return undefined
        return specs.map(function (s) { return ompToPiModel(s, apiOverride) }).filter(Boolean)
      })
      .catch(function (err) {
        console.warn('omp model discovery failed', err && err.message)
        throw err
      })
  }
}

/* static catalog seed from the bundled models.json — keeps every provider's
known models listed even before/without a successful live discovery */
function ompSeedModels (omp, providerId, apiOverride) {
  try {
    const specs = omp.getBundledModels(providerId)
    if (!Array.isArray(specs)) return []
    return specs.map(function (s) { return ompToPiModel(s, apiOverride) }).filter(Boolean)
  } catch (err) {
    return []
  }
}

/* chat wiring per replica, resolved against the loaded bundle. Extension
dispatch is `model.api === extension.api` -> extension.streamSimple, so the
api here must equal the api stamped on each registered model:
- devin/cursor models carry their proprietary api already
- gitlab-duo models carry standard wire apis (anthropic/openai) but
  streamGitLabDuo routes internally by model.id after exchanging the OAuth
  token for a direct-access token — so we stamp api 'gitlab-duo' on them
- google gemini-cli + antigravity share api 'google-gemini-cli'; the stream
  branches on model.provider, which the runtime sets from the provider id
- zai rides the standard wires (models carry anthropic-messages /
  openai-completions) so it needs no streamSimple at all */
function ompWireFor (id, omp) {
  switch (id) {
    case 'devin':
      return {
        api: 'devin-agent',
        streamSimple: omp.streamDevin,
        models: ompSeedModels(omp, 'devin'),
        refreshModels: ompRefreshModels(function (credential, context) {
          return omp.fetchDevinModels({ apiKey: credential.access, signal: context && context.signal })
        })
      }
    case 'cursor':
      return {
        api: 'cursor-agent',
        streamSimple: omp.streamCursor,
        models: ompSeedModels(omp, 'cursor'),
        refreshModels: ompRefreshModels(function (credential) {
          return omp.fetchCursorUsableModels({ apiKey: credential.access })
        })
      }
    case 'gitlab-duo': {
      let models = []
      try {
        models = (omp.getGitLabDuoModels() || []).map(function (s) { return ompToPiModel(s, 'gitlab-duo') }).filter(Boolean)
      } catch (err) {}
      return { api: 'gitlab-duo', streamSimple: omp.streamGitLabDuo, models: models }
    }
    case 'google-gemini-cli':
      return {
        api: 'google-gemini-cli',
        streamSimple: omp.streamGoogleGeminiCli,
        models: ompSeedModels(omp, 'google-gemini-cli'),
        refreshModels: ompRefreshModels(function (credential, context) {
          return omp.fetchGeminiCliQuotaModels({
            token: credential.access,
            projectId: credential.projectId,
            signal: context && context.signal
          })
        })
      }
    case 'google-antigravity':
      return {
        api: 'google-gemini-cli',
        streamSimple: omp.streamGoogleGeminiCli,
        models: ompSeedModels(omp, 'google-antigravity'),
        refreshModels: ompRefreshModels(function (credential, context) {
          return omp.fetchAntigravityDiscoveryModels({
            token: credential.access,
            signal: context && context.signal
          })
        })
      }
    case 'zai-coding-plan':
      return { models: ompSeedModels(omp, 'zai') }
    default:
      return {}
  }
}

/* env overrides from the KDL (env="X" on fields): envVars maps the env var
name to the spec field it overrides — applied before each login */
function oauthApplyEnvOverrides (spec) {
  const map = spec.envVars || {}
  Object.keys(map).forEach(function (envName) {
    const value = process.env[envName]
    if (!value) return
    const field = map[envName]
    if (field === 'clientId') spec.clientId = value
    else if (field === 'authorizeUrl') spec.authorizeUrl = value
    else if (field === 'tokenUrl') spec.token.url = value
    else if (field === 'redirectUri') spec.callback.redirectUri = value
  })
}

/* auth layer per replica; ompWireFor() merges the vendored chat transport
(streamSimple/models/refreshModels) on top when the omp bundle is present —
without it these still register auth-only (models: []) */
const OMP_PROVIDER_CONFIGS = {
  cursor: {
    name: 'Cursor',
    baseUrl: 'https://api2.cursor.sh',
    oauth: {
      name: 'Cursor',
      isSubscription: true,
      login: oauthCursorLogin,
      refreshToken: oauthCursorRefresh,
      getApiKey: oauthGetApiKey
    },
    models: []
  },
  devin: {
    name: 'Devin',
    baseUrl: 'https://api.devin.ai',
    oauth: {
      name: 'Devin',
      isSubscription: true,
      login: function (callbacks) { return oauthCodeFlowFor(OMP_OAUTH_CODE_SPECS.devin)(callbacks) },
      refreshToken: function (credentials, signal) { return oauthRunRefresh(OMP_OAUTH_CODE_SPECS.devin, credentials, signal) },
      getApiKey: oauthGetApiKey
    },
    models: []
  },
  'gitlab-duo': {
    name: 'GitLab Duo',
    baseUrl: 'https://gitlab.com',
    oauth: {
      name: 'GitLab Duo',
      isSubscription: true,
      login: function (callbacks) {
        oauthApplyEnvOverrides(OMP_OAUTH_CODE_SPECS['gitlab-duo'])
        return oauthCodeFlowFor(OMP_OAUTH_CODE_SPECS['gitlab-duo'])(callbacks)
      },
      refreshToken: function (credentials, signal) { return oauthRunRefresh(OMP_OAUTH_CODE_SPECS['gitlab-duo'], credentials, signal) },
      getApiKey: oauthGetApiKey
    },
    models: []
  },
  'google-gemini-cli': {
    name: 'Google Cloud Code Assist (Gemini CLI)',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    oauth: {
      name: 'Google Cloud Code Assist (Gemini CLI)',
      isSubscription: true,
      login: function (callbacks) { return oauthCodeFlowFor(OMP_OAUTH_CODE_SPECS['google-gemini-cli'])(callbacks) },
      refreshToken: function (credentials, signal) { return oauthRunRefresh(OMP_OAUTH_CODE_SPECS['google-gemini-cli'], credentials, signal) },
      /* the vendored stream parses apiKey as a JSON credential blob */
      getApiKey: oauthGoogleApiKey
    },
    models: []
  },
  'google-antigravity': {
    name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    oauth: {
      name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
      isSubscription: true,
      login: function (callbacks) { return oauthCodeFlowFor(OMP_OAUTH_CODE_SPECS['google-antigravity'])(callbacks) },
      refreshToken: function (credentials, signal) { return oauthRunRefresh(OMP_OAUTH_CODE_SPECS['google-antigravity'], credentials, signal) },
      /* the vendored stream parses apiKey as a JSON credential blob */
      getApiKey: oauthGoogleApiKey
    },
    models: []
  },
  'zai-coding-plan': {
    name: 'Z.AI (GLM Coding Plan)',
    baseUrl: 'https://api.z.ai',
    oauth: {
      name: 'Z.AI (GLM Coding Plan)',
      isSubscription: true,
      login: function (callbacks) {
        oauthApplyEnvOverrides(OMP_OAUTH_CODE_SPECS['zai-coding-plan'])
        return oauthCodeFlowFor(OMP_OAUTH_CODE_SPECS['zai-coding-plan'])(callbacks)
      },
      refreshToken: function (credentials, signal) { return oauthRunRefresh(OMP_OAUTH_CODE_SPECS['zai-coding-plan'], credentials, signal) },
      getApiKey: oauthGetApiKey
    },
    models: []
  }
}

const OMP_REPLICA_LABELS = Object.keys(OMP_PROVIDER_CONFIGS).reduce(function (acc, id) {
  acc[id] = OMP_PROVIDER_CONFIGS[id].name
  return acc
}, {})

/* registers every replica on a ModelRuntime; safe to call per runtime —
registration is per-instance. Async because the vendored transport bundle
is ESM. */
async function installOmpProviders (modelRuntime) {
  const omp = await loadOmpBundle()
  Object.keys(OMP_PROVIDER_CONFIGS).forEach(function (id) {
    try {
      const wire = omp ? ompWireFor(id, omp) : {}
      modelRuntime.registerProvider(id, Object.assign({}, OMP_PROVIDER_CONFIGS[id], wire))
    } catch (err) {
      console.warn('failed to register omp provider replica', id, err)
    }
  })
}

/* opens the provider's authorization page in a Min browser tab; falls back
to the OS handler only if the renderer can't take it */
function oauthOpenAuthUrl (url) {
  try {
    if (typeof openTabInWindow === 'function') {
      openTabInWindow(url)
      return
    }
  } catch (err) {}
  try {
    require('electron').shell.openExternal(url)
  } catch (err) {}
}

/* exposed on global for agent.js (concatenated bundle scope) and for the
node --test harness, which loads this file in a bare vm context */
var agentOAuth = {
  invalidateBundle: function () { ompBundlePromise = null },
  installOmpProviders: installOmpProviders,
  replicaLabels: OMP_REPLICA_LABELS,
  replicaIds: Object.keys(OMP_PROVIDER_CONFIGS),
  openAuthUrl: oauthOpenAuthUrl,
  /* internals kept reachable for unit tests */
  _internals: {
    pkce: oauthGeneratePKCE,
    dotGet: oauthDotGet,
    jwtExpiryMs: oauthJwtExpiryMs,
    parseAuthorizationInput: oauthParseAuthorizationInput,
    extractCredentials: oauthExtractCredentials,
    runCodeFlow: oauthRunCodeFlow,
    runRefresh: oauthRunRefresh,
    cursorLogin: oauthCursorLogin,
    cursorRefresh: oauthCursorRefresh,
    callbackServer: oauthStartCallbackServer,
    specs: OMP_OAUTH_CODE_SPECS
  }
}
global.agentOAuth = agentOAuth
