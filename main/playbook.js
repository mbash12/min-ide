/* global fs, path, ipc, isPathInside, windows, getWindowWebContents, minBrowser, app, browserCommandValidate */
/* Playbooks are JSON recipes of browser actions stored per workspace. With a
folder they live in .min/playbooks; without one they live in Min's userData
under playbooks/{workspaceId}. The sidebar can list and run them without the
model. */

var PLAYBOOK_DIRNAME = path.join('.min', 'playbooks')
var PLAYBOOK_ACTIONS = {
  find: true,
  fill: true,
  check: true,
  focus: true,
  diagnostics: true,
  read: true,
  viewport: true,
  inspect: true,
  compare: true,
  navigate: true,
  back: true,
  forward: true,
  reload: true,
  click: true,
  dblclick: true,
  rightclick: true,
  hover: true,
  drag: true,
  type: true,
  select: true,
  press: true,
  scroll: true,
  wait: true,
  snapshot: true,
  screenshot: true,
  tabs: true,
  assert: true,
  upload: true,
  download: true,
  dialog: true
}

function playbookSlug (name) {
  var slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) slug = 'playbook'
  return slug.slice(0, 80)
}

function playbookFileName (name) {
  return playbookSlug(name) + '.json'
}

function playbookSanitizeWorkspaceId (workspaceId) {
  var id = String(workspaceId || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!id || id === 'default') return null
  return id.slice(0, 80)
}

function playbookFolderRoot (cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  try {
    var resolved = path.resolve(cwd)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved
    }
  } catch (e) {}
  return null
}

function playbookUserDataDir (workspaceId) {
  var id = playbookSanitizeWorkspaceId(workspaceId)
  if (!id) return null
  return path.join(app.getPath('userData'), 'playbooks', id)
}

function playbookStorage (cwd, workspaceId) {
  var folder = playbookFolderRoot(cwd)
  if (folder) {
    return { root: folder, dir: path.join(folder, PLAYBOOK_DIRNAME) }
  }
  var fallback = playbookUserDataDir(workspaceId)
  if (fallback) {
    return { root: fallback, dir: fallback }
  }
  return null
}

function playbookPathFor (cwd, name, workspaceId) {
  const storage = playbookStorage(cwd, workspaceId)
  if (!storage) return null
  const file = path.join(storage.dir, playbookFileName(name))
  if (!isPathInside(storage.root, file)) return null
  return file
}

function ensurePlaybookDir (cwd, workspaceId) {
  const storage = playbookStorage(cwd, workspaceId)
  if (!storage) return { ok: false, error: 'No workspace' }
  fs.mkdirSync(storage.dir, { recursive: true })
  return { ok: true, dir: storage.dir, root: storage.root }
}

function playbookScope (cwd, workspaceId) {
  return {
    cwd: cwd || null,
    workspaceId: workspaceId ? String(workspaceId) : null
  }
}

function playbookObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function interpolatePlaybookValue (value, vars) {
  if (Array.isArray(value)) return value.map(function (item) { return interpolatePlaybookValue(item, vars) })
  if (playbookObject(value)) {
    const out = Object.create(null)
    Object.keys(value).forEach(function (key) { out[key] = interpolatePlaybookValue(value[key], vars) })
    return out
  }
  if (typeof value !== 'string') return value
  function lookup (key) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error('Missing playbook variable: ' + key)
    return vars[key]
  }
  const whole = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)
  if (whole) return lookup(whole[1])
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, function (_, key) { return String(lookup(key)) })
}

function validatePlaybook (input) {
  if (!playbookObject(input)) return { ok: false, error: 'Playbook must be an object' }
  const name = String(input.name || '').trim()
  if (!name) return { ok: false, error: 'Playbook name is required' }
  if (!Array.isArray(input.steps) || !input.steps.length) return { ok: false, error: 'Playbook needs at least one step' }
  const playbook = { name: playbookSlug(name), description: String(input.description || '').slice(0, 500), version: 2 }
  let total = 0
  for (const phase of ['setup', 'steps', 'teardown']) {
    const steps = input[phase] == null ? [] : input[phase]
    if (!Array.isArray(steps)) return { ok: false, error: phase + ' must be an array' }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (!playbookObject(step) || !Object.prototype.hasOwnProperty.call(PLAYBOOK_ACTIONS, step.action)) return { ok: false, error: phase + ' step ' + (i + 1) + ' has an invalid action' }
      const valid = browserCommandValidate(step, true)
      if (!valid.ok) return { ok: false, error: phase + ' step ' + (i + 1) + ': ' + valid.error, help: valid.help }
      if (step.ref || step.targetRef) return { ok: false, error: 'Saved playbooks need stable locators, not temporary refs (' + phase + ' ' + (i + 1) + ')' }
      if (step.workspaceId || step.taskId) return { ok: false, error: 'Steps inherit the running workspace and task' }
    }
    total += steps.length
    playbook[phase] = steps
  }
  if (total > 200) return { ok: false, error: 'Playbook has too many steps (max 200 across setup, steps, teardown)' }
  if (input.vars != null && !playbookObject(input.vars)) return { ok: false, error: 'vars must be an object' }
  playbook.vars = input.vars || {}
  playbook.repeat = input.repeat == null ? 1 : input.repeat
  if (!Number.isInteger(playbook.repeat) || playbook.repeat < 1 || playbook.repeat > 20) return { ok: false, error: 'repeat must be 1–20' }
  if (input.cases != null) {
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 20) return { ok: false, error: 'cases must contain 1–20 cases' }
    if (input.cases.some(function (item) { return !playbookObject(item) || !playbookObject(item.vars) || typeof item.name !== 'string' || !item.name.trim() })) return { ok: false, error: 'Each case needs a name and vars object' }
    playbook.cases = input.cases
  }
  return { ok: true, playbook: playbook }
}

function readPlaybookFile (file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    const validated = validatePlaybook(parsed)
    if (!validated.ok) return validated
    validated.playbook.path = file
    validated.playbook.updatedAt = fs.statSync(file).mtimeMs
    return validated
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

function listPlaybooks (cwd, workspaceId) {
  const storage = playbookStorage(cwd, workspaceId)
  if (!storage) return { ok: false, error: 'No workspace' }
  const dir = storage.dir
  if (!fs.existsSync(dir)) return { ok: true, playbooks: [] }
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  const playbooks = []
  names.forEach(function (name) {
    if (!name.endsWith('.json')) return
    const file = path.join(dir, name)
    if (!isPathInside(storage.root, file)) return
    const loaded = readPlaybookFile(file)
    if (!loaded.ok) {
      playbooks.push({ name: name.replace(/\.json$/, ''), error: loaded.error, path: file })
      return
    }
    playbooks.push({
      name: loaded.playbook.name,
      description: loaded.playbook.description,
      steps: loaded.playbook.steps.length,
      stepItems: loaded.playbook.steps,
      path: file,
      repeat: loaded.playbook.repeat,
      cases: (loaded.playbook.cases || []).length || 1,
      lastRun: playbookLatest(cwd, loaded.playbook.name, workspaceId),
      updatedAt: loaded.playbook.updatedAt
    })
  })
  playbooks.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name))
  })
  return { ok: true, playbooks: playbooks, dir: dir }
}

function getPlaybook (cwd, name, workspaceId) {
  const file = playbookPathFor(cwd, name, workspaceId)
  if (!file) return { ok: false, error: 'Invalid playbook name' }
  if (!fs.existsSync(file)) return { ok: false, error: 'Playbook not found: ' + playbookSlug(name) }
  return readPlaybookFile(file)
}

function savePlaybook (cwd, input, workspaceId) {
  const validated = validatePlaybook(input)
  if (!validated.ok) return validated
  const ensured = ensurePlaybookDir(cwd, workspaceId)
  if (!ensured.ok) return ensured
  const file = playbookPathFor(cwd, validated.playbook.name, workspaceId)
  if (!file) return { ok: false, error: 'Invalid playbook path' }
  try {
    fs.writeFileSync(file, JSON.stringify(validated.playbook, null, 2) + '\n', 'utf8')
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  broadcastPlaybookEvent(Object.assign({
    type: 'changed',
    name: validated.playbook.name
  }, playbookScope(cwd, workspaceId)))
  return { ok: true, playbook: validated.playbook, path: file }
}

function deletePlaybook (cwd, name, workspaceId) {
  const file = playbookPathFor(cwd, name, workspaceId)
  if (!file) return { ok: false, error: 'Invalid playbook name' }
  if (!fs.existsSync(file)) return { ok: false, error: 'Playbook not found: ' + playbookSlug(name) }
  try {
    fs.unlinkSync(file)
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  broadcastPlaybookEvent(Object.assign({
    type: 'changed',
    name: playbookSlug(name)
  }, playbookScope(cwd, workspaceId)))
  return { ok: true }
}

var playbookActiveRun = null

function playbookReportDir (cwd, name, workspaceId) {
  const storage = playbookStorage(cwd, workspaceId)
  if (!storage) throw new Error('No workspace')
  const dir = path.join(storage.dir, 'runs', playbookSlug(name))
  if (!isPathInside(storage.root, dir)) throw new Error('Invalid report path')
  return dir
}

function playbookLatest (cwd, name, workspaceId) {
  try { return JSON.parse(fs.readFileSync(path.join(playbookReportDir(cwd, name, workspaceId), 'latest.json'), 'utf8')) } catch (err) { return null }
}

function playbookReports (cwd, name, workspaceId, runId) {
  try {
    const dir = playbookReportDir(cwd, name, workspaceId)
    if (runId) {
      if (!/^\d{13}-[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid runId')
      return { ok: true, report: JSON.parse(fs.readFileSync(path.join(dir, runId, 'report.json'), 'utf8')) }
    }
    if (!fs.existsSync(dir)) return { ok: true, reports: [] }
    const reports = fs.readdirSync(dir).filter(function (id) { return /^\d{13}-[a-f0-9]{12}$/.test(id) }).sort().reverse().slice(0, 20).map(function (id) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(dir, id, 'report.json'), 'utf8'))
        return { runId: id, ok: report.ok, status: report.status, startedAt: report.startedAt, durationMs: report.durationMs, summary: report.summary, reportPath: report.reportPath }
      } catch (err) { return { runId: id, error: err.message } }
    })
    return { ok: true, reports: reports }
  } catch (err) { return { ok: false, error: err.message } }
}

function cancelPlaybook (workspaceId, name) {
  if (!playbookActiveRun || playbookActiveRun.workspaceId !== workspaceId || (name && playbookActiveRun.name !== playbookSlug(name))) return { ok: false, error: 'No matching playbook is running' }
  playbookActiveRun.cancelled = true
  return { ok: true, runId: playbookActiveRun.runId, message: 'Cancellation requested; the current step finishes, then teardown runs.' }
}

function playbookStepResult (result) {
  const out = {}
  // Keep evidence without saving input variables or the entire page snapshot.
  ;['ok', 'error', 'tabId', 'url', 'condition', 'expected', 'actual', 'matched', 'attempts', 'durationMs', 'not', 'contains', 'checked', 'changed', 'assertion', 'diff', 'images', 'path', 'ready', 'diagnostics'].forEach(function (key) {
    if (result[key] !== undefined) out[key] = result[key]
  })
  return out
}

async function runPlaybook (cwd, name, vars, options) {
  options = options || {}
  if (!options.workspaceId) return { ok: false, error: 'workspaceId is required; playbooks run in one workspace' }
  if (playbookActiveRun) return { ok: false, error: 'A playbook is already running' }
  const loaded = getPlaybook(cwd, name, options.workspaceId)
  if (!loaded.ok) return loaded
  const playbook = loaded.playbook
  const iterations = options.repeat == null ? playbook.repeat : options.repeat
  const cases = playbook.cases || [{ name: 'default', vars: {} }]
  const scenarios = []
  try {
    if (!playbookObject(vars || {})) throw new Error('Run variables must be an object')
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error('repeat must be 1–20')
    if (iterations * cases.length > 100 || iterations * cases.length * (playbook.setup.length + playbook.steps.length + playbook.teardown.length) > 5000) throw new Error('Run exceeds 100 scenarios or 5000 steps')
    // Validate every variable before starting any browser mutation.
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (const item of cases) {
        const values = Object.assign(Object.create(null), playbook.vars, item.vars, vars || {})
        const scenario = { iteration: iteration, case: item.name, setup: interpolatePlaybookValue(playbook.setup, values), steps: interpolatePlaybookValue(playbook.steps, values), teardown: interpolatePlaybookValue(playbook.teardown, values) }
        for (const phase of ['setup', 'steps', 'teardown']) {
          for (let i = 0; i < scenario[phase].length; i++) {
            const valid = browserCommandValidate(scenario[phase][i])
            if (!valid.ok) throw new Error(item.name + ' ' + phase + ' step ' + (i + 1) + ': ' + valid.error)
          }
        }
        scenarios.push(scenario)
      }
    }
  } catch (err) { return { ok: false, error: err.message } }
  const runId = Date.now() + '-' + require('crypto').randomBytes(6).toString('hex')
  const state = { runId: runId, name: playbook.name, workspaceId: options.workspaceId, cancelled: false }
  playbookActiveRun = state
  const startedAt = Date.now()
  const report = { ok: true, status: 'running', runId: runId, name: playbook.name, workspaceId: options.workspaceId, taskId: options.taskId, startedAt: startedAt, scenarios: [], results: [] }
  let runDir
  let activeTabId = options.tabId
  let total = 0
  const scope = { workspaceId: options.workspaceId, taskId: options.taskId }
  try {
    runDir = path.join(playbookReportDir(cwd, name, options.workspaceId), runId)
    fs.mkdirSync(runDir, { recursive: true })
    report.reportPath = path.join(runDir, 'report.json')
    const listed = await minBrowser.tabs('list', scope)
    if (!listed.ok) throw new Error(listed.error)
    scope.taskId = listed.taskId
    report.taskId = listed.taskId
    if (!scope.taskId) throw new Error('Could not resolve a task for this playbook')
    if (activeTabId && !listed.tabs.some(function (tab) { return tab.id === activeTabId })) throw new Error('Tab is not in this task')
    activeTabId = activeTabId || (listed.tabs.some(function (tab) { return tab.id === listed.selected }) ? listed.selected : (listed.tabs[0] || {}).id)
    if (!activeTabId) {
      const created = await minBrowser.tabs('new', Object.assign({ url: 'about:blank' }, scope))
      if (!created.ok) throw new Error(created.error)
      activeTabId = created.id
    }
    const planned = scenarios.reduce(function (sum, scenario) { return sum + scenario.setup.length + scenario.steps.length + scenario.teardown.length }, 0)
    for (const scenario of scenarios) {
      if (state.cancelled) break
      const scenarioResult = { iteration: scenario.iteration, case: scenario.case, ok: true, results: [] }
      report.scenarios.push(scenarioResult)
      let stopped = false
      await minBrowser.runStep(Object.assign({ action: 'diagnostics', operation: 'clear', tabId: activeTabId }, scope))
      for (const phase of ['setup', 'steps', 'teardown']) {
        for (let i = 0; i < scenario[phase].length; i++) {
          const step = scenario[phase][i]
          const index = total++
          if (phase !== 'teardown' && (stopped || state.cancelled)) {
            const skipped = { index: index, phase: phase, stepIndex: i, action: step.action, status: 'skipped' }
            scenarioResult.results.push(skipped); report.results.push(skipped)
            continue
          }
          const progress = Object.assign({ type: 'progress', runId: runId, name: playbook.name, index: index, total: planned, phase: phase, stepIndex: i, iteration: scenario.iteration, case: scenario.case, step: { action: step.action, stepName: step.stepName } }, playbookScope(cwd, options.workspaceId))
          broadcastPlaybookEvent(progress)
          if (options.onProgress) { try { options.onProgress(progress) } catch (err) {} }
          const stepStart = Date.now()
          let result
          try {
            result = await minBrowser.runStep(Object.assign({}, step, scope, { tabId: step.tabId || activeTabId, outputDir: runDir }))
            if (!result) result = { ok: false, error: 'Step returned no result' }
            if (result.ok && result.assertion && !result.assertion.passed) result = Object.assign({}, result, { ok: false, error: 'Visual assertion failed: mismatch ' + result.assertion.actual + ', maximum ' + result.assertion.expected + (result.assertion.ready ? '' : '; page not ready') })
          } catch (err) { result = { ok: false, error: err.message || String(err) } }
          if (result.ok && step.action === 'tabs') {
            if (step.operation === 'new' || step.operation === 'select') activeTabId = result.id
            if (step.operation === 'close' && (!step.tabId || step.tabId === activeTabId)) activeTabId = result.selected
          }
          const entry = Object.assign({ index: index, phase: phase, stepIndex: i, action: step.action, stepName: step.stepName, iteration: scenario.iteration, case: scenario.case, status: result.ok ? 'passed' : 'failed' }, playbookStepResult(result), { durationMs: Date.now() - stepStart })
          if (!result.ok) {
            scenarioResult.ok = false; report.ok = false
            report.error = report.error || result.error || 'Step failed'
            report.stoppedAt = report.stoppedAt == null ? index : report.stoppedAt
            try {
              entry.diagnostics = await minBrowser.runStep(Object.assign({ action: 'diagnostics', tabId: step.tabId || activeTabId }, scope))
              if (!result.images) {
                const shot = await minBrowser.runStep(Object.assign({ action: 'screenshot', tabId: step.tabId || activeTabId, outputDir: runDir, timeout: 1000 }, scope))
                entry.evidence = shot.ok ? { path: shot.path, images: shot.images } : { error: shot.error }
              }
            } catch (err) { entry.evidence = { error: err.message } }
            if (!step.continueOnError) stopped = true
          }
          scenarioResult.results.push(entry); report.results.push(entry)
        }
      }
    }
  } catch (err) {
    report.ok = false; report.error = err.message || String(err)
  } finally {
    report.cancelled = state.cancelled
    if (state.cancelled) { report.ok = false; report.error = report.error || 'Playbook cancelled' }
    report.status = state.cancelled ? 'cancelled' : report.ok ? 'passed' : 'failed'
    report.durationMs = Date.now() - startedAt
    report.summary = { passed: report.results.filter(function (r) { return r.status === 'passed' }).length, failed: report.results.filter(function (r) { return r.status === 'failed' }).length, skipped: report.results.filter(function (r) { return r.status === 'skipped' }).length, scenarios: report.scenarios.length, plannedScenarios: scenarios.length }
    try {
      if (report.reportPath) {
        fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2) + '\n')
        fs.writeFileSync(path.join(path.dirname(runDir), 'latest.json'), JSON.stringify({ runId: runId, ok: report.ok, status: report.status, startedAt: startedAt, durationMs: report.durationMs, summary: report.summary, reportPath: report.reportPath }) + '\n')
      }
    } catch (err) { report.ok = false; report.status = 'failed'; report.error = 'Could not write run report: ' + err.message }
    playbookActiveRun = null
    broadcastPlaybookEvent(Object.assign({ type: 'done', name: playbook.name, ok: report.ok, status: report.status, error: report.error, runId: runId, reportPath: report.reportPath, summary: report.summary }, playbookScope(cwd, options.workspaceId)))
  }
  return report
}

function broadcastPlaybookEvent (data) {
  try {
    windows.getAll().forEach(function (win) {
      getWindowWebContents(win).send('playbook-event', data)
    })
  } catch (e) {}
}

ipc.handle('playbookList', function (e, cwd, workspaceId) {
  return listPlaybooks(cwd, workspaceId)
})

ipc.handle('playbookGet', function (e, cwd, name, workspaceId) {
  return getPlaybook(cwd, name, workspaceId)
})

ipc.handle('playbookSave', function (e, cwd, input, workspaceId) {
  return savePlaybook(cwd, input, workspaceId)
})

ipc.handle('playbookDelete', function (e, cwd, name, workspaceId) {
  return deletePlaybook(cwd, name, workspaceId)
})

ipc.handle('playbookRun', async function (e, cwd, name, vars, workspaceId, options) {
  return runPlaybook(cwd, name, vars || {}, Object.assign({}, options, { workspaceId: workspaceId }))
})

ipc.handle('playbookReports', function (e, cwd, name, workspaceId, runId) {
  return playbookReports(cwd, name, workspaceId, runId)
})

ipc.handle('playbookCancel', function (e, workspaceId, name) {
  return cancelPlaybook(workspaceId, name)
})
