const assert = require('node:assert/strict')
const { test } = require('node:test')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createGitCore = require('../main/lib/git/core.js')
const createGitHistory = require('../main/lib/git/history.js')
const createGitRefreshGate = require('../js/sidebar/gitRefreshGate.js')
const createGitStatePersistence = require('../js/sidebar/gitStatePersistence.js')

function inside (root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function fakeChildProcess (responses) {
  const commands = []
  return {
    commands: commands,
    childProcess: {
      spawn: function (command, args, options) {
        commands.push({ command: command, args: args, cwd: options.cwd })
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = function () { process.nextTick(function () { proc.emit('close', 137) }) }
        process.nextTick(function () {
          const response = responses.shift()
          if (!response) {
            proc.emit('error', new Error('Unexpected git command'))
            return
          }
          if (response.stdout) proc.stdout.emit('data', Buffer.from(response.stdout))
          if (response.stderr) proc.stderr.emit('data', Buffer.from(response.stderr))
          proc.emit('close', response.status == null ? 0 : response.status)
        })
        return proc
      }
    }
  }
}

function coreFor (cwd, fake) {
  return createGitCore({
    fs: fs,
    path: path,
    childProcess: fake.childProcess,
    process: process,
    isPathInside: inside
  })
}

test('status resolves one repo root and reads one status snapshot without unused log processes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-status-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const fake = fakeChildProcess([
    { stdout: cwd + '\n' },
    { stdout: '## main...origin/main [ahead 2, behind 1]\n M src/app.js\n?? notes.txt\n' }
  ])
  const status = await coreFor(cwd, fake).getRepositoryStatus(cwd)
  assert.equal(status.isRepo, true)
  assert.equal(status.gitRoot, cwd)
  assert.equal(status.branch, 'main')
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 1)
  assert.equal(status.unstaged[0].fullPath, path.join(cwd, 'src/app.js'))
  assert.equal(status.untracked[0].path, 'notes.txt')
  assert.equal(fake.commands.length, 2)
  assert.deepEqual(fake.commands[0].args, ['rev-parse', '--show-toplevel'])
  assert.equal(fake.commands[1].args[0], 'status')
  assert.equal(fake.commands.some(command => command.args[0] === 'log'), false)
})

test('detached HEAD branch fallback runs only when porcelain has no branch', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-detached-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const fake = fakeChildProcess([
    { stdout: cwd + '\n' },
    { stdout: '## HEAD (no branch)\n' },
    { stdout: 'HEAD\n' }
  ])
  const status = await coreFor(cwd, fake).getRepositoryStatus(cwd)
  assert.equal(status.isRepo, true)
  assert.equal(status.branch, null)
  assert.equal(fake.commands.length, 3)
  assert.deepEqual(fake.commands[2].args, ['rev-parse', '--abbrev-ref', 'HEAD'])
})

test('graph and commit details come from a single structured log query', async () => {
  let calls = 0
  let query
  const runGit = async (cwd, args) => {
    calls++
    query = args
    return {
      status: 0,
      stdout: [
        ['* ', 'hash-one', 'one', 'First subject', 'Alice', '1700000000', 'HEAD -> main'].join('\0'),
        '|\\',
        ['| * ', 'hash-two', 'two', 'Second subject', 'Bob', '1690000000', 'topic'].join('\0')
      ].join('\n')
    }
  }
  const history = createGitHistory(runGit, () => true)
  const result = await history.getGraphData('/repo', 30)
  assert.equal(calls, 1)
  assert.deepEqual(result.commits.map(commit => commit.hash), ['hash-one', 'hash-two'])
  assert.equal(result.commits[0].refs, 'HEAD -> main')
  assert.equal(result.graph, '* one First subject\n|\\\n| * two Second subject')
  assert.ok(query.includes('--graph'))
  assert.ok(query.includes('--pretty=format:%x00%H%x00%h%x00%s%x00%an%x00%at%x00%D'))
})

test('refresh gate drops stale snapshots and runs a queued refresh before callers settle', async () => {
  const gate = createGitRefreshGate()
  const pending = []
  const applied = []
  let calls = 0
  const refresh = isCurrent => {
    calls++
    return new Promise(resolve => pending.push(resolve)).then(value => {
      if (isCurrent()) applied.push(value)
    })
  }
  const first = gate.run('workspace-a|/repo', refresh)
  const second = gate.run('workspace-a|/repo', refresh)
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(pending.length, 1)
  pending[0]('stale')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(pending.length, 2)
  pending[1]('fresh')
  await Promise.all([first, second])
  assert.deepEqual(applied, ['fresh'])
})

test('refresh gate lets a newly selected workspace proceed while discarding old work', async () => {
  const gate = createGitRefreshGate()
  const pending = new Map()
  const applied = []
  const refresh = key => isCurrent => new Promise(resolve => pending.set(key, resolve)).then(value => {
    if (isCurrent()) applied.push(value)
  })
  const oldRefresh = gate.run('workspace-a|/old', refresh('old'))
  gate.invalidate()
  const newRefresh = gate.run('workspace-b|/new', refresh('new'))
  pending.get('new')('new result')
  await newRefresh
  pending.get('old')('old result')
  await oldRefresh
  assert.deepEqual(applied, ['new result'])
})

test('deleted workspace state snapshots are canceled and captured batches recheck ownership', async () => {
  const liveWorkspaces = new Map([['workspace-a', { id: 'workspace-a' }]])
  const writes = []
  const currentWorkspaceId = 'workspace-a'
  const persistence = createGitStatePersistence({
    uiStateDB: { setGitPanelState: async (key, state) => writes.push([key, state]) },
    workspaces: { get: id => liveWorkspaces.get(id) },
    getCurrentWorkspaceId: () => currentWorkspaceId,
    delay: 60000
  })

  assert.equal(persistence.persist('workspace-a', { selected: 'captured' }), true)
  const pendingWrites = persistence.flush()
  persistence.invalidateWorkspace('workspace-a')
  liveWorkspaces.delete('workspace-a')
  await pendingWrites
  assert.equal(persistence.persist('workspace-a', { selected: 'outgoing-after-delete' }), false)
  await persistence.flush()
  assert.deepEqual(writes, [])
  assert.equal(persistence.getRevision(), 2)

  liveWorkspaces.set('workspace-a', { id: 'workspace-a' })
  persistence.workspaceAdded('workspace-a')
  assert.equal(persistence.persist('workspace-a', { selected: 'recreated' }), true)
  await persistence.flush()
  assert.deepEqual(writes, [['git:workspace-a', { selected: 'recreated' }]])
})

test('repository file paths cannot lead out of the repository through symlinks', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-resolve-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a')
  fs.writeFileSync(path.join(outside, 'target.txt'), 'outside')
  try {
    fs.symlinkSync(outside, path.join(repo, 'dirlink'))
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(repo, 'filelink'))
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'inside-link'))
  } catch (e) {
    t.skip('symlinks are not available here')
    return
  }
  const core = createGitCore({ fs, path, childProcess: require('node:child_process'), process, isPathInside: inside })
  const resolve = rel => core.resolveRepoFile(repo, rel)

  assert.equal(resolve('src/a.js'), path.join(repo, 'src', 'a.js'))
  // a file that does not exist yet is fine when its folder is inside
  assert.equal(resolve('src/new.js'), path.join(repo, 'src', 'new.js'))
  // a symlinked directory that stays inside the repository is fine too
  assert.equal(resolve('inside-link/a.js'), path.join(repo, 'src', 'a.js'))

  assert.equal(resolve('dirlink/target.txt'), null)
  assert.equal(resolve('dirlink/created.txt'), null)
  assert.equal(resolve('filelink'), null)
  assert.equal(resolve('../outside/target.txt'), null)
  assert.equal(resolve('missing-dir/file.js'), null)
})

test('a repository reached through a symlinked path still resolves its own files', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-resolve-root-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'real'))
  fs.writeFileSync(path.join(root, 'real', 'a.js'), 'a')
  try {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'))
  } catch (e) {
    t.skip('symlinks are not available here')
    return
  }
  const core = createGitCore({ fs, path, childProcess: require('node:child_process'), process, isPathInside: inside })
  assert.equal(core.resolveRepoFile(path.join(root, 'alias'), 'a.js'), path.join(root, 'real', 'a.js'))
})

test('a view may only work in the git root of its workspace or in a repository nested inside it', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'min-git-allowed-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const git = cwd => require('node:child_process').execFileSync('git', ['init', '-q'], { cwd })
  const dir = (...parts) => {
    const full = path.join(base, ...parts)
    fs.mkdirSync(full, { recursive: true })
    return full
  }
  const outer = dir('outer')
  git(outer)
  const packageDir = dir('outer', 'packages', 'web')
  const plain = dir('plain')
  const nested = dir('plain', 'nested')
  git(nested)
  const insideOuter = dir('outer', 'inner')
  git(insideOuter)
  const unrelated = dir('unrelated')
  git(unrelated)
  const core = createGitCore({ fs, path, childProcess: require('node:child_process'), process, isPathInside: inside })
  const allowed = (workspace, cwd) => core.isRepoAllowedForWorkspace(workspace, cwd)

  // the workspace is the repository, or lives inside it
  assert.equal(await allowed(outer, outer), true)
  assert.equal(await allowed(packageDir, outer), true)
  // a repository nested inside the workspace folder
  assert.equal(await allowed(plain, nested), true)

  // folders above the workspace that are not its repository's root
  assert.equal(await allowed(packageDir, path.join(outer, 'packages')), false)
  assert.equal(await allowed(packageDir, base), false)
  assert.equal(await allowed(nested, plain), false)
  assert.equal(await allowed(nested, path.dirname(base)), false)
  // a plain sub-folder of the workspace is not a repository root either
  assert.equal(await allowed(outer, path.join(outer, 'packages')), false)
  // an outer repository does not cover a workspace that has its own repository
  assert.equal(await allowed(insideOuter, outer), false)
  // unrelated repositories and missing input
  assert.equal(await allowed(outer, unrelated), false)
  assert.equal(await allowed(null, outer), false)
  assert.equal(await allowed(outer, path.join(base, 'missing')), false)
})
