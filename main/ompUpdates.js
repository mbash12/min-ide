/* On-demand OMP transport/catalog updates. Build in an isolated directory,
 * validate the adapter contract, then atomically activate the new bundle.
 * Existing conversations retain their loaded bundle until their next turn. */
/* global app, ipc, net, onAgentComponentsUpdated, AbortSignal */

var ompUpdateFs = require('fs')
var ompUpdatePath = require('path')
var ompUpdateRunning = null
var ompUpdateLatest = null
var OMP_UPDATE_PACKAGES = ['@oh-my-pi/pi-ai', '@oh-my-pi/pi-catalog', '@oh-my-pi/pi-utils']
var OMP_REQUIRED_EXPORTS = ['streamDevin', 'streamCursor', 'streamGoogleGeminiCli', 'streamGitLabDuo', 'getBundledModels', 'fetchDevinModels', 'fetchCursorUsableModels', 'fetchGeminiCliQuotaModels', 'fetchAntigravityDiscoveryModels', 'getGitLabDuoModels']

function ompUpdateRoot () {
  return ompUpdatePath.join(app.getPath('userData'), 'pi-agent', 'omp-updates')
}

function ompBundledDir () {
  return ompUpdatePath.join(__dirname, 'main', 'vendor', 'omp')
}

function ompReadJson (file) {
  try { return JSON.parse(ompUpdateFs.readFileSync(file, 'utf8')) } catch (err) { return null }
}

function ompNewerVersion (candidate, current) {
  if (!candidate) return false
  if (!current) return true
  var a = String(candidate).split('-')
  var b = String(current).split('-')
  var an = a[0].split('.').map(Number)
  var bn = b[0].split('.').map(Number)
  for (var i = 0; i < 3; i++) {
    if (an[i] !== bn[i]) return an[i] > bn[i]
  }
  if (a.length === 1 || b.length === 1) return a.length === 1 && b.length > 1
  return a.slice(1).join('-').localeCompare(b.slice(1).join('-'), 'en', { numeric: true }) > 0
}

function ompActiveBundle () {
  var active = ompReadJson(ompUpdatePath.join(ompUpdateRoot(), 'active.json'))
  if (!active || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?-\d+$/.test(active.id || '')) return null
  var bundled = ompReadJson(ompUpdatePath.join(ompBundledDir(), 'manifest.json'))
  if (!active.version || (bundled && ompNewerVersion(bundled.version, active.version))) return null
  var file = ompUpdatePath.join(ompUpdateRoot(), 'versions', active.id, 'bundle.mjs')
  return ompUpdateFs.existsSync(file) ? { path: file, version: active.version } : null
}

function ompUpdateStatus () {
  var active = ompActiveBundle()
  var manifest = ompReadJson(ompUpdatePath.join(ompBundledDir(), 'manifest.json'))
  var current = active ? active.version : manifest && manifest.version
  return {
    ok: true,
    current: current || null,
    latest: ompUpdateLatest,
    available: ompNewerVersion(ompUpdateLatest, current),
    updating: !!ompUpdateRunning
  }
}

async function ompCheckUpdates () {
  var request = typeof net !== 'undefined' && net.fetch ? net.fetch.bind(net) : fetch
  var response = await request('https://registry.npmjs.org/@oh-my-pi%2Fpi-ai/latest', { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Could not check component updates (HTTP ' + response.status + ')')
  var data = await response.json()
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.version || '')) throw new Error('Invalid component version from registry')
  ompUpdateLatest = data.version
  return ompUpdateStatus()
}

function ompRunUpdateProcess (file, args, cwd, runAsNode) {
  return new Promise(function (resolve, reject) {
    var env = Object.assign({}, process.env)
    if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    require('child_process').execFile(file, args, {
      cwd: cwd, env: env, windowsHide: true, timeout: 300000, maxBuffer: 2 * 1024 * 1024
    }, function (err, stdout, stderr) {
      if (err) {
        reject(new Error(err.code === 'ENOENT'
          ? 'Install Node.js with npm to enable component updates.'
          : 'Component update failed: ' + String(stderr || stdout || err.message).slice(-1500)))
      } else resolve()
    })
  })
}

function ompNpmInvocation (args) {
  if (process.platform !== 'win32') return { file: 'npm', args: args, runAsNode: false }
  // Run npm's JS entry point directly: never interpolate a Windows .cmd shell
  // command, since user-data paths can contain spaces and shell metacharacters.
  var dirs = (process.env.PATH || '').split(ompUpdatePath.delimiter)
  for (var dir of dirs) {
    var cli = ompUpdatePath.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (ompUpdateFs.existsSync(cli)) return { file: process.execPath, args: [cli].concat(args), runAsNode: true }
  }
  throw new Error('Install Node.js with npm to enable component updates.')
}

async function ompValidateBundle (file) {
  var bundle = await import(require('url').pathToFileURL(file).href)
  for (var name of OMP_REQUIRED_EXPORTS) {
    if (typeof bundle[name] !== 'function') throw new Error('This OMP version is incompatible with Min: missing ' + name)
  }
  if (!Array.isArray(bundle.getBundledModels('cursor'))) throw new Error('This OMP version has an incompatible model catalog')
  return bundle
}

function ompInstallUpdate () {
  if (ompUpdateRunning) return ompUpdateRunning
  ompUpdateRunning = ompInstallUpdateInner().finally(function () { ompUpdateRunning = null })
  return ompUpdateRunning
}

async function ompInstallUpdateInner () {
  var checked = await ompCheckUpdates()
  if (!checked.available) return checked
  var version = checked.latest
  var root = ompUpdateRoot()
  ompUpdateFs.mkdirSync(root, { recursive: true })
  var staging = ompUpdateFs.mkdtempSync(ompUpdatePath.join(root, 'staging-'))
  var id = version + '-' + Date.now()
  var destination = ompUpdatePath.join(root, 'versions', id)
  var activated = false
  try {
    var sources = ompUpdatePath.join(staging, 'main', 'vendor', 'omp')
    ompUpdateFs.mkdirSync(sources, { recursive: true })
    for (var name of ['entry.ts', 'bun-globals.ts', 'bun-modules.ts', 'pi-natives.ts']) {
      ompUpdateFs.copyFileSync(ompUpdatePath.join(ompBundledDir(), name), ompUpdatePath.join(sources, name))
    }
    ompUpdateFs.mkdirSync(ompUpdatePath.join(staging, 'scripts'))
    ompUpdateFs.copyFileSync(ompUpdatePath.join(ompBundledDir(), 'build.mjs'), ompUpdatePath.join(staging, 'scripts', 'buildOmpProviders.mjs'))
    var buildInfo = ompReadJson(ompUpdatePath.join(ompBundledDir(), 'manifest.json'))
    if (!buildInfo || !buildInfo.esbuildVersion || !buildInfo.yamlVersion) throw new Error('Component updater is missing build metadata. Rebuild Min first.')
    ompUpdateFs.writeFileSync(ompUpdatePath.join(staging, 'package.json'), JSON.stringify({ name: 'min-omp-update', private: true }))
    var packages = OMP_UPDATE_PACKAGES.map(function (name) { return name + '@' + version }).concat('esbuild@' + buildInfo.esbuildVersion, 'js-yaml@' + buildInfo.yamlVersion)
    var invocation = ompNpmInvocation(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org'].concat(packages))
    await ompRunUpdateProcess(invocation.file, invocation.args, staging, invocation.runAsNode)
    await ompRunUpdateProcess(process.execPath, [ompUpdatePath.join(staging, 'scripts', 'buildOmpProviders.mjs')], staging, true)
    ompUpdateFs.mkdirSync(destination, { recursive: true })
    for (var artifact of ['bundle.mjs', 'manifest.json']) {
      ompUpdateFs.copyFileSync(ompUpdatePath.join(sources, artifact), ompUpdatePath.join(destination, artifact))
    }
    await ompValidateBundle(ompUpdatePath.join(destination, 'bundle.mjs'))
    require('write-file-atomic').sync(ompUpdatePath.join(root, 'active.json'), JSON.stringify({ id: id, version: version }))
    activated = true
    onAgentComponentsUpdated()
    return Object.assign(ompUpdateStatus(), { updated: true, updating: false })
  } finally {
    ompUpdateFs.rmSync(staging, { recursive: true, force: true })
    if (!activated) ompUpdateFs.rmSync(destination, { recursive: true, force: true })
  }
}

ipc.handle('agent-component-status', function () { return ompUpdateStatus() })
ipc.handle('agent-check-updates', async function () {
  try { return await ompCheckUpdates() } catch (err) { return Object.assign(ompUpdateStatus(), { ok: false, message: err.message }) }
})
ipc.handle('agent-update-components', async function () {
  try { return await ompInstallUpdate() } catch (err) { return Object.assign(ompUpdateStatus(), { ok: false, message: err.message }) }
})

var minOmpUpdates = { activeBundle: ompActiveBundle }
global.minOmpUpdates = minOmpUpdates
