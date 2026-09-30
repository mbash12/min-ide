const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

test('packaging retains runtime main helpers and every traversed parent directory', async () => {
  const root = path.resolve(__dirname, '..')
  let config
  const builder = {
    Platform: { LINUX: { createTarget: () => new Map() } },
    Arch: { x64: 1 },
    build: options => { config = options.config; return Promise.resolve() }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'createPackage.js'), 'utf8'), {
    module,
    require: name => name === 'electron-builder' ? builder : require(name),
    __dirname
  })
  await module.exports('linux', { arch: builder.Arch.x64 })
  const include = new FileMatcher(root, '/unused-package-destination', value => value, config.files).createFilter()
  function check (relative) {
    const file = path.join(root, relative)
    assert.equal(include(file, fs.statSync(file)), true, relative + ' must be packaged')
  }
  function walk (relative) {
    check(relative)
    fs.readdirSync(path.join(root, relative), { withFileTypes: true }).forEach(entry => {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) walk(name)
      else if (entry.name.endsWith('.js')) check(name)
    })
  }
  check('main')
  walk('main/lib')
  check('main/vendor')
  check('main/vendor/omp')
  check('main/vendor/omp/build.mjs')
  check('pages/proSettings/settingsLifecycle.js')
  check('pages/proSettings/profilesPanel.js')
})
