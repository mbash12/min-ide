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

async function getSidebarState (key) {
  try {
    await migrationDone
    return await customDataStore.kvGet(SCOPE, key)
  } catch (e) {
    console.warn('failed to read sidebar state', e)
    return null
  }
}

async function setSidebarState (key, state) {
  try {
    await migrationDone
    await customDataStore.kvSet(SCOPE, key, state)
  } catch (e) {
    console.warn('failed to save sidebar state', e)
  }
}

async function getGitPanelState (key) {
  try {
    await migrationDone
    return await customDataStore.kvGet(SCOPE, key)
  } catch (e) {
    console.warn('failed to read git panel state', e)
    return null
  }
}

async function setGitPanelState (key, state) {
  try {
    await migrationDone
    await customDataStore.kvSet(SCOPE, key, state)
  } catch (e) {
    console.warn('failed to save git panel state', e)
  }
}

async function getFileTreeState (key) {
  try {
    await migrationDone
    return await customDataStore.kvGet(SCOPE, key)
  } catch (e) {
    console.warn('failed to read file tree state', e)
    return null
  }
}

async function setFileTreeState (key, state) {
  try {
    await migrationDone
    await customDataStore.kvSet(SCOPE, key, state)
  } catch (e) {
    console.warn('failed to save file tree state', e)
  }
}

const MAX_RECENT_SEARCHES = 15

async function getRecentFileSearches () {
  try {
    await migrationDone
    const paths = await customDataStore.kvGet(SCOPE, 'recent')
    return Array.isArray(paths) ? paths : []
  } catch (e) {
    console.warn('failed to read recent file searches', e)
    return []
  }
}

async function addRecentFileSearch (filePath) {
  try {
    let paths = await getRecentFileSearches()
    paths = paths.filter(function (p) { return p !== filePath })
    paths.unshift(filePath)
    if (paths.length > MAX_RECENT_SEARCHES) {
      paths = paths.slice(0, MAX_RECENT_SEARCHES)
    }
    await customDataStore.kvSet(SCOPE, 'recent', paths)
  } catch (e) {
    console.warn('failed to save recent file search', e)
  }
}

// Removes all persisted UI rows for a deleted workspace (sidebar, git
// panel, file tree). Keys are 'workspace:'/'git:'/'tree:' + workspace id.
async function deleteWorkspaceState (workspaceId) {
  const keys = ['workspace:' + workspaceId, 'git:' + workspaceId, 'tree:' + workspaceId]
  try {
    await customDataStore.kvDelete(SCOPE, keys[0])
  } catch (e) {
    console.warn('failed to delete sidebar state', e)
  }
  try {
    await customDataStore.kvDelete(SCOPE, keys[1])
  } catch (e) {
    console.warn('failed to delete git panel state', e)
  }
  try {
    await customDataStore.kvDelete(SCOPE, keys[2])
  } catch (e) {
    console.warn('failed to delete file tree state', e)
  }
}

module.exports = {
  getSidebarState,
  setSidebarState,
  getGitPanelState,
  setGitPanelState,
  getFileTreeState,
  setFileTreeState,
  getRecentFileSearches,
  addRecentFileSearch,
  deleteWorkspaceState
}
