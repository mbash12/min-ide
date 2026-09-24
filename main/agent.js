/* global fs, ipc, net, settings, kvGet, kvSet, kvList, AbortSignal, minAgentTools, agentOAuth */
/* AI sidebar agent: runs a pi SDK (https://pi.dev) AgentSession in the main
process and streams its events to the renderer over IPC. The renderer's chat
UI lives in js/sidebar/agentPanel.js.

The pi SDK is ESM-only while Min's main bundle is a CJS concatenation, so it
is loaded lazily with a dynamic import(). The OpenRouter API key and model id
come from the app's settings ('openrouterApiKey' / 'agentModel', configurable on
the settings page). Conversations persist as pi session JSONL files under
Min's userData (one live AgentSession per task). Switching history
replaces that live session; it does not run chats in parallel.

fs, path, ipc and settings are already provided by main.js (all main modules
share one scope in the concatenated bundle) */

let sdkPromise = null // memoized dynamic import of the ESM-only pi SDK
let typeboxPromise = null // TypeBox lives under the pi SDK and is ESM-only
let modelCatalogCache = null // cached model list (from the pi SDK catalog) for the picker
let modelCatalogAt = 0
let modelCatalogLoading = null
let modelCatalogRevision = 0
let agentRuntimeRevision = 0
let agentConfigRevision = 0
/* one session per task, keyed by task id, so switching tasks keeps each
task's own conversation and context. */
const agentSessions = new Map() // sessionKey -> { sessionKey, taskId, cwd, apiKey, modelId, provider, session, unsubscribe, modelRuntime, resolvedModel }
const prefsByCwd = new Map() // sessionKey -> { modelId, provider, thinkingLevel }
const agentSessionLifecycle = require(require('path').join(__dirname, 'main/lib/agent/lifecycleCoordinator.js')).createLifecycleCoordinator()
const agentSessionSerialization = require(require('path').join(__dirname, 'main/lib/agent/sessionSerialization.js'))
const serializeAgentEvent = agentSessionSerialization.serializeAgentEvent
const serializeMessages = agentSessionSerialization.serializeMessages

/* The pi SDK is the execution engine and we use it fully (its model catalog,
sessions, etc.). To keep Min a distinct product from the pi CLI that may be
installed on this machine, the SDK's data dirs (sessions, logs, package cache,
model catalogs) are redirected to Min's own userData via env vars inside
loadPiSdk() — so Min never merges its data with the laptop's ~/.pi. */
const PROVIDER_LABELS = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google AI',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  'ant-ling': 'Ant Ling',
  'azure-openai-responses': 'Azure OpenAI',
  nvidia: 'NVIDIA NIM',
  'amazon-bedrock': 'Amazon Bedrock',
  cerebras: 'Cerebras',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  zai: 'ZAI',
  'zai-coding-cn': 'ZAI Coding (CN)',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  radius: 'Radius',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks',
  together: 'Together AI',
  baseten: 'Baseten',
  'kimi-coding': 'Kimi For Coding',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax (CN)',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-individual': 'Qwen Token Plan (Individual)',
  'qwen-token-plan-cn': 'Qwen Token Plan (CN)',
  xiaomi: 'Xiaomi MiMo',
  'xiaomi-token-plan-cn': 'Xiaomi MiMo (CN)',
  'xiaomi-token-plan-ams': 'Xiaomi MiMo (AMS)',
  'xiaomi-token-plan-sgp': 'Xiaomi MiMo (SGP)'
}

/* built-in pi tools every session gets; also listed by the Pro Settings
"Tools" tab, so keep both reads off the same list */
const AGENT_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
/* tool-name -> sdk factory used to probe each tool's own description */
const AGENT_BUILTIN_TOOL_FACTORIES = {
  read: 'createReadTool',
  bash: 'createBashTool',
  edit: 'createEditTool',
  write: 'createWriteTool',
  grep: 'createGrepTool',
  find: 'createFindTool',
  ls: 'createLsTool'
}
const agentSenders = new Set() // webContents that should receive agent events

function getAgentDataDir () {
  return require('path').join(require('electron').app.getPath('userData'), 'pi-agent')
}

function getAgentSkillDirs (cwd) {
  const pathMod = require('path')
  return {
    user: pathMod.join(getAgentDataDir(), 'skills'),
    project: cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()
      ? pathMod.join(cwd, '.pi', 'skills')
      : null
  }
}

/* Share the exact skill sources between sessions and the Tools directory.
 * The SDK's default resource loader also discovers ~/.agents/skills and
 * ancestor .agents directories, independently of PI_CODING_AGENT_DIR. Those
 * belong to other apps; only Min-owned and workspace skills are loaded here. */
function loadAgentSkills (sdk, cwd) {
  const dirs = getAgentSkillDirs(cwd)
  return sdk.loadSkills({
    cwd: getEffectiveCwd(cwd),
    agentDir: getAgentDataDir(),
    skillPaths: Object.values(dirs).filter(function (dir) { return dir && fs.existsSync(dir) }),
    includeDefaults: false
  })
}

async function createAgentResourceLoader (sdk, cwd, settingsManager) {
  const loader = new sdk.DefaultResourceLoader({
    cwd: getEffectiveCwd(cwd),
    agentDir: getAgentDataDir(),
    settingsManager: settingsManager,
    // Min supplies its own tools; do not auto-register SDK extensions.
    noExtensions: true,
    noSkills: true,
    skillsOverride: function () { return loadAgentSkills(sdk, cwd) },
    appendSystemPromptOverride: function (base) {
      return base.concat([
        'You are the AI assistant inside Min. Use the tools and skills supplied in this session for this workspace.',
        'Use the same feature names as Min: Browser (browser), Playbook (playbook), Docs (docs), and Design (design, including Figma and the Build list).',
        'When asked what is in the Build list (design spec / daftar build), call design with {"action":"spec-list"} before answering. It reads saved entries from the workspace database and works without a Figma connection.',
        'Describe available capabilities from the current tool definitions and skills, even if earlier chat messages listed different ones.'
      ].join('\n'))
    }
  })
  await loader.reload()
  return loader
}

async function loadMinCustomTools (sdk, cwd, taskId, workspaceId) {
  try {
    const Type = await loadTypebox()
    return minAgentTools.create(sdk.defineTool, Type, cwd || null, taskId, workspaceId)
  } catch (err) {
    throw new Error('Min agent tools could not be loaded: ' + ((err && err.message) || String(err)))
  }
}

function loadPiSdk () {
  if (!sdkPromise) {
    /* Keep Min's data separate from any pi CLI installed on this machine. The
    SDK honours these env vars (see @earendil-works/pi-coding-agent/dist/config.js)
    for where it stores sessions, logs and cached packages. Pointing them at
    Min's own userData makes Min a self-contained app that never reads or writes
    the laptop's ~/.pi. */
    try {
      const agentDataDir = getAgentDataDir()
      process.env.PI_CODING_AGENT_DIR = agentDataDir
      process.env.PI_CODING_AGENT_SESSION_DIR = require('path').join(agentDataDir, 'sessions')
      process.env.PI_PACKAGE_DIR = require('path').join(agentDataDir, 'packages')
      // mirror any stored provider keys into the SDK's auth.json
      syncProviderAuthFile()
    } catch (err) {}
    sdkPromise = import('@earendil-works/pi-coding-agent').then(function (mod) {
      if (!mod || typeof mod.createAgentSession !== 'function') {
        throw new Error('pi SDK did not load correctly')
      }
      return mod
    })
  }
  return sdkPromise
}

function loadTypebox () {
  if (!typeboxPromise) {
    const { pathToFileURL } = require('url')
    const pathMod = require('path')
    const fsMod = require('fs')
    /* The SDK used to vendor typebox at a fixed nested path; newer installs
    may hoist it or rename the package, so try several candidates. */
    const candidates = [
      'node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs',
      'node_modules/typebox/build/index.mjs',
      'node_modules/@sinclair/typebox/build/index.mjs'
    ]
    let typeboxFile = null
    for (const rel of candidates) {
      const p = pathMod.join(__dirname, rel)
      try {
        if (fsMod.existsSync(p)) {
          typeboxFile = p
          break
        }
      } catch (e) {}
    }
    if (!typeboxFile) {
      try {
        /* last resort: let Node's resolution find it (works when the SDK is
        a real dependency and typebox is a regular hoisted package) */
        typeboxFile = require.resolve('typebox/build/index.mjs', { paths: [__dirname] })
      } catch (e) {}
    }
    if (!typeboxFile) {
      typeboxPromise = Promise.reject(new Error('typebox could not be located; agent tools disabled'))
    } else {
      typeboxPromise = import(pathToFileURL(typeboxFile).href).then(function (mod) {
        const Type = (mod && mod.Type) || (mod && mod.default)
        if (!Type) throw new Error('typebox did not load correctly')
        return Type
      })
    }
  }
  return typeboxPromise
}

function registerSender (sender) {
  if (!sender || sender.isDestroyed() || agentSenders.has(sender)) return
  agentSenders.add(sender)
  sender.once('destroyed', function () {
    agentSenders.delete(sender)
  })
}

function getClientTaskId (taskId) {
  if (taskId != null && taskId !== '') {
    return String(taskId)
  }
  return 'default'
}

function getSessionKey (taskId, cwd) {
  if (taskId != null && taskId !== '') {
    return 'task-' + String(taskId)
  }
  if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
    return 'cwd-' + cwd
  }
  return 'ws-default'
}

function getEffectiveCwd (cwd) {
  if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
    return cwd
  }
  return require('os').homedir()
}

function getSessionsRoot () {
  try {
    return require('path').join(require('electron').app.getPath('userData'), 'pi-agent', 'sessions')
  } catch (e) {
    return ''
  }
}

/* SessionManager's default directory is keyed by cwd. Min workspaces need a
 * stronger boundary: the blueprint scopes AI sessions to the Workspace
 * (Workspace -> AI Sessions[]), and every task in the workspace shares that
 * history - which task currently owns a session is a renderer-side matter
 * (task.prefs.agentSession), not a storage one. A workspace may also have no
 * folder at all, so key by workspace id. Hashing keeps arbitrary ids out of
 * the filesystem path. */
function getWorkspaceSessionDir (workspaceId, cwd) {
  const sessionsRoot = getSessionsRoot()
  if (!sessionsRoot) return null
  const key = (workspaceId && workspaceId !== 'default')
    ? 'ws-' + String(workspaceId)
    : getSessionKey(null, cwd)
  const digest = require('crypto').createHash('sha256').update(key).digest('hex')
  return require('path').join(sessionsRoot, 'workspaces', 'ws-' + digest)
}

/* The per-task session pointer has to outlive a restart: without it a task
 * comes back on whichever conversation was modified last instead of the one
 * that was actually open. It sits next to the sessions it refers to, as one
 * small JSON file keyed by session key. */
function getAgentPrefsPath () {
  const sessionsRoot = getSessionsRoot()
  if (!sessionsRoot) return null
  return require('path').join(sessionsRoot, '..', 'agent-prefs.json')
}

let agentPrefsLoaded = false
let agentPrefsSaveTimer = null

function loadAgentPrefs () {
  if (agentPrefsLoaded) return
  agentPrefsLoaded = true

  /* the central DB is the primary store; the legacy JSON file next to the
  sessions is only read as an upgrade path */
  let parsed = null
  try {
    parsed = kvGet('ai_config', 'sessionPrefs')
  } catch (e) {}
  if (!parsed) {
    const prefsPath = getAgentPrefsPath()
    try {
      if (prefsPath) parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
    } catch (err) {}
  }
  Object.keys(parsed || {}).forEach(function (sessionKey) {
    const entry = parsed[sessionKey]
    if (entry && typeof entry === 'object') {
      prefsByCwd.set(sessionKey, entry)
    }
  })
}

function saveAgentPrefs () {
  const stored = {}
  prefsByCwd.forEach(function (value, key) {
    stored[key] = value
  })
  try {
    kvSet('ai_config', 'sessionPrefs', stored)
  } catch (err) {
    console.warn('failed to save agent session pointers', err)
  }
  // legacy file copy kept as a crash backup
  const prefsPath = getAgentPrefsPath()
  if (!prefsPath) return
  try {
    // write-file-atomic does not create the directory, and pi-agent/ is made
    // by the SDK, so it may not exist yet
    fs.mkdirSync(require('path').dirname(prefsPath), { recursive: true })
    require('write-file-atomic').sync(prefsPath, JSON.stringify(stored), {})
  } catch (err) {
    console.warn('failed to save agent session pointers', err)
  }
}

/* coalesces the writes: a single action can set several fields in a row */
function scheduleAgentPrefsSave () {
  if (agentPrefsSaveTimer) return
  agentPrefsSaveTimer = setTimeout(function () {
    agentPrefsSaveTimer = null
    saveAgentPrefs()
  }, 400)
}

/* Provider/agent configuration lives in the central DB (kv scopes
 * 'provider_config' and 'ai_config'); Min's settings are only a fallback and
 * an upgrade path - a settings value found there is migrated into the DB. */
/* a disabled provider keeps its stored key (so it can be re-enabled without
re-entering it) but is invisible to the runtime: no key is installed, no
auth.json entry, and its models drop out of the catalog */
function isProviderDisabled (provider) {
  try {
    return !!kvGet('provider_config', provider + 'Disabled')
  } catch (e) {
    return false
  }
}

function getProviderApiKey (provider) {
  provider = provider || 'openrouter'
  if (isProviderDisabled(provider)) return null
  try {
    const fromDb = kvGet('provider_config', provider + 'ApiKey')
    if (fromDb) return fromDb
  } catch (e) {}
  // legacy upgrade path: the OpenRouter key used to live in settings.json
  if (provider === 'openrouter') {
    const key = settings.get('openrouterApiKey')
    if (key) {
      try { kvSet('provider_config', 'openrouterApiKey', key) } catch (e) {}
      return key
    }
  }
  return null
}

function getAllProviderKeys () {
  const keys = {}
  try {
    const all = kvList('provider_config')
    Object.keys(all).forEach(function (kvKey) {
      if (kvKey.endsWith('ApiKey') && all[kvKey]) {
        const provider = kvKey.slice(0, -'ApiKey'.length)
        if (!isProviderDisabled(provider)) {
          keys[provider] = all[kvKey]
        }
      }
    })
  } catch (e) {}
  // legacy upgrade path: the OpenRouter key used to live in settings.json
  if (!keys.openrouter) {
    const key = getProviderApiKey('openrouter')
    if (key) keys.openrouter = key
  }
  return keys
}

/* runtime api keys are not persisted automatically - install every
configured key on each fresh ModelRuntime so getAvailable() sees all
providers */
async function installProviderKeys (modelRuntime) {
  const keys = getAllProviderKeys()
  for (const provider of Object.keys(keys)) {
    try {
      await modelRuntime.setRuntimeApiKey(provider, keys[provider])
    } catch (e) {}
  }
  return keys
}

function getAgentAuthFilePath () {
  try {
    return require('path').join(require('electron').app.getPath('userData'), 'pi-agent', 'auth.json')
  } catch (err) {
    return null
  }
}

/* reads the SDK's auth.json once; used to flag which providers already have
stored credentials (api_key entries are synced from provider_config, oauth
entries are written by agent-provider-login) */
function readAgentAuthFile () {
  const authPath = getAgentAuthFilePath()
  if (!authPath || !fs.existsSync(authPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8')) || {}
  } catch (err) {
    return {}
  }
}

/* every ModelRuntime gets the same treatment: replicated omp OAuth providers
registered, then Min's stored provider_config keys installed as runtime keys */
async function createAgentModelRuntime (options) {
  options = options || {}
  const sdk = await loadPiSdk()
  // Install credentials and OMP adapters before the single catalog refresh.
  const modelRuntime = await sdk.ModelRuntime.create({
    refreshOnCreate: false
  })
  try {
    await agentOAuth.installOmpProviders(modelRuntime)
  } catch (err) {
    console.warn('failed to install omp provider replicas', err)
  }
  await installProviderKeys(modelRuntime)
  modelRuntime.minCatalogRefresh = await modelRuntime.refresh({
    allowNetwork: true,
    force: !!options.force,
    signal: AbortSignal.timeout(12000)
  })
  return modelRuntime
}

/* mirrors provider_config api keys into the SDK's own auth.json so
credentials are resolved natively (auth file takes priority over env vars);
OAuth and other non-api-key entries are preserved untouched */
function syncProviderAuthFile () {
  try {
    const authPath = getAgentAuthFilePath()
    if (!authPath) return
    const auth = readAgentAuthFile()
    const keys = getAllProviderKeys()
    // drop api_key entries for providers no longer configured, keep the rest
    Object.keys(auth).forEach(function (provider) {
      if (auth[provider] && auth[provider].type === 'api_key' && !keys[provider]) {
        delete auth[provider]
      }
    })
    Object.keys(keys).forEach(function (provider) {
      const existing = auth[provider]
      if (!existing || existing.type === 'api_key') {
        auth[provider] = { type: 'api_key', key: keys[provider] }
      }
    })
    fs.mkdirSync(require('path').dirname(authPath), { recursive: true })
    require('write-file-atomic').sync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
  } catch (err) {
    console.warn('failed to sync provider auth.json', err)
  }
}

function invalidateModelCatalog () {
  modelCatalogAt = 0
  modelCatalogRevision++
  broadcastAgentEvent({ type: 'models_changed' })
}

// Called by ompUpdates.js in the concatenated main bundle.
function onAgentComponentsUpdated () { // eslint-disable-line no-unused-vars
  agentOAuth.invalidateBundle()
  agentRuntimeRevision++
  invalidateModelCatalog()
}

/* called by dbService whenever provider_config changes */
function onProviderConfigChanged () { // eslint-disable-line no-unused-vars
  agentConfigRevision++
  invalidateModelCatalog()
  syncProviderAuthFile()
}

function getAgentSetting (key) {
  try {
    const fromDb = kvGet('ai_config', key)
    if (fromDb !== null && fromDb !== undefined) return fromDb
  } catch (e) {}
  const value = settings.get(key)
  if (value !== null && value !== undefined) {
    try { kvSet('ai_config', key, value) } catch (e) {}
  }
  return value
}

/* the remembered settings of a session, loading the file on first use so the
 * order modules load in does not matter */
function prefsFor (sessionKey) {
  loadAgentPrefs()
  return prefsByCwd.get(sessionKey) || {}
}

const MAX_SESSION_PREFS = 500
function setSessionPrefs (sessionKey, prefs) {
  /* bound the map: session keys include ephemeral cwd-derived ids that are
  otherwise never cleaned up */
  if (!prefsByCwd.has(sessionKey) && prefsByCwd.size >= MAX_SESSION_PREFS) {
    const oldest = prefsByCwd.keys().next().value
    prefsByCwd.delete(oldest)
  }
  prefsByCwd.set(sessionKey, prefs)
  scheduleAgentPrefsSave()
}

function forgetSessionPrefs (sessionKey) {
  if (prefsByCwd.delete(sessionKey)) {
    scheduleAgentPrefsSave()
  }
}

function isAllowedSessionPath (sessionPath) {
  if (!sessionPath || typeof sessionPath !== 'string') return false
  const pathMod = require('path')
  const sessionsRoot = getSessionsRoot()
  if (!sessionsRoot) return false
  const resolved = pathMod.resolve(sessionPath)
  const root = pathMod.resolve(sessionsRoot)
  if (!/\.jsonl$/i.test(resolved)) return false
  const prefix = root.endsWith(pathMod.sep) ? root : root + pathMod.sep
  return resolved === root || resolved.startsWith(prefix)
}

function getLiveSessionFile (entry) {
  try {
    return (entry && entry.session && entry.session.sessionFile) || null
  } catch (e) {
    return null
  }
}

function serializeSessionInfo (info) {
  const named = info && info.name ? String(info.name).trim() : ''
  const first = info && info.firstMessage
    ? String(info.firstMessage).replace(/\s+/g, ' ').trim()
    : ''
  const title = named || first || 'New chat'
  return {
    path: info.path,
    id: info.id,
    title: title.slice(0, 140),
    created: info.created instanceof Date ? info.created.getTime() : +new Date(info.created),
    modified: info.modified instanceof Date ? info.modified.getTime() : +new Date(info.modified),
    messageCount: info.messageCount || 0
  }
}

async function disposeSessionEntry (sessionKey) {
  const entry = sessionKey != null ? agentSessions.get(sessionKey) : null
  if (!entry) return
  try {
    if (entry.session && entry.session.isStreaming) {
      await entry.session.abort()
    }
  } catch (e) {}
  try {
    if (entry.unsubscribe) entry.unsubscribe()
  } catch (e) {}
  try {
    if (entry.session) entry.session.dispose()
  } catch (e) {}
  /* ModelRuntime has no dispose in current SDKs, but drop the reference and
  call dispose if a future version adds one so resources don't accumulate
  across model/session switches. */
  try {
    if (entry.modelRuntime && typeof entry.modelRuntime.dispose === 'function') {
      entry.modelRuntime.dispose()
    }
  } catch (e) {}
  entry.modelRuntime = null
  if (agentSessions.get(sessionKey) === entry) agentSessions.delete(sessionKey)
}

async function destroySession (sessionKey) {
  if (sessionKey == null) return
  return agentSessionLifecycle.invalidateAndRun(sessionKey, function () {
    return disposeSessionEntry(sessionKey)
  })
}

async function listTaskSessions (sdk, effectiveCwd, sessionDir) {
  let listed = []
  try {
    listed = sessionDir
      // A task directory is already the scope. list(cwd, dir) applies
      // an additional cwd filter, which would hide a task's history if
      // its folder is later missing or changed.
      ? await sdk.SessionManager.listAll(sessionDir)
      : await sdk.SessionManager.list(effectiveCwd)
    listed = listed || []
  } catch (e) {}

  /* Sessions created before task-scoped storage live in pi's cwd-based
   * directory. Keep those available as a migration bridge, but only while the
   * new task directory is empty; once a task has new sessions its
   * history remains strictly scoped. */
  if (listed.length || !sessionDir) return listed
  try {
    return (await sdk.SessionManager.list(effectiveCwd)) || []
  } catch (e) {
    return listed
  }
}

async function resolveSessionFile (sdk, effectiveCwd, sessionDir, options, prefs, existing) {
  options = options || {}
  if (options.createNew) return { path: null }
  if (options.openPath) {
    if (isAllowedSessionPath(options.openPath) && fs.existsSync(options.openPath)) {
      return { path: options.openPath }
    }
    return { path: null, invalid: true }
  }
  const livePath = getLiveSessionFile(existing)
  if (livePath && isAllowedSessionPath(livePath) && fs.existsSync(livePath)) {
    return { path: livePath }
  }
  if (prefs.sessionPath && isAllowedSessionPath(prefs.sessionPath) && fs.existsSync(prefs.sessionPath)) {
    return { path: prefs.sessionPath }
  }
  if (options.restoreRecent) {
    /* A task only ever restores the session it actually had open. The session
    directory is shared workspace-wide now, so "the most recent file in it"
    would often be another task's chat - a task with no saved pointer simply
    has no session. */
    return { path: null, none: true }
  }
  return { path: null }
}

function broadcastAgentEvent (data, sessionKey, taskId, workspaceId) {
  const entry = sessionKey != null ? agentSessions.get(sessionKey) : null
  const eventWorkspaceId = workspaceId || (entry && entry.workspaceId)
  const payload = Object.assign({
    taskId: taskId || 'default',
    sessionKey: sessionKey
  }, data)
  if (eventWorkspaceId) payload.workspaceId = eventWorkspaceId
  agentSenders.forEach(function (sender) {
    /* remove dead senders instead of just skipping them - the 'destroyed'
    listener may not have run yet when a window closes mid-stream */
    if (sender.isDestroyed()) {
      agentSenders.delete(sender)
      return
    }
    try {
      sender.send('agent-event', payload)
    } catch (e) {
      agentSenders.delete(sender)
    }
  })
}

/* Coalesce identical setup requests and serialize same-context reads, while
 * letting context switches and explicit opens/resets invalidate older work. */
function ensureSession (taskId, cwd, options, toolWorkspaceId) {
  const sessionKey = getSessionKey(taskId, cwd)
  const prefs = prefsFor(sessionKey)
  const provider = prefs.provider || getAgentSetting('agentProvider') || 'openrouter'
  const modelId = prefs.modelId || getAgentSetting('agentModel') || 'anthropic/claude-3.5-sonnet'
  const contextSignature = JSON.stringify({
    taskId: getClientTaskId(taskId),
    cwd: getEffectiveCwd(cwd),
    workspaceId: toolWorkspaceId || null,
    provider: provider,
    modelId: modelId,
    runtimeRevision: agentRuntimeRevision,
    configRevision: agentConfigRevision
  })
  const requestOptions = options || {}
  const operationSignature = JSON.stringify({
    mode: requestOptions.createNew ? 'createNew' : (requestOptions.openPath ? 'openPath' : (requestOptions.restoreRecent ? 'restoreRecent' : 'ensure')),
    openPath: requestOptions.openPath || null
  })
  const supersede = !!(requestOptions.createNew || requestOptions.openPath)
  return agentSessionLifecycle.run(sessionKey, contextSignature, operationSignature, function (lifecycle) {
    return ensureSessionInternal(taskId, cwd, requestOptions, toolWorkspaceId, lifecycle)
  }, { supersede: supersede })
}

async function ensureSessionInternal (taskId, cwd, options, toolWorkspaceId, lifecycle) {
  options = options || {}
  const sessionKey = getSessionKey(taskId, cwd)
  const clientTaskId = getClientTaskId(taskId)
  const effectiveCwd = getEffectiveCwd(cwd)
  const sessionDir = getWorkspaceSessionDir(toolWorkspaceId, cwd)
  const prefs = prefsFor(sessionKey)
  const modelId = prefs.modelId || getAgentSetting('agentModel') || 'anthropic/claude-3.5-sonnet'
  let provider = prefs.provider || getAgentSetting('agentProvider') || 'openrouter'
  const apiKey = getProviderApiKey(provider)

  const existing = agentSessions.get(sessionKey)
  const livePath = getLiveSessionFile(existing)
  const sameConfig = !!(existing && existing.apiKey === apiKey && existing.modelId === modelId && existing.provider === provider && existing.cwd === effectiveCwd && existing.workspaceId === (toolWorkspaceId || null) && ((existing.runtimeRevision === agentRuntimeRevision && existing.configRevision === agentConfigRevision) || existing.session.isStreaming))
  if (
    !options.createNew &&
    sameConfig &&
    (!options.openPath || options.openPath === livePath)
  ) {
    return existing
  }

  const sdk = await loadPiSdk()
  if (!lifecycle.isCurrent()) return null
  const resolved = await resolveSessionFile(sdk, effectiveCwd, sessionDir, options, prefs, existing)
  if (!lifecycle.isCurrent()) return null
  if (resolved.invalid) return null
  if (resolved.none) return null

  const customTools = await loadMinCustomTools(sdk, cwd, clientTaskId, toolWorkspaceId)
  if (!lifecycle.isCurrent()) return null
  const agentDir = getAgentDataDir()
  const settingsManager = sdk.SettingsManager.create(effectiveCwd, agentDir)
  const resourceLoader = await createAgentResourceLoader(sdk, cwd, settingsManager)
  if (!lifecycle.isCurrent()) return null

  const runtimeRevision = agentRuntimeRevision
  const modelRuntime = await createAgentModelRuntime()
  if (!lifecycle.isCurrent()) {
    try { if (modelRuntime && typeof modelRuntime.dispose === 'function') modelRuntime.dispose() } catch (e) {}
    return null
  }

  let model = null
  const resolvedProvider = provider
  const resolvedId = modelId
  if (resolvedId) {
    try { model = modelRuntime.getModel(resolvedProvider, resolvedId) } catch (e) {}
  }
  provider = resolvedProvider

  await disposeSessionEntry(sessionKey)
  if (!lifecycle.isCurrent()) {
    try { if (modelRuntime && typeof modelRuntime.dispose === 'function') modelRuntime.dispose() } catch (e) {}
    return null
  }

  let sessionManager
  try {
    if (resolved.path) {
      sessionManager = sdk.SessionManager.open(resolved.path, sessionDir || undefined, effectiveCwd)
    } else {
      sessionManager = sdk.SessionManager.create(effectiveCwd, sessionDir || undefined)
    }
  } catch (err) {
    sessionManager = sdk.SessionManager.create(effectiveCwd, sessionDir || undefined)
  }

  const createOptions = {
    cwd: effectiveCwd,
    agentDir: agentDir,
    tools: AGENT_BUILTIN_TOOLS.concat(minAgentTools.names(customTools)),
    customTools: customTools,
    settingsManager: settingsManager,
    resourceLoader: resourceLoader,
    sessionManager: sessionManager,
    modelRuntime: modelRuntime
  }
  if (model) createOptions.model = model

  let created
  try {
    created = await sdk.createAgentSession(createOptions)
  } catch (err) {
    try { if (modelRuntime && typeof modelRuntime.dispose === 'function') modelRuntime.dispose() } catch (e) {}
    throw err
  }
  const session = created && created.session
  if (!lifecycle.isCurrent()) {
    try { if (session) session.dispose() } catch (e) {}
    try { if (modelRuntime && typeof modelRuntime.dispose === 'function') modelRuntime.dispose() } catch (e) {}
    return null
  }
  if (!session) {
    try { if (modelRuntime && typeof modelRuntime.dispose === 'function') modelRuntime.dispose() } catch (e) {}
    throw new Error('pi SDK did not create an agent session')
  }

  const entry = {
    sessionKey: sessionKey,
    taskId: clientTaskId,
    workspaceId: toolWorkspaceId || null,
    cwd: effectiveCwd,
    apiKey: apiKey,
    modelId: modelId,
    provider: provider,
    session: session,
    modelRuntime: modelRuntime,
    resolvedModel: model ? (model.provider + '/' + model.id) : null,
    runtimeRevision: runtimeRevision,
    configRevision: agentConfigRevision,
    unsubscribe: session.subscribe(function (event) {
      if (event.type === 'compaction_start') {
        broadcastAgentEvent({ type: 'compaction_start' }, sessionKey, clientTaskId, toolWorkspaceId)
        return
      }
      if (event.type === 'compaction_end') {
        broadcastContext(sessionKey)
        broadcastAgentEvent({
          type: 'compaction_end',
          aborted: !!event.aborted,
          errorMessage: event.errorMessage || null,
          messages: serializeMessages(session)
        }, sessionKey, clientTaskId, toolWorkspaceId)
        return
      }
      const serialized = serializeAgentEvent(event)
      if (serialized) broadcastAgentEvent(serialized, sessionKey, clientTaskId, toolWorkspaceId)
      if (event.type === 'tool_execution_end' || event.type === 'agent_end') {
        broadcastContext(sessionKey)
      }
    })
  }
  agentSessions.set(sessionKey, entry)

  prefs.sessionPath = getLiveSessionFile(entry)
  prefs.skipRestore = false
  setSessionPrefs(sessionKey, prefs)

  try {
    const persistedThinking = prefs.thinkingLevel || settings.get('agentThinkingLevel')
    if (persistedThinking) session.setThinkingLevel(persistedThinking)
  } catch (e) {}

  broadcastContext(sessionKey)
  return entry
}

function snapshotState (taskId, cwd, workspaceId) {
  const sessionKey = getSessionKey(taskId, cwd)
  const entry = agentSessions.get(sessionKey)
  const prefs = prefsFor(sessionKey)
  let thinkingLevel = prefs.thinkingLevel || settings.get('agentThinkingLevel') || null
  let availableThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  let context = null
  if (entry && entry.session) {
    try {
      thinkingLevel = entry.session.getThinkingLevel()
      availableThinkingLevels = entry.session.getAvailableThinkingLevels() || availableThinkingLevels
    } catch (err) {}
    try {
      const stats = entry.session.getSessionStats()
      if (stats && stats.contextUsage) context = stats.contextUsage
    } catch (err) {}
  }
  return {
    ok: true,
    streaming: !!(entry && entry.session && entry.session.isStreaming),
    model: entry ? entry.resolvedModel : null,
    modelId: prefs.modelId || getAgentSetting('agentModel') || 'anthropic/claude-3.5-sonnet',
    provider: prefs.provider || getAgentSetting('agentProvider') || 'openrouter',
    hasApiKey: Object.keys(getAllProviderKeys()).length > 0,
    taskId: taskId,
    workspaceId: workspaceId || 'default',
    cwd: cwd,
    sessionPath: getLiveSessionFile(entry) || prefs.sessionPath || null,
    messages: entry ? serializeMessages(entry.session) : [],
    thinkingLevel: thinkingLevel,
    availableThinkingLevels: availableThinkingLevels,
    context: context,
    compacting: !!(entry && entry.session && entry.session.isCompacting)
  }
}

/* reads the live session's context usage and forwards it to the sidebar */
function broadcastContext (sessionKey) {
  const entry = sessionKey != null ? agentSessions.get(sessionKey) : null
  if (!entry || !entry.session) return
  try {
    const stats = entry.session.getSessionStats()
    const usage = stats && stats.contextUsage
    if (usage) {
      broadcastAgentEvent({
        type: 'context',
        percent: usage.percent,
        tokens: usage.tokens,
        contextWindow: usage.contextWindow
      }, sessionKey, entry.taskId)
    }
  } catch (e) {}
}

/* ----- IPC surface ----- */

ipc.on('agent-prompt', function (e, data) {
  registerSender(e.sender)
  if (!data || typeof data.text !== 'string' || !data.text.trim()) return
  const taskId = data.taskId
  const cwd = data.cwd
  const sessionKey = getSessionKey(taskId, cwd)
  const clientTaskId = getClientTaskId(taskId)
  ensureSession(taskId, cwd, undefined, data && data.workspaceId).then(function (state) {
    if (!state || !state.session) return
    const options = state.session.isStreaming ? { streamingBehavior: 'steer' } : undefined
    return state.session.prompt(data.text, options).then(function () {
      const errorMessage = state.session.agent.state.errorMessage
      if (errorMessage) {
        broadcastAgentEvent({ type: 'error', message: errorMessage }, sessionKey, clientTaskId, data && data.workspaceId)
      }
    })
  }).catch(function (err) {
    broadcastAgentEvent({ type: 'error', message: (err && err.message) || String(err) }, sessionKey, clientTaskId, data && data.workspaceId)
  })
})

ipc.on('agent-abort', function (e, data) {
  const sessionKey = getSessionKey(data && data.taskId, data && data.cwd)
  const entry = agentSessions.get(sessionKey)
  if (entry && entry.session) {
    entry.session.abort().catch(function () {})
  }
})

ipc.handle('agent-compact', async function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  try {
    const entry = await ensureSession(taskId, cwd, { restoreRecent: true }, data && data.workspaceId)
    if (!entry || !entry.session) {
      return { ok: false, message: 'No chat to compact.' }
    }
    if (entry.session.isCompacting) {
      return snapshotState(taskId, cwd, data && data.workspaceId)
    }
    await entry.session.compact(data && data.instructions ? String(data.instructions) : undefined)
    broadcastContext(getSessionKey(taskId, cwd))
    return snapshotState(taskId, cwd, data && data.workspaceId)
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
})

ipc.handle('agent-set-name', async function (e, data) {
  registerSender(e.sender)
  const name = data && data.name ? String(data.name).trim() : ''
  if (!name) return { ok: false, message: 'Usage: /name <title>' }
  try {
    const entry = await ensureSession(data && data.taskId, data && data.cwd, { restoreRecent: true }, data && data.workspaceId)
    if (!entry || !entry.session) return { ok: false, message: 'No chat to name.' }
    entry.session.setSessionName(name)
    return { ok: true, name: name }
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
})

ipc.on('agent-new-session', function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  const sessionKey = getSessionKey(taskId, cwd)
  const clientTaskId = getClientTaskId(taskId)
  const prefs = prefsFor(sessionKey)
  prefs.sessionPath = null
  prefs.skipRestore = true
  setSessionPrefs(sessionKey, prefs)
  destroySession(sessionKey).then(function () {
    broadcastAgentEvent({ type: 'session_reset' }, sessionKey, clientTaskId, data && data.workspaceId)
    broadcastAgentEvent({ type: 'context_cleared' }, sessionKey, clientTaskId, data && data.workspaceId)
  })
})

ipc.on('agent-set-model', function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  const sessionKey = getSessionKey(taskId, cwd)
  const modelId = data && data.modelId
  const provider = (data && data.provider) || 'openrouter'
  const prefs = prefsFor(sessionKey)
  prefs.modelId = modelId || null
  prefs.provider = modelId ? provider : null
  setSessionPrefs(sessionKey, prefs)
  const existing = agentSessions.get(sessionKey)
  if (!existing) return
  ensureSession(taskId, cwd, undefined, data && data.workspaceId).catch(function () {})
})

ipc.on('agent-set-thinking', function (e, data) {
  registerSender(e.sender)
  const level = data && data.level
  if (!level) return
  const sessionKey = getSessionKey(data && data.taskId, data && data.cwd)
  const clientTaskId = getClientTaskId(data && data.taskId)
  const prefs = prefsFor(sessionKey)
  prefs.thinkingLevel = level
  setSessionPrefs(sessionKey, prefs)
  const entry = agentSessions.get(sessionKey)
  if (entry && entry.session) {
    try {
      entry.session.setThinkingLevel(level)
    } catch (err) {}
  }
  broadcastAgentEvent({ type: 'thinking_changed', level: level }, sessionKey, clientTaskId, data && data.workspaceId)
})

/* settings-page helpers: verify an OpenRouter key against the account
endpoint and fetch the public model catalog for the model picker */
ipc.handle('agent-test-key', async function (e, data) {
  /* accepts {provider, key}; a bare string is treated as an OpenRouter key
  for backwards compatibility */
  const provider = (data && data.provider) || 'openrouter'
  const key = (data && data.key) || (typeof data === 'string' ? data : null)
  if (!key || typeof key !== 'string') {
    return { ok: false, message: 'No API key set.' }
  }
  if (provider === 'openrouter') {
    try {
      const resp = await net.fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: 'Bearer ' + key }
      })
      if (resp.ok) {
        return { ok: true, message: 'Key valid.' }
      }
      let detail = ''
      try {
        const body = await resp.json()
        detail = body && body.error && body.error.message ? ' ' + body.error.message : ''
      } catch (err) {}
      return { ok: false, message: 'HTTP ' + resp.status + '.' + detail }
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) }
    }
  }
  /* generic check for the other providers: install the key on a throwaway
  runtime and see whether the SDK accepts it (models become available) */
  try {
    const modelRuntime = await createAgentModelRuntime()
    await modelRuntime.setRuntimeApiKey(provider, key)
    const models = await modelRuntime.getAvailable(provider)
    if (models && models.length) {
      return { ok: true, message: 'Key valid.' }
    }
    return { ok: false, message: 'Key rejected or no models for this provider.' }
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
})

/* the providers the runtime actually knows - builtin SDK providers plus the
registered omp replicas - probed live so the Pro Settings "add provider"
picker tracks the SDK version and the replica list */
ipc.handle('agent-list-providers', async function () {
  try {
    const modelRuntime = await createAgentModelRuntime()
    const stored = readAgentAuthFile()
    return modelRuntime.getProviders()
      .map(function (p) {
        const credential = stored[p.id]
        return {
          id: p.id,
          label: PROVIDER_LABELS[p.id] || agentOAuth.replicaLabels[p.id] || p.name || p.id,
          models: p.getModels().length,
          apiKey: !!(p.auth && p.auth.apiKey),
          oauth: !!(p.auth && p.auth.oauth),
          authType: credential ? credential.type : null,
          replica: agentOAuth.replicaIds.indexOf(p.id) !== -1,
          disabled: isProviderDisabled(p.id)
        }
      })
      .sort(function (a, b) { return a.label.localeCompare(b.label) })
  } catch (err) {
    return []
  }
})

/* ------------------------------------------------------------------ */
/* OAuth provider login (builtin SDK flows + omp replicas)              */
/* ------------------------------------------------------------------ */

const oauthPendingFlows = new Map() // providerId -> AbortController
const oauthPendingPrompts = new Map() // requestId -> {resolve, reject, sender}
let oauthPromptSeq = 0

ipc.on('agent-auth-respond', function (e, data) {
  const pending = oauthPendingPrompts.get(data && data.requestId)
  if (!pending) return
  oauthPendingPrompts.delete(data.requestId)
  if (data && data.cancelled) {
    pending.reject(new Error('Login cancelled'))
  } else {
    pending.resolve(data && data.value !== undefined ? data.value : '')
  }
})

/* renderer push: events + prompt requests go to the webContents that started
the login (the settings webview relays them to its page via postMessage) */
function oauthSendToSender (sender, payload) {
  try {
    if (sender && !sender.isDestroyed()) sender.send('agent-auth-event', payload)
  } catch (err) {}
}

ipc.handle('agent-provider-login', async function (e, data) {
  const providerId = data && data.provider
  if (!providerId) return { ok: false, message: 'No provider specified.' }
  if (oauthPendingFlows.has(providerId)) {
    return { ok: false, message: 'A sign-in is already running for this provider.' }
  }
  let modelRuntime
  try {
    modelRuntime = await createAgentModelRuntime()
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
  const provider = modelRuntime.getProvider(providerId)
  if (!provider) return { ok: false, message: 'Unknown provider: ' + providerId }

  const abort = new AbortController()
  oauthPendingFlows.set(providerId, abort)
  const sender = e.sender
  const sendEvent = function (payload) {
    oauthSendToSender(sender, Object.assign({ provider: providerId }, payload))
  }

  const interaction = {
    signal: abort.signal,
    notify: function (event) {
      /* auth_url events open the provider's sign-in page in a Min tab so the
      whole flow stays inside the browser the user is already in */
      if (event && event.type === 'auth_url' && event.url) {
        agentOAuth.openAuthUrl(event.url)
      }
      sendEvent({ type: 'event', event: event })
    },
    prompt: function (prompt) {
      return new Promise(function (resolve, reject) {
        const requestId = 'auth-' + (++oauthPromptSeq)
        oauthPendingPrompts.set(requestId, { resolve: resolve, reject: reject, sender: sender })
        abort.signal.addEventListener('abort', function () {
          if (oauthPendingPrompts.delete(requestId)) reject(new Error('Login cancelled'))
        }, { once: true })
        sendEvent({ type: 'prompt', requestId: requestId, prompt: prompt })
      })
    }
  }

  try {
    await modelRuntime.login(providerId, 'oauth', interaction)
    sendEvent({ type: 'done' })
    /* auth.json changed - a provider that just signed in may expose new
    models, so the cached catalog is stale now */
    invalidateModelCatalog()
    /* credential stays in the main process (auth.json) - only the outcome
    crosses IPC, never tokens */
    return { ok: true }
  } catch (err) {
    const message = (err && err.message) || String(err)
    sendEvent({ type: 'error', message: message })
    return { ok: false, message: message }
  } finally {
    oauthPendingFlows.delete(providerId)
    for (const [requestId, pending] of oauthPendingPrompts) {
      if (pending.sender === sender) {
        oauthPendingPrompts.delete(requestId)
        pending.reject(new Error('Login flow ended'))
      }
    }
  }
})

ipc.on('agent-provider-login-cancel', function (e, data) {
  const providerId = data && data.provider
  const flow = oauthPendingFlows.get(providerId)
  if (flow) {
    oauthPendingFlows.delete(providerId)
    flow.abort()
  }
})

ipc.handle('agent-provider-logout', async function (e, data) {
  const providerId = data && data.provider
  if (!providerId) return { ok: false, message: 'No provider specified.' }
  try {
    const modelRuntime = await createAgentModelRuntime()
    await modelRuntime.logout(providerId)
    invalidateModelCatalog()
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
})

/* Pro Settings "Tools" tab: everything a session can use. Builtin tool
descriptions are probed from the SDK's own tool factories so they track the
installed version; skills use the same explicit Min/workspace sources as
sessions (<userData>/pi-agent/skills plus <cwd>/.pi/skills). */
ipc.handle('agent-list-tools', async function (e, data) {
  const effectiveCwd = getEffectiveCwd(data && data.cwd)
  const result = {
    ok: true,
    cwd: effectiveCwd,
    builtin: [],
    custom: [],
    skills: [],
    skillDirs: {}
  }
  let sdk = null
  try {
    sdk = await loadPiSdk()
  } catch (err) {
    result.ok = false
    result.message = (err && err.message) || String(err)
    return result
  }

  AGENT_BUILTIN_TOOLS.forEach(function (name) {
    let description = ''
    try {
      const factory = sdk[AGENT_BUILTIN_TOOL_FACTORIES[name]]
      const tool = factory && factory(effectiveCwd)
      description = (tool && tool.description) || ''
    } catch (err) {}
    result.builtin.push({ name: name, description: description })
  })

  try {
    const customTools = await loadMinCustomTools(sdk, data && data.cwd, null, null)
    const actionMap = minAgentTools.actions || {}
    result.custom = customTools.map(function (tool) {
      return {
        name: tool.name,
        label: tool.label || tool.name,
        description: tool.description || '',
        actions: actionMap[tool.name] || []
      }
    })

    result.skillDirs = getAgentSkillDirs(data && data.cwd)
    const loaded = loadAgentSkills(sdk, data && data.cwd)
    result.skills = (loaded.skills || []).map(function (skill) {
      return {
        name: skill.name,
        description: skill.description || '',
        path: skill.filePath,
        scope: (skill.sourceInfo && skill.sourceInfo.scope) || null,
        disabled: !!skill.disableModelInvocation
      }
    })
  } catch (err) {
    result.ok = false
    result.message = (err && err.message) || String(err)
  }

  return result
})

function fetchAgentModels (force) {
  if (!force && modelCatalogCache && Date.now() - modelCatalogAt < 15 * 60 * 1000) {
    return Promise.resolve({ models: modelCatalogCache, warnings: [] })
  }
  if (modelCatalogLoading) {
    if ((force && !modelCatalogLoading.force) || modelCatalogLoading.revision !== modelCatalogRevision) {
      return modelCatalogLoading.promise.catch(function () {}).then(function () { return fetchAgentModels(force) })
    }
    return modelCatalogLoading.promise
  }
  const revision = modelCatalogRevision
  const loading = { force: force, revision: revision, promise: null }
  loading.promise = (async function () {
    /* createAgentModelRuntime also installs the stored keys and registers
    the omp replicas so getAvailable() sees every configured provider */
    const modelRuntime = await createAgentModelRuntime({ force: !!force })
    /* the no-argument getAvailable() resolves every provider in one
    Promise.all - a single provider that throws (an expired oauth credential
    whose refresh endpoint is unreachable, a broken custom wire) would empty
    the whole catalog, so probe providers independently and keep the ones
    that answer */
    const providers = modelRuntime.getProviders() || []
    const settled = await Promise.allSettled(providers.map(function (p) {
      return modelRuntime.getAvailable(p.id)
    }))
    const available = []
    const warnings = []
    const retained = []
    const refresh = modelRuntime.minCatalogRefresh || {}
    const failedProviders = new Set(refresh.errors ? Array.from(refresh.errors.keys()) : [])
    if (refresh.aborted) warnings.push('Network timeout')
    settled.forEach(function (entry, index) {
      if (entry.status === 'fulfilled' && entry.value) {
        available.push.apply(available, entry.value)
      }
      const provider = providers[index].id
      if (entry.status === 'rejected' || failedProviders.has(provider)) {
        warnings.push(PROVIDER_LABELS[provider] || agentOAuth.replicaLabels[provider] || provider)
        retained.push.apply(retained, (modelCatalogCache || []).filter(function (model) { return model.provider === provider && !isProviderDisabled(provider) }))
      }
    })
    /* api-key providers drop out of getAvailable() on their own when disabled
    (no key installed); OAuth credentials live in auth.json so disabled
    providers are filtered here instead */
    const models = available
      .filter(function (m) { return !isProviderDisabled(m.provider) })
      .map(function (m) {
        return {
          id: m.id,
          name: m.name || m.id,
          provider: m.provider,
          providerLabel: PROVIDER_LABELS[m.provider] || agentOAuth.replicaLabels[m.provider] || m.provider,
          contextWindow: m.contextWindow || null
        }
      })
    const discovered = new Set(models.map(function (m) { return m.provider + '/' + m.id }))
    models.push.apply(models, retained.filter(function (m) { return !discovered.has(m.provider + '/' + m.id) }))
    models.sort(function (a, b) { return (a.provider + '/' + a.id).localeCompare(b.provider + '/' + b.id) })
    if (revision === modelCatalogRevision) {
      modelCatalogCache = models
      modelCatalogAt = warnings.length ? 0 : Date.now()
      return { models: models, warnings: warnings }
    }
    /* A credential/provider change landed while this catalog was in flight.
    Do not let the older discovery replace the cache; queued callers will
    retry against the new revision after this request settles. */
    return { models: modelCatalogCache || models, warnings: warnings }
  })().finally(function () { if (modelCatalogLoading === loading) modelCatalogLoading = null })
  modelCatalogLoading = loading
  return loading.promise
}

ipc.handle('agent-fetch-models', async function (e) {
  registerSender(e.sender)
  try { return (await fetchAgentModels(false)).models } catch (err) { return modelCatalogCache || [] }
})

ipc.handle('agent-refresh-models', async function (e) {
  registerSender(e.sender)
  try {
    const result = await fetchAgentModels(true)
    broadcastAgentEvent({ type: 'models_changed' })
    return Object.assign({ ok: true }, result)
  } catch (err) {
    return { ok: false, models: modelCatalogCache || [], message: err.message || String(err) }
  }
})

/* a changed provider key means a different catalog - refetch on demand */
settings.listen('openrouterApiKey', function () {
  agentConfigRevision++
  invalidateModelCatalog()
})

ipc.handle('agent-get-state', async function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  if (data && data.restore) {
    try {
      await ensureSession(taskId, cwd, { restoreRecent: true }, data && data.workspaceId)
    } catch (err) {}
  }
  return snapshotState(taskId, cwd, data && data.workspaceId)
})

ipc.handle('agent-list-sessions', async function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  const query = (data && data.query) ? String(data.query).trim().toLowerCase() : ''
  try {
    const sdk = await loadPiSdk()
    const listed = await listTaskSessions(
      sdk,
      getEffectiveCwd(cwd),
      getWorkspaceSessionDir(data && data.workspaceId, cwd)
    )
    let items = listed || []
    if (query) {
      items = items.filter(function (info) {
        const name = (info.name || '').toLowerCase()
        const first = (info.firstMessage || '').toLowerCase()
        const all = (info.allMessagesText || '').toLowerCase()
        return name.indexOf(query) !== -1 || first.indexOf(query) !== -1 || all.indexOf(query) !== -1
      })
    }
    items.sort(function (a, b) {
      return (+new Date(b.modified)) - (+new Date(a.modified))
    })
    const snap = snapshotState(taskId, cwd, data && data.workspaceId)
    return {
      ok: true,
      currentPath: snap.sessionPath,
      sessions: items.map(serializeSessionInfo)
    }
  } catch (err) {
    return { ok: false, sessions: [], currentPath: null, message: (err && err.message) || String(err) }
  }
})

ipc.handle('agent-open-session', async function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  const sessionPath = data && data.path
  if (!isAllowedSessionPath(sessionPath) || !fs.existsSync(sessionPath)) {
    return { ok: false, message: 'Session not found.' }
  }
  try {
    const entry = await ensureSession(taskId, cwd, { openPath: sessionPath }, data && data.workspaceId)
    if (!entry) return { ok: false, message: 'Could not open session.' }
    return snapshotState(taskId, cwd, data && data.workspaceId)
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
})

/* Stops the live agent session for one task (task close/archive). History
files on disk are kept; only the running session is disposed. */
ipc.on('agent-destroy-task-session', function (e, data) {
  try {
    const taskId = data && data.taskId
    const cwd = data && data.cwd
    destroySession(getSessionKey(taskId, cwd || null))
  } catch (err) {}
})

/* Deletes a workspace's transcripts from disk. Used when a workspace is
 * removed: the sessions can never be listed again once it is gone, so leaving
 * the files behind would only orphan them. Strictly confined to the sessions
 * root, like every other path this module writes to. */
function deleteWorkspaceSessionFiles (workspaceId) {
  const dir = getWorkspaceSessionDir(workspaceId, null)
  const sessionsRoot = getSessionsRoot()
  if (!dir || !sessionsRoot) return

  const pathMod = require('path')
  const resolved = pathMod.resolve(dir)
  const root = pathMod.resolve(sessionsRoot)
  const prefix = root.endsWith(pathMod.sep) ? root : root + pathMod.sep
  if (!resolved.startsWith(prefix)) return

  try {
    fs.rmSync(resolved, { recursive: true, force: true })
  } catch (err) {
    console.warn('failed to delete agent sessions for workspace', workspaceId, err)
  }
}

/* Workspace close: stops the running sessions of the given tasks and deletes
 * the workspace's transcript directory. Task deletion alone only stops the
 * live session - its file stays and becomes available to other tasks. */
ipc.on('agent-destroy-workspace-sessions', function (e, data) {
  try {
    const taskIds = (data && data.taskIds) || []
    const pending = taskIds.map(function (taskId) {
      const sessionKey = getSessionKey(taskId, null)
      return destroySession(sessionKey).then(function () {
        // the task is gone, so its saved pointer is dead weight
        forgetSessionPrefs(sessionKey)
      })
    })
    Promise.all(pending).then(function () {
      deleteWorkspaceSessionFiles(data && data.workspaceId)
    }).catch(function () {})
  } catch (err) {}
})

ipc.handle('agent-delete-session', async function (e, data) {
  registerSender(e.sender)
  const taskId = data && data.taskId
  const cwd = data && data.cwd
  const sessionPath = data && data.path
  if (!isAllowedSessionPath(sessionPath)) {
    return { ok: false, message: 'Session not found.' }
  }
  const sessionKey = getSessionKey(taskId, cwd)
  const snap = snapshotState(taskId, cwd, data && data.workspaceId)
  const pathMod = require('path')
  const deletingCurrent = !!(snap.sessionPath && pathMod.resolve(snap.sessionPath) === pathMod.resolve(sessionPath))
  if (deletingCurrent) {
    const prefs = prefsFor(sessionKey)
    prefs.sessionPath = null
    prefs.skipRestore = true
    setSessionPrefs(sessionKey, prefs)
    await destroySession(sessionKey)
  }
  try {
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath)
  } catch (err) {
    return { ok: false, message: (err && err.message) || String(err) }
  }
  return {
    ok: true,
    deletedCurrent: deletingCurrent,
    state: snapshotState(taskId, cwd, data && data.workspaceId)
  }
})
