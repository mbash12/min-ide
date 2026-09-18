/* global fs, path, ipc, isPathInside, windows, getWindowWebContents, minBrowser, app */
/* Playbooks are JSON recipes of browser actions stored per workspace. With a
folder they live in .min/playbooks; without one they live in Min's userData
under playbooks/{workspaceId}. The sidebar can list and run them without the
model. */

var PLAYBOOK_DIRNAME = path.join('.min', 'playbooks')
var PLAYBOOK_ACTIONS = {
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

function interpolatePlaybookValue (value, vars) {
  if (typeof value !== 'string' || !vars) return value
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, function (_, key) {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null) {
      return String(vars[key])
    }
    return ''
  })
}

function interpolatePlaybookStep (step, vars) {
  const out = {}
  Object.keys(step).forEach(function (key) {
    const value = step[key]
    if (typeof value === 'string') out[key] = interpolatePlaybookValue(value, vars)
    else out[key] = value
  })
  return out
}

function validatePlaybook (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Playbook must be an object' }
  }
  const name = String(input.name || '').trim()
  if (!name) return { ok: false, error: 'Playbook name is required' }
  if (!/^[a-zA-Z0-9._-]+$/.test(playbookSlug(name))) {
    return { ok: false, error: 'Playbook name is invalid' }
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'Playbook needs at least one step' }
  }
  if (input.steps.length > 200) {
    return { ok: false, error: 'Playbook has too many steps' }
  }
  const steps = []
  for (var i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return { ok: false, error: 'Step ' + (i + 1) + ' is invalid' }
    }
    const action = String(step.action || '').trim()
    if (!PLAYBOOK_ACTIONS[action]) {
      return { ok: false, error: 'Step ' + (i + 1) + ' has unknown action: ' + action }
    }
    steps.push(step)
  }
  return {
    ok: true,
    playbook: {
      name: playbookSlug(name),
      description: input.description ? String(input.description).slice(0, 500) : '',
      version: 1,
      steps: steps
    }
  }
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

var playbookRunLock = false

async function runPlaybook (cwd, name, vars, options) {
  options = options || {}
  if (!options.workspaceId) {
    return { ok: false, error: 'workspaceId is required; playbooks run in one workspace' }
  }
  if (playbookRunLock) return { ok: false, error: 'A playbook is already running' }
  const loaded = getPlaybook(cwd, name, options.workspaceId)
  if (!loaded.ok) return loaded
  playbookRunLock = true
  const results = []
  const playbook = loaded.playbook
  try {
    for (var i = 0; i < playbook.steps.length; i++) {
      const step = interpolatePlaybookStep(playbook.steps[i], vars || {})
      broadcastPlaybookEvent(Object.assign({
        type: 'progress',
        name: playbook.name,
        index: i,
        total: playbook.steps.length,
        step: step
      }, playbookScope(cwd, options.workspaceId)))
      if (options.onProgress) {
        try { options.onProgress({ index: i, total: playbook.steps.length, step: step }) } catch (e) {}
      }
      const result = await minBrowser.runStep(Object.assign({}, step, {
        workspaceId: options.workspaceId
      }))
      results.push({
        index: i,
        action: step.action,
        ok: !!(result && result.ok),
        error: result && result.error ? result.error : null,
        url: result && result.url ? result.url : undefined
      })
      if (!result || !result.ok) {
        if (step.continueOnError) continue
        broadcastPlaybookEvent(Object.assign({
          type: 'done',
          name: playbook.name,
          ok: false,
          stoppedAt: i,
          error: result && result.error ? result.error : 'Step failed'
        }, playbookScope(cwd, options.workspaceId)))
        return {
          ok: false,
          name: playbook.name,
          stoppedAt: i,
          error: result && result.error ? result.error : 'Step failed',
          results: results
        }
      }
    }
    broadcastPlaybookEvent(Object.assign({
      type: 'done',
      name: playbook.name,
      ok: true,
      results: results
    }, playbookScope(cwd, options.workspaceId)))
    return { ok: true, name: playbook.name, results: results }
  } finally {
    playbookRunLock = false
  }
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

ipc.handle('playbookRun', async function (e, cwd, name, vars, workspaceId) {
  return runPlaybook(cwd, name, vars || {}, { workspaceId: workspaceId })
})
