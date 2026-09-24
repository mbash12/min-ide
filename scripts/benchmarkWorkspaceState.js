// Read-only comparison against the implementation before this refactor.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const baseline = process.argv[2] || '537be12e'

function measure (ref) {
  const cache = new Map()
  const scope = vm.createContext({ console, Map, Set, windowId: '1', window: {}, setTimeout: () => 1, clearTimeout () {} })
  function load (name) {
    if (cache.has(name)) return cache.get(name).exports
    const source = ref
      ? execFileSync('git', ['show', ref + ':js/' + name], { encoding: 'utf8' })
      : fs.readFileSync(path.join(__dirname, '../js', name), 'utf8')
    const module = { exports: {} }
    cache.set(name, module)
    vm.runInContext('(function(require,module){' + source + '\n})', scope)(load, module)
    return module.exports
  }
  const Store = load('tabState/workspace.js')
  const store = new Store()
  for (let w = 0; w < 100; w++) {
    store.add({ id: String(w), tasks: Array.from({ length: 10 }, (_, t) => ({ id: w + ':' + t, tabs: Array.from({ length: 20 }, (_, i) => ({ id: w + ':' + t + ':' + i, url: '', title: '' })) })) }, undefined, false)
  }
  const samples = []
  for (let round = 0; round < 5; round++) {
    const started = performance.now()
    for (let i = 0; i < 10000; i++) {
      const id = (i % 100) + ':9:19'
      const task = store.findTaskContainingTab(id)
      task.tabs.update(id, { title: String(i) }, false)
      task.tabs.get(id)
    }
    samples.push(performance.now() - started)
  }
  return samples.sort((a, b) => a - b)[2]
}
const before = measure(baseline)
const after = measure(null)
console.log(JSON.stringify({ workspaces: 100, tasks: 1000, tabs: 20000, operations: 10000, samples: 5, baseline, beforeMs: +before.toFixed(2), afterMs: +after.toFixed(2), speedup: +(before / after).toFixed(1) }, null, 2))
