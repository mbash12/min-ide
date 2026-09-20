/* global fs, ipc, net, settings, minAgentTools */
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
/* one session per task, keyed by task id, so switching tasks keeps each
task's own conversation and context. */
const agentSessions = new Map() // sessionKey -> { sessionKey, taskId, cwd, apiKey, modelId, provider, session, unsubscribe, modelRuntime, resolvedModel }
const prefsByCwd = new Map() // sessionKey -> { modelId, provider, thinkingLevel }
const sessionInitPromises = new Map() // sessionKey -> { signature, promise }

/* The pi SDK is the execution engine and we use it fully (its model catalog,
sessions, etc.). To keep Min a distinct product from the pi CLI that may be
installed on this machine, the SDK's data dirs (sessions, logs, package cache,
model catalogs) are redirected to Min's own userData via env vars inside
loadPiSdk() — so Min never merges its data with the laptop's ~/.pi. */
const PROVIDER_LABELS = {
  openrouter: 'OpenRouter'
}
const agentSenders = new Set() // webContents that should receive agent events

function loadPiSdk () {
  if (!sdkPromise) {
    /* Keep Min's data separate from any pi CLI installed on this machine. The
    SDK honours these env vars (see @earendil-works/pi-coding-agent/dist/config.js)
    for where it stores sessions, logs and cached packages. Pointing them at
    Min's own userData makes Min a self-contained app that never reads or writes
    the laptop's ~/.pi. */
    try {
      const electronApp = require('electron').app
      const userData = electronApp.getPath('userData')
      const agentDataDir = require('path').join(userData, 'pi-agent')
      process.env.PI_CODING_AGENT_DIR = agentDataDir
      process.env.PI_CODING_AGENT_SESSION_DIR = require('path').join(agentDataDir, 'sessions')
      process.env.PI_PACKAGE_DIR = require('path').join(agentDataDir, 'packages')
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
    const typeboxFile = require('path').join(
      __dirname,
      'node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs'
    )
    typeboxPromise = import(pathToFileURL(typeboxFile).href).then(function (mod) {
      const Type = (mod && mod.Type) || (mod && mod.default)
      if (!Type) throw new Error('typebox did not load correctly')
      return Type
    })
  }
  return typeboxPromise
}

function registerSender (sender) {
  if (!sender || sender.isDestroyed()) return
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

function toolDetailFromInput (input) {
  if (!input) return ''
  if (typeof input === 'string') return input.slice(0, 140)
  if (input.action) {
    const extra = input.url || input.selector || input.ref || input.targetSelector || input.targetRef || input.operation || input.text || ''
    return extra ? (String(input.action) + ' ' + String(extra).slice(0, 100)) : String(input.action)
  }
  if (input.command) return String(input.command)
  if (input.path) return String(input.path)
  if (input.file_path) return String(input.file_path)
  if (input.filePath) return String(input.filePath)
  if (input.pattern) return String(input.pattern)
  if (input.url) return String(input.url)
  if (input.selector) return String(input.selector)
  if (input.ref) return String(input.ref)
  if (input.name && input.operation) return String(input.operation) + ' ' + String(input.name)
  if (input.operation) return String(input.operation)
  if (input.name) return String(input.name)
  if (input.text) return String(input.text).slice(0, 140)
  try {
    return JSON.stringify(input).slice(0, 140)
  } catch (e) {
    return ''
  }
}

function serializeToolEventDetail (event) {
  return toolDetailFromInput(event.args || event.input || event.toolInput || event.params)
}

/* converts an SDK session event into the small plain-JSON shape the sidebar
chat UI understands; returns null for events the UI doesn't display */
function serializeAgentEvent (event) {
  switch (event.type) {
    case 'message_update': {
      const ev = event.assistantMessageEvent
      if (!ev) return null
      if (ev.type === 'text_delta') {
        return { type: 'delta', deltaType: 'text', delta: ev.delta }
      }
      if (ev.type === 'thinking_delta') {
        return { type: 'delta', deltaType: 'thinking', delta: ev.delta }
      }
      return null
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolName: event.toolName,
        detail: serializeToolEventDetail(event)
      }
    case 'tool_execution_end':
      return { type: 'tool_end', toolName: event.toolName, isError: !!event.isError }
    case 'agent_start':
      return { type: 'agent_start' }
    case 'agent_end':
      return { type: 'agent_end' }
    case 'auto_retry_start':
      return { type: 'status', message: 'Retrying…' }
    default:
      return null
  }
}

/* flattens the SDK session history into UI messages, including grouped tool calls */
function serializeMessages (session) {
  const messages = []
  try {
    (session.messages || []).forEach(function (message) {
      if (message.role === 'user') {
        let text = ''
        if (typeof message.content === 'string') {
          text = message.content
        } else if (Array.isArray(message.content)) {
          text = message.content.filter(function (block) { return block.type === 'text' })
            .map(function (block) { return block.text }).join('\n')
        }
        if (text) messages.push({ role: 'user', text: text })
        return
      }
      if (message.role === 'compactionSummary') {
        messages.push({ role: 'compact', text: message.summary || '' })
        return
      }
      if (message.role !== 'assistant') return
      const tools = []
      let text = ''
      if (typeof message.content === 'string') {
        text = message.content
      } else if (Array.isArray(message.content)) {
        message.content.forEach(function (block) {
          if (block.type === 'text' && block.text) {
            text += (text ? '\n' : '') + block.text
          }
          if (block.type === 'tool_use' || block.type === 'toolCall' || block.type === 'functionCall') {
            tools.push({
              name: block.name || block.toolName || 'tool',
              status: 'done',
              detail: toolDetailFromInput(block.input || block.args)
            })
          }
        })
      }
      if (tools.length) messages.push({ role: 'tools', items: tools, expanded: false })
      if (text) messages.push({ role: 'assistant', text: text })
    })
  } catch (e) {}
  return messages
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

  const prefsPath = getAgentPrefsPath()
  if (!prefsPath) return
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
    Object.keys(parsed || {}).forEach(function (sessionKey) {
      const entry = parsed[sessionKey]
      if (entry && typeof entry === 'object') {
        prefsByCwd.set(sessionKey, entry)
      }
    })
  } catch (err) {
    // no file yet, or unreadable: start with nothing remembered
  }
}

function saveAgentPrefs () {
  const prefsPath = getAgentPrefsPath()
  if (!prefsPath) return

  const stored = {}
  prefsByCwd.forEach(function (value, key) {
    stored[key] = value
  })
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

/* the remembered settings of a session, loading the file on first use so the
 * order modules load in does not matter */
function prefsFor (sessionKey) {
  loadAgentPrefs()
  return prefsByCwd.get(sessionKey) || {}
}

function setSessionPrefs (sessionKey, prefs) {
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

async function destroySession (sessionKey) {
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
  agentSessions.delete(sessionKey)
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

function broadcastAgentEvent (data, sessionKey, taskId) {
  const payload = Object.assign({
    taskId: taskId || 'default',
    sessionKey: sessionKey
  }, data)
  agentSenders.forEach(function (sender) {
    if (!sender.isDestroyed()) {
      sender.send('agent-event', payload)
    }
  })
}

/* Coalesce restores/opens for the same task. The SDK session is only
 * published after asynchronous setup completes, so without this guard two
 * rapid prompts or the compatibility selection events could both create and
 * replace AgentSession instances for one key. */
function ensureSession (taskId, cwd, options, toolWorkspaceId) {
  const sessionKey = getSessionKey(taskId, cwd)
  const pending = sessionInitPromises.get(sessionKey)
  const signature = JSON.stringify(options || {})
  if (pending) {
    if (pending.signature === signature) return pending.promise
    // A deliberate open/create request must not be swallowed by an earlier
    // automatic restore. Serialize the distinct operation and re-evaluate the
    // live session/config when the first initialization finishes.
    return pending.promise.then(function () {
      return ensureSession(taskId, cwd, options, toolWorkspaceId)
    })
  }

  const promise = ensureSessionInternal(taskId, cwd, options, toolWorkspaceId)
  const pendingEntry = { signature: signature, promise: promise }
  sessionInitPromises.set(sessionKey, pendingEntry)
  promise.then(function () {
    if (sessionInitPromises.get(sessionKey) === pendingEntry) {
      sessionInitPromises.delete(sessionKey)
    }
  }, function () {
    if (sessionInitPromises.get(sessionKey) === pendingEntry) {
      sessionInitPromises.delete(sessionKey)
    }
  })
  return promise
}

async function ensureSessionInternal (taskId, cwd, options, toolWorkspaceId) {
  options = options || {}
  const sessionKey = getSessionKey(taskId, cwd)
  const clientTaskId = getClientTaskId(taskId)
  const effectiveCwd = getEffectiveCwd(cwd)
  const sessionDir = getWorkspaceSessionDir(toolWorkspaceId, cwd)
  const prefs = prefsFor(sessionKey)
  const apiKey = settings.get('openrouterApiKey') || null
  const modelId = prefs.modelId || settings.get('agentModel') || 'anthropic/claude-3.5-sonnet'
  let provider = prefs.provider || settings.get('agentProvider') || 'openrouter'

  const existing = agentSessions.get(sessionKey)
  const livePath = getLiveSessionFile(existing)
  const sameConfig = !!(existing && existing.apiKey === apiKey && existing.modelId === modelId && existing.provider === provider && existing.cwd === effectiveCwd)
  if (
    !options.createNew &&
    sameConfig &&
    (!options.openPath || options.openPath === livePath)
  ) {
    return existing
  }

  const sdk = await loadPiSdk()
  const resolved = await resolveSessionFile(sdk, effectiveCwd, sessionDir, options, prefs, existing)
  if (resolved.invalid) return null
  if (resolved.none) return null

  await destroySession(sessionKey)

  const modelRuntime = await sdk.ModelRuntime.create()
  if (apiKey) {
    await modelRuntime.setRuntimeApiKey('openrouter', apiKey)
  }

  let model = null
  const resolvedProvider = provider
  const resolvedId = modelId
  if (resolvedId) {
    try { model = modelRuntime.getModel(resolvedProvider, resolvedId) } catch (e) {}
  }
  provider = resolvedProvider

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

  const builtinTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  let customTools = []
  try {
    const Type = await loadTypebox()
    customTools = minAgentTools.create(sdk.defineTool, Type, cwd || null, clientTaskId, toolWorkspaceId)
  } catch (err) {
    console.warn('Min agent custom tools failed to load', err)
  }

  const createOptions = {
    cwd: effectiveCwd,
    tools: builtinTools.concat(minAgentTools.names(customTools)),
    customTools: customTools,
    sessionManager: sessionManager,
    modelRuntime: modelRuntime
  }
  if (model) createOptions.model = model

  const { session } = await sdk.createAgentSession(createOptions)

  const entry = {
    sessionKey: sessionKey,
    taskId: clientTaskId,
    cwd: effectiveCwd,
    apiKey: apiKey,
    modelId: modelId,
    provider: provider,
    session: session,
    modelRuntime: modelRuntime,
    resolvedModel: model ? (model.provider + '/' + model.id) : null,
    unsubscribe: session.subscribe(function (event) {
      if (event.type === 'compaction_start') {
        broadcastAgentEvent({ type: 'compaction_start' }, sessionKey, clientTaskId)
        return
      }
      if (event.type === 'compaction_end') {
        broadcastContext(sessionKey)
        broadcastAgentEvent({
          type: 'compaction_end',
          aborted: !!event.aborted,
          errorMessage: event.errorMessage || null,
          messages: serializeMessages(session)
        }, sessionKey, clientTaskId)
        return
      }
      const serialized = serializeAgentEvent(event)
      if (serialized) broadcastAgentEvent(serialized, sessionKey, clientTaskId)
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

function snapshotState (taskId, cwd) {
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
    modelId: prefs.modelId || settings.get('agentModel') || 'anthropic/claude-3.5-sonnet',
    provider: prefs.provider || settings.get('agentProvider') || 'openrouter',
    hasApiKey: !!(settings.get('openrouterApiKey')),
    taskId: taskId,
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
    const options = state.session.isStreaming ? { streamingBehavior: 'steer' } : undefined
    return state.session.prompt(data.text, options).then(function () {
      const errorMessage = state.session.agent.state.errorMessage
      if (errorMessage) {
        broadcastAgentEvent({ type: 'error', message: errorMessage }, sessionKey, clientTaskId)
      }
    })
  }).catch(function (err) {
    broadcastAgentEvent({ type: 'error', message: (err && err.message) || String(err) }, sessionKey, clientTaskId)
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
      return snapshotState(taskId, cwd)
    }
    await entry.session.compact(data && data.instructions ? String(data.instructions) : undefined)
    broadcastContext(getSessionKey(taskId, cwd))
    return snapshotState(taskId, cwd)
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
    broadcastAgentEvent({ type: 'session_reset' }, sessionKey, clientTaskId)
    broadcastAgentEvent({ type: 'context_cleared' }, sessionKey, clientTaskId)
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
  broadcastAgentEvent({ type: 'thinking_changed', level: level }, sessionKey, clientTaskId)
})

/* settings-page helpers: verify an OpenRouter key against the account
endpoint and fetch the public model catalog for the model picker */
ipc.handle('agent-test-key', async function (e, key) {
  if (!key || typeof key !== 'string') {
    return { ok: false, message: 'No API key set.' }
  }
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
})

ipc.handle('agent-fetch-models', async function () {
  if (modelCatalogCache) {
    return modelCatalogCache
  }
  try {
    const sdk = await loadPiSdk()
    const modelRuntime = await sdk.ModelRuntime.create()
    /* runtime api keys are not persisted to auth.json - the key stored in
    Min's settings has to be installed on this runtime before asking for the
    catalog, otherwise getAvailable() reports no providers */
    const apiKey = settings.get('openrouterApiKey')
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey('openrouter', apiKey)
    }
    const available = (await modelRuntime.getAvailable()) || []
    const models = available
      .map(function (m) {
        return {
          id: m.id,
          name: m.name || m.id,
          provider: m.provider,
          providerLabel: PROVIDER_LABELS[m.provider] || m.provider,
          contextWindow: m.contextWindow || null
        }
      })
    models.sort(function (a, b) { return (a.provider + '/' + a.id).localeCompare(b.provider + '/' + a.id) })
    modelCatalogCache = models
  } catch (err) {
    modelCatalogCache = []
  }
  return modelCatalogCache
})

/* a changed provider key means a different catalog - refetch on demand */
settings.listen('openrouterApiKey', function () {
  modelCatalogCache = null
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
  return snapshotState(taskId, cwd)
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
    const snap = snapshotState(taskId, cwd)
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
    return snapshotState(taskId, cwd)
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
    taskIds.forEach(function (taskId) {
      const sessionKey = getSessionKey(taskId, null)
      destroySession(sessionKey)
      // the task is gone, so its saved pointer is dead weight
      forgetSessionPrefs(sessionKey)
    })
    deleteWorkspaceSessionFiles(data && data.workspaceId)
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
  const snap = snapshotState(taskId, cwd)
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
    state: snapshotState(taskId, cwd)
  }
})
