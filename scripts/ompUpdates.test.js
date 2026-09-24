const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

function updaterHarness (t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-omp-update-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bundled = path.join(dir, 'main', 'vendor', 'omp')
  fs.mkdirSync(bundled, { recursive: true })
  fs.writeFileSync(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '1.0.0', esbuildVersion: '0.28.2', yamlVersion: '4.3.1' }))
  for (const name of ['entry.ts', 'bun-globals.ts', 'bun-modules.ts', 'pi-natives.ts', 'build.mjs']) fs.writeFileSync(path.join(bundled, name), '// fixture')
  const updateRoot = path.join(dir, 'pi-agent', 'omp-updates')
  const original = { id: '1.1.0-1', version: '1.1.0' }
  fs.mkdirSync(path.join(updateRoot, 'versions', original.id), { recursive: true })
  fs.writeFileSync(path.join(updateRoot, 'versions', original.id, 'bundle.mjs'), '// previously installed bundle')
  fs.writeFileSync(path.join(updateRoot, 'active.json'), JSON.stringify(original))
  const handlers = new Map()
  let activated = 0
  const processes = []
  const execFile = (file, args, settings, callback) => {
    processes.push({ file, args, settings })
    if (options.installFailure) return setImmediate(() => callback(new Error('failed'), '', 'registry unavailable'))
    if (args[0].endsWith('buildOmpProviders.mjs')) {
      const exports = ['streamDevin', 'streamCursor', 'streamGoogleGeminiCli', 'streamGitLabDuo', 'fetchDevinModels', 'fetchCursorUsableModels', 'fetchGeminiCliQuotaModels', 'fetchAntigravityDiscoveryModels', 'getGitLabDuoModels']
      let source = exports.filter(name => !(options.incompatible && name === 'streamCursor')).map(name => 'export function ' + name + '() {}').join('\n')
      source += '\nexport function getBundledModels() { return [] }'
      const out = path.join(settings.cwd, 'main', 'vendor', 'omp')
      fs.writeFileSync(path.join(out, 'bundle.mjs'), source)
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version: '2.0.0' }))
    }
    setImmediate(() => callback(null, '', ''))
  }
  const fakeRequire = name => name === 'child_process' ? { execFile } : require(name)
  const source = fs.readFileSync(path.join(__dirname, '../main/ompUpdates.js'), 'utf8')
  const updater = new Function('require', '__dirname', 'app', 'ipc', 'net', 'onAgentComponentsUpdated', source + '\nreturn { status: ompUpdateStatus, install: ompInstallUpdate, active: ompActiveBundle }')(
    fakeRequire, dir, { getPath: () => dir }, { handle: (name, fn) => handlers.set(name, fn) },
    { fetch: async () => ({ ok: true, json: async () => ({ version: options.latest || '2.0.0' }) }) }, () => { activated++ }
  )
  return { updater, processes, handlers, bundled, updateRoot, original, activated: () => activated }
}

test('component update stages, validates, and atomically activates one coalesced install', async t => {
  const h = updaterHarness(t)
  assert.equal(h.updater.status().current, '1.1.0')
  const first = h.updater.install()
  assert.equal(first, h.updater.install())
  const result = await first
  assert.equal(result.ok, true)
  assert.equal(result.updated, true)
  assert.equal(result.current, '2.0.0')
  assert.equal(h.activated(), 1)
  assert.equal(h.processes.length, 2)
  assert.ok(h.processes[0].args.includes('--ignore-scripts'))
  assert.ok(h.processes[0].args.includes('@oh-my-pi/pi-ai@2.0.0'))
  assert.equal(h.processes[1].settings.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(fs.readdirSync(h.updateRoot).some(name => name.startsWith('staging-')), false)
  assert.equal(fs.existsSync(h.updater.active().path), true)
  assert.equal(fs.existsSync(path.join(h.updateRoot, 'versions', h.original.id, 'bundle.mjs')), true)
})

for (const [name, options, error] of [
  ['incompatible protocol adapter', { incompatible: true }, /missing streamCursor/],
  ['failed download', { installFailure: true }, /registry unavailable/]
]) {
  test(name + ' preserves the active version and cleans staging', async t => {
    const h = updaterHarness(t, options)
    const result = await h.handlers.get('agent-update-components')()
    assert.equal(result.ok, false)
    assert.match(result.message, error)
    assert.equal(h.updater.status().current, '1.1.0')
    assert.equal(h.updater.status().updating, false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.updateRoot, 'active.json'))), h.original)
    assert.deepEqual(fs.readdirSync(path.join(h.updateRoot, 'versions')), [h.original.id])
    assert.equal(fs.readdirSync(h.updateRoot).some(name => name.startsWith('staging-')), false)
    assert.equal(h.activated(), 0)
  })
}

test('checking cannot downgrade a newer installed or shipped component version', async t => {
  const h = updaterHarness(t, { latest: '1.0.0' })
  assert.equal((await h.handlers.get('agent-check-updates')()).available, false)
  assert.equal((await h.updater.install()).updated, undefined)
  assert.equal(h.processes.length, 0)
  fs.writeFileSync(path.join(h.bundled, 'manifest.json'), JSON.stringify({ version: '3.0.0' }))
  assert.equal(h.updater.active(), null)
  assert.equal(h.updater.status().current, '3.0.0')
})
