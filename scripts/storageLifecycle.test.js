const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const createDatabaseLifecycle = require('../main/lib/storage/databaseLifecycle.js')
const initializeStorageSchema = require('../main/lib/storage/schema.js')
const createScopedStore = require('../main/lib/storage/scopedStore.js')
const createWorkspaceCleanup = require('../main/lib/storage/workspaceCleanup.js')
const createSessionBackup = require('../main/lib/storage/sessionBackup.js')
const writeFileAtomic = require('write-file-atomic')

function temporaryDirectory (t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function quietLogger () {
  return { warn () {}, error () {} }
}

function createCountingDatabaseFactory () {
  let closed = 0
  function OpenDatabase (filename) {
    const database = new DatabaseSync(filename)
    return {
      exec: database.exec.bind(database),
      prepare: database.prepare.bind(database),
      close: function () {
        closed++
        database.close()
      }
    }
  }
  return { DatabaseSync: OpenDatabase, get closed () { return closed } }
}

test('busy database access closes the partial handle and leaves the database family untouched', t => {
  const directory = temporaryDirectory(t, 'min-db-busy-')
  const filename = path.join(directory, 'min.db')
  const blocker = new DatabaseSync(filename)
  blocker.exec('CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES (\'preserved\'); PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE')
  const factory = createCountingDatabaseFactory()
  const lifecycle = createDatabaseLifecycle({
    DatabaseSync: factory.DatabaseSync,
    fs: fs,
    path: path,
    logger: quietLogger()
  })

  const fallback = lifecycle.openDatabase(filename)
  assert.equal(factory.closed, 1)
  assert.deepEqual(fs.readdirSync(directory), ['min.db'])
  fallback.exec('CREATE TABLE fallback_marker (value TEXT)')
  fallback.close()

  blocker.exec('ROLLBACK')
  blocker.close()
  const reopened = new DatabaseSync(filename)
  assert.equal(reopened.prepare('SELECT value FROM marker').get().value, 'preserved')
  reopened.close()
})

test('only proven corruption quarantines the database and its WAL companions as one family', t => {
  const directory = temporaryDirectory(t, 'min-db-corrupt-')
  const filename = path.join(directory, 'min.db')
  fs.writeFileSync(filename, 'not a sqlite database')
  fs.writeFileSync(filename + '-wal', 'wal sentinel')
  fs.writeFileSync(filename + '-shm', 'shm sentinel')
  const lifecycle = createDatabaseLifecycle({
    DatabaseSync: DatabaseSync,
    fs: fs,
    path: path,
    logger: quietLogger(),
    now: () => 1234,
    random: () => 0.5
  })

  const recovered = lifecycle.openDatabase(filename)
  recovered.exec('CREATE TABLE recovered (value TEXT)')
  recovered.close()

  const quarantined = fs.readdirSync(directory).filter(name => name.includes('.corrupt-'))
  assert.deepEqual(quarantined.sort(), [
    'min.db-shm.corrupt-1234-500000',
    'min.db-wal.corrupt-1234-500000',
    'min.db.corrupt-1234-500000'
  ])
  assert.equal(fs.readFileSync(path.join(directory, 'min.db-wal.corrupt-1234-500000'), 'utf8'), 'wal sentinel')
  assert.equal(fs.readFileSync(path.join(directory, 'min.db-shm.corrupt-1234-500000'), 'utf8'), 'shm sentinel')
  const verify = new DatabaseSync(filename)
  assert.equal(verify.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('recovered').name, 'recovered')
  verify.close()
})

test('session backup versioning prevents a staged async save from replacing a later sync save', async t => {
  const directory = temporaryDirectory(t, 'min-session-backup-')
  let releaseCallback
  const delayedWriter = function (filename, data, options, callback) {
    writeFileAtomic(filename, data, options, error => { releaseCallback = () => callback(error) })
  }
  delayedWriter.sync = writeFileAtomic.sync
  const backup = createSessionBackup({
    fs: fs,
    path: path,
    userDataPath: directory,
    writeFileAtomic: delayedWriter,
    process: process,
    logger: quietLogger(),
    now: () => 42,
    random: () => 0.25
  })

  const oldSave = backup.save({ version: 3, state: { selected: 'old' }, saveTime: 1 })
  // the staged write finishes on the file system's schedule: wait for it instead of guessing a delay
  for (let waited = 0; typeof releaseCallback !== 'function' && waited < 5000; waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(typeof releaseCallback, 'function')

  backup.saveSync({ version: 3, state: { selected: 'new' }, saveTime: 2 })
  releaseCallback()
  assert.deepEqual(await oldSave, { ok: true, superseded: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(backup.path, 'utf8')), {
    version: 3,
    state: { selected: 'new' },
    saveTime: 2
  })
  assert.deepEqual(fs.readdirSync(directory), ['sessionRestore.json'])
})

test('async session saves preserve existing backup permissions', async t => {
  const directory = temporaryDirectory(t, 'min-session-mode-')
  const backup = createSessionBackup({
    fs: fs,
    path: path,
    userDataPath: directory,
    writeFileAtomic: writeFileAtomic,
    process: process,
    logger: quietLogger()
  })
  backup.saveSync({ version: 3, state: {}, saveTime: 1 })
  fs.chmodSync(backup.path, 0o600)

  assert.deepEqual(await backup.save({ version: 3, state: { fresh: true }, saveTime: 2 }), { ok: true })
  assert.equal(fs.statSync(backup.path).mode & 0o777, 0o600)
  assert.equal(JSON.parse(fs.readFileSync(backup.path, 'utf8')).state.fresh, true)
})

test('scoped state statements are prepared once and workspace cleanup preserves unrelated data', t => {
  const directory = temporaryDirectory(t, 'min-storage-')
  const database = new DatabaseSync(path.join(directory, 'min.db'))
  t.after(() => database.close())
  initializeStorageSchema(database)

  let prepareCount = 0
  const countedDb = {
    exec: database.exec.bind(database),
    prepare: function (sql) {
      prepareCount++
      return database.prepare(sql)
    }
  }
  let providerChanges = 0
  const scoped = createScopedStore(countedDb, {
    scopes: ['workspace_state', 'provider_config'],
    keepActivities: 1000,
    parseJson: function (value, fallback) {
      try { return JSON.parse(value) } catch (error) { return fallback }
    },
    onProviderConfigChanged: function () { providerChanges++ }
  })

  assert.equal(prepareCount, 8)
  assert.equal(scoped.kvSet('workspace_state', 'selected', { id: 'a' }), true)
  assert.deepEqual(scoped.kvGet('workspace_state', 'selected'), { id: 'a' })
  assert.deepEqual(scoped.kvList('workspace_state'), { selected: { id: 'a' } })
  assert.equal(scoped.kvSet('invalid', 'selected', {}), false)
  scoped.kvSet('provider_config', 'model', 'model-a')
  scoped.kvDelete('provider_config', 'model')
  assert.equal(providerChanges, 2)

  database.exec(`
    INSERT INTO documents VALUES ('doc-a', 'a', 'A', 'a', 0, 1, 1);
    INSERT INTO documents VALUES ('doc-b', 'b', 'B', 'b', 0, 1, 1);
    INSERT INTO design_documents VALUES ('design-a', 'a', 'A', '{}', 1, 1);
    INSERT INTO design_documents VALUES ('design-b', 'b', 'B', '{}', 1, 1);
    INSERT INTO workspace_snapshots VALUES ('snapshot-a', 'a', 'A', '{}', 1);
    INSERT INTO workspace_snapshots VALUES ('snapshot-b', 'b', 'B', '{}', 1);
    INSERT INTO notes VALUES ('note-global', 'Global', 'keep', 1, 1);
    INSERT INTO tab_activities VALUES ('activity-a', 'a', 'ta', 'https://a.test', 'A', '{}', 1);
    INSERT INTO tab_activities VALUES ('activity-b', 'b', 'tb', 'https://b.test', 'B', '{}', 1);
  `)
  const cleanup = createWorkspaceCleanup(countedDb)
  assert.equal(prepareCount, 12)
  assert.deepEqual(cleanup('a'), { ok: true })
  assert.deepEqual(cleanup('a'), { ok: true })
  assert.equal(prepareCount, 12)
  assert.equal(database.prepare('SELECT count(*) AS count FROM documents WHERE workspace_id = ?').get('a').count, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM documents WHERE workspace_id = ?').get('b').count, 1)
  assert.equal(database.prepare('SELECT count(*) AS count FROM design_documents WHERE workspace_id = ?').get('a').count, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM workspace_snapshots WHERE workspace_id = ?').get('a').count, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM tab_activities WHERE workspace_id = ?').get('a').count, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM notes').get().count, 1)
})

test('workspace cleanup rolls back earlier deletes when a later table fails', t => {
  const directory = temporaryDirectory(t, 'min-storage-rollback-')
  const database = new DatabaseSync(path.join(directory, 'min.db'))
  t.after(() => database.close())
  initializeStorageSchema(database)
  database.exec("INSERT INTO documents VALUES ('doc-a', 'a', 'A', 'a', 0, 1, 1)")
  const cleanup = createWorkspaceCleanup(database)
  database.exec('DROP TABLE design_documents')

  assert.deepEqual(cleanup('a'), { ok: false, error: 'Could not delete workspace data' })
  assert.equal(database.prepare('SELECT count(*) AS count FROM documents WHERE workspace_id = ?').get('a').count, 1)
})
