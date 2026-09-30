const assert = require('node:assert/strict')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* a fresh module instance per test: the helper remembers folders it handled */
function freshExclude () {
  const file = path.join(__dirname, '../main/lib/git/exclude.js')
  delete require.cache[file]
  return require(file).excludeFromGit
}

function makeRepo (t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-exclude-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}

function untracked (cwd) {
  return childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(line => line.slice(3))
}

function output (dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'generated')
}

test('generated output under .min stays out of "git add -A", while playbooks remain versionable', t => {
  const exclude = freshExclude()
  const repo = makeRepo(t)
  const results = path.join(repo, '.min', 'agent-results')
  const shots = path.join(repo, '.min', 'design', 'shots')
  fs.mkdirSync(results, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  assert.equal(exclude(results), true)
  assert.equal(exclude(shots), true)
  output(results, 'tool.json')
  output(shots, 'actual.png')
  output(path.join(repo, '.min', 'playbooks'), 'release.md')
  fs.writeFileSync(path.join(repo, 'app.js'), 'code')

  assert.deepEqual(untracked(repo).sort(), ['.min/playbooks/release.md', 'app.js'])
  childProcess.execFileSync('git', ['add', '-A'], { cwd: repo })
  const staged = childProcess.execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })
  assert.equal(staged.includes('agent-results'), false)
  assert.equal(staged.includes('shots'), false)
  // the tracked .gitignore is never created or edited
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false)
})

test('an entry is written once, even across module instances', t => {
  const repo = makeRepo(t)
  const dir = path.join(repo, '.min', 'design', 'exports')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(freshExclude()(dir), true)
  assert.equal(freshExclude()(dir), false)
  const excludeFile = path.join(repo, '.git', 'info', 'exclude')
  const lines = fs.readFileSync(excludeFile, 'utf8').split('\n').filter(line => line === '/.min/design/exports/')
  assert.equal(lines.length, 1)
})

test('existing exclude rules are kept and a missing trailing newline is handled', t => {
  const repo = makeRepo(t)
  const excludeFile = path.join(repo, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.writeFileSync(excludeFile, '*.local')
  const dir = path.join(repo, '.min', 'agent-results')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(freshExclude()(dir), true)
  assert.equal(fs.readFileSync(excludeFile, 'utf8'), '*.local\n/.min/agent-results/\n')
})

test('a workspace below the repository root gets a path relative to the root', t => {
  const repo = makeRepo(t)
  const dir = path.join(repo, 'packages', 'web', '.min', 'agent-results')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(freshExclude()(dir), true)
  output(dir, 'tool.json')
  assert.deepEqual(untracked(repo), [])
})

test('nothing is touched outside a repository or for folders that are not Min output', t => {
  const exclude = freshExclude()
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-exclude-plain-')))
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }))
  const notRepo = path.join(plain, '.min', 'agent-results')
  fs.mkdirSync(notRepo, { recursive: true })
  assert.equal(exclude(notRepo), false)

  const repo = makeRepo(t)
  const userDir = path.join(repo, 'exports')
  fs.mkdirSync(userDir)
  assert.equal(exclude(userDir), false)
  assert.equal(exclude(path.join(repo, 'does-not-exist', '.min')), false)
  assert.equal(fs.existsSync(path.join(repo, '.git', 'info', 'exclude')) && fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('/exports/'), false)
})

test('the repository itself is never excluded, and special characters are escaped', t => {
  const repo = makeRepo(t)
  const odd = path.join(repo, 'a[b]*', '.min', 'agent-results')
  fs.mkdirSync(odd, { recursive: true })
  assert.equal(freshExclude()(odd), true)
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/a\\\[b\\\]\\\*\/\.min\/agent-results\/$/m)
  output(odd, 'tool.json')
  assert.deepEqual(untracked(repo), [])
})
