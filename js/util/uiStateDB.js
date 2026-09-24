/*
Persists UI state that doesn't belong in the session (per-window, not synced
across windows) in the central SQLite DB (kv_store, scope 'sidebar_state') via
dbService IPC: the per-workspace sidebar state (visibility, active tab, panel
width), the git panel state (collapsed sections, commit message draft, graph
scroll), the file tree state (expanded directories), and recent file searches.

The legacy Dexie/IndexedDB store is imported once on first launch.
*/

/* global indexedDB */

const customDataStore = require('util/customDataStore.js')

const SCOPE = 'sidebar_state'

/* One-time import of the legacy Dexie 'uiState' database. Each table row is
 * {key, state|paths}; they land in kv_store under the same keys, so all the
 * readers below keep working unchanged. */
async function migrateDexie () {
  try {
    if (typeof indexedDB === 'undefined') return
    const exists = await indexedDB.databases().then(function (dbs) {
      return dbs.some(function (db) { return db.name === 'uiState' })
    }).catch(function () { return false })
    if (!exists) return

    const Dexie = require('dexie')
    const legacy = new Dexie('uiState')
    legacy.version(4).stores({
      sidebarState: 'key',
      gitPanelState: 'key',
      fileTreeState: 'key',
      recentFileSearches: 'key'
    })
    await legacy.open()

    const tables = ['sidebarState', 'gitPanelState', 'fileTreeState']
    for (const table of tables) {
      const rows = await legacy.table(table).toArray()
      for (const row of rows) {
        await customDataStore.kvSet(SCOPE, row.key, row.state)
      }
    }
    const recent = await legacy.table('recentFileSearches').get('recent')
    if (recent && Array.isArray(recent.paths)) {
      await customDataStore.kvSet(SCOPE, 'recent', recent.paths)
    }
    await legacy.close()
    await Dexie.delete('uiState')
  } catch (e) {
    console.warn('failed to migrate uiState IndexedDB', e)
  }
}
/* Reads and writes wait for the import to settle so a legacy row is never
 * shadowed by an early read or clobbered by an early write. */
const migrationDone = migrateDexie()

// Reads, writes, read/modify/write operations and deletes share a per-key
// queue. A slow save can never land after that workspace's cleanup.
const pending = new Map()
function enqueue (key, operation) {
  const result = (pending.get(key) || migrationDone).then(operation)
  const settled = result.catch(function () {})
  pending.set(key, settled)
  settled.then(function () {
    if (pending.get(key) === settled) pending.delete(key)
  })
  return result
}

async function readState (key) {
  try {
    return await enqueue(key, () => customDataStore.kvGet(SCOPE, key))
  } catch (e) {
    console.warn('failed to read UI state', e)
    return null
  }
}

async function writeState (key, state) {
  try {
    // Capture at call time; panel objects may be edited while a save waits.
    const snapshot = JSON.parse(JSON.stringify(state))
    await enqueue(key, () => customDataStore.kvSet(SCOPE, key, snapshot))
  } catch (e) {
    console.warn('failed to save UI state', e)
  }
}

const MAX_RECENT_SEARCHES = 15

async function getRecentFileSearches () {
  const paths = await readState('recent')
  return Array.isArray(paths) ? paths : []
}

async function addRecentFileSearch (filePath) {
  try {
    await enqueue('recent', async function () {
      const stored = await customDataStore.kvGet(SCOPE, 'recent')
      const paths = (Array.isArray(stored) ? stored : []).filter(p => p !== filePath)
      paths.unshift(filePath)
      await customDataStore.kvSet(SCOPE, 'recent', paths.slice(0, MAX_RECENT_SEARCHES))
    })
  } catch (e) {
    console.warn('failed to save recent file search', e)
  }
}

async function deleteWorkspaceState (workspaceId) {
  await Promise.all(['workspace:', 'git:', 'tree:'].map(prefix => {
    const key = prefix + workspaceId
    return enqueue(key, () => customDataStore.kvDelete(SCOPE, key)).catch(function (e) {
      console.warn('failed to delete UI state', e)
    })
  }))
}

module.exports = {
  getSidebarState: readState,
  setSidebarState: writeState,
  getGitPanelState: readState,
  setGitPanelState: writeState,
  getFileTreeState: readState,
  setFileTreeState: writeState,
  getRecentFileSearches,
  addRecentFileSearch,
  deleteWorkspaceState
}
