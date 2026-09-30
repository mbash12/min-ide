const assert = require('node:assert/strict')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createGitCore = require('../main/lib/git/core.js')
const createGitDiscard = require('../main/lib/git/discard.js')

function inside (root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

const core = createGitCore({ fs, path, childProcess, process, isPathInside: inside })
const discard = createGitDiscard({ fs, path, runGit: core.runGit, isPathInside: inside })

/* what main/git.js does for the gitDiscard IPC call */
function discardFiles (cwd, files) {
  return discard.discardFiles(cwd, core.sanitizeRepoFiles(cwd, files))
}

function git (cwd, ...args) {
  return childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'].concat(args), { cwd, encoding: 'utf8' })
}

function repo (t, files) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-discard-')))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-q')
  Object.keys(files).forEach(name => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
    fs.writeFileSync(path.join(cwd, name), files[name])
  })
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'initial')
  return cwd
}

const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8')
const exists = (cwd, name) => fs.existsSync(path.join(cwd, name))

test('a modified file is reverted and an untracked file is deleted, in one selection', async t => {
  const cwd = repo(t, { 'tracked.js': 'original', 'other.js': 'untouched' })
  fs.writeFileSync(path.join(cwd, 'tracked.js'), 'edited')
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'scratch')

  assert.equal(await discardFiles(cwd, ['tracked.js', 'new.txt']), null)
  assert.equal(read(cwd, 'tracked.js'), 'original')
  assert.equal(exists(cwd, 'new.txt'), false)
  assert.equal(read(cwd, 'other.js'), 'untouched')
})

test('a tracked file is never deleted when reverting it fails', async t => {
  const cwd = repo(t, { 'tracked.js': 'original' })
  fs.writeFileSync(path.join(cwd, 'tracked.js'), 'my work')
  // another git process (an agent, an IDE) holds the index: restore cannot run
  fs.writeFileSync(path.join(cwd, '.git', 'index.lock'), '')

  const error = await discardFiles(cwd, ['tracked.js'])
  assert.equal(typeof error, 'string')
  assert.equal(read(cwd, 'tracked.js'), 'my work')
})

test('a deleted tracked file comes back and staged work is left alone', async t => {
  const cwd = repo(t, { 'gone.js': 'kept in HEAD', 'staged.js': 'v1' })
  fs.rmSync(path.join(cwd, 'gone.js'))
  fs.writeFileSync(path.join(cwd, 'staged.js'), 'v2 staged')
  git(cwd, 'add', 'staged.js')
  fs.writeFileSync(path.join(cwd, 'staged.js'), 'v3 unstaged')

  assert.equal(await discardFiles(cwd, ['gone.js', 'staged.js']), null)
  assert.equal(read(cwd, 'gone.js'), 'kept in HEAD')
  // discard reverts the working tree to the index, not to HEAD
  assert.equal(read(cwd, 'staged.js'), 'v2 staged')
})

test('ignored files are not deleted', async t => {
  const cwd = repo(t, { '.gitignore': '*.log\n', 'a.js': 'a' })
  fs.writeFileSync(path.join(cwd, 'debug.log'), 'precious')

  assert.equal(await discardFiles(cwd, ['debug.log']), 'Nothing to discard')
  assert.equal(read(cwd, 'debug.log'), 'precious')
})

test('file names are literal, not globs', async t => {
  const cwd = repo(t, { 'a.txt': 'original', 'b.txt': 'original' })
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'edited a')
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'edited b')
  fs.writeFileSync(path.join(cwd, '[ab].txt'), 'untracked')
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'notes')

  assert.equal(await discardFiles(cwd, ['[ab].txt']), null)
  assert.equal(exists(cwd, '[ab].txt'), false)
  assert.equal(read(cwd, 'a.txt'), 'edited a')
  assert.equal(read(cwd, 'b.txt'), 'edited b')

  assert.equal(await discardFiles(cwd, ['*.md']), 'Nothing to discard')
  assert.equal(read(cwd, 'notes.md'), 'notes')
})

test('nothing outside the repository is reachable through a symlink', async t => {
  const cwd = repo(t, { 'a.js': 'a' })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
  try {
    fs.symlinkSync(outside, path.join(cwd, 'link'))
  } catch (e) {
    t.skip('symlinks are not available here')
    return
  }

  // a path that goes through the symlinked directory
  const error = await discardFiles(cwd, ['link/secret.txt'])
  assert.notEqual(error, null)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside')

  // the symlink itself is an untracked entry: deleting it leaves its target alone
  assert.equal(await discardFiles(cwd, ['link']), null)
  assert.equal(fs.existsSync(path.join(cwd, 'link')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside')
})

test('discarding a directory reverts its tracked files without touching siblings', async t => {
  const cwd = repo(t, { 'src/a.js': 'a', 'src/b.js': 'b', 'keep/c.js': 'c' })
  fs.writeFileSync(path.join(cwd, 'src/a.js'), 'a edited')
  fs.writeFileSync(path.join(cwd, 'src/b.js'), 'b edited')
  fs.writeFileSync(path.join(cwd, 'keep/c.js'), 'c edited')

  assert.equal(await discardFiles(cwd, ['src']), null)
  assert.equal(read(cwd, 'src/a.js'), 'a')
  assert.equal(read(cwd, 'src/b.js'), 'b')
  assert.equal(read(cwd, 'keep/c.js'), 'c edited')
})
