/*
Persists UI state that doesn't belong in the session (per-window, not synced
across windows) in IndexedDB via Dexie: currently the per-workspace sidebar
state (visibility, active tab, panel width), the git panel state (collapsed
sections, commit message draft, graph scroll) and the file tree state
(expanded directories).
*/

const Dexie = require('dexie')

const uiStateDb = new Dexie('uiState')

uiStateDb.version(1).stores({
  // key: workspace id ('_global' holds the fallback/global entry)
  sidebarState: 'key'
})

uiStateDb.version(2).stores({
  sidebarState: 'key',
  gitPanelState: 'key',
  fileTreeState: 'key'
})

uiStateDb.version(3).stores({
  sidebarState: 'key',
  gitPanelState: 'key',
  fileTreeState: 'key',
  recentFileSearches: 'key'
})

// Some installations created the DB at version 4; declaring it again
// prevents VersionError (requested version lower than existing version).
uiStateDb.version(4).stores({
  sidebarState: 'key',
  gitPanelState: 'key',
  fileTreeState: 'key',
  recentFileSearches: 'key'
})

uiStateDb.open().catch(function (e) {
  console.warn('failed to open uiStateDb', e)
})

async function getSidebarState (key) {
  try {
    const entry = await uiStateDb.sidebarState.get(key)
    return entry ? entry.state : null
  } catch (e) {
    console.warn('failed to read sidebar state', e)
    return null
  }
}

async function setSidebarState (key, state) {
  try {
    await uiStateDb.sidebarState.put({ key: key, state: state })
  } catch (e) {
    console.warn('failed to save sidebar state', e)
  }
}

async function getGitPanelState (key) {
  try {
    const entry = await uiStateDb.gitPanelState.get(key)
    return entry ? entry.state : null
  } catch (e) {
    console.warn('failed to read git panel state', e)
    return null
  }
}

async function setGitPanelState (key, state) {
  try {
    await uiStateDb.gitPanelState.put({ key: key, state: state })
  } catch (e) {
    console.warn('failed to save git panel state', e)
  }
}

async function getFileTreeState (key) {
  try {
    const entry = await uiStateDb.fileTreeState.get(key)
    return entry ? entry.state : null
  } catch (e) {
    console.warn('failed to read file tree state', e)
    return null
  }
}

async function setFileTreeState (key, state) {
  try {
    await uiStateDb.fileTreeState.put({ key: key, state: state })
  } catch (e) {
    console.warn('failed to save file tree state', e)
  }
}

const MAX_RECENT_SEARCHES = 15

async function getRecentFileSearches () {
  try {
    const entry = await uiStateDb.recentFileSearches.get('recent')
    return entry ? entry.paths : []
  } catch (e) {
    console.warn('failed to read recent file searches', e)
    return []
  }
}

async function addRecentFileSearch (filePath) {
  try {
    const entry = await uiStateDb.recentFileSearches.get('recent')
    let paths = entry ? entry.paths : []
    paths = paths.filter(function (p) { return p !== filePath })
    paths.unshift(filePath)
    if (paths.length > MAX_RECENT_SEARCHES) {
      paths = paths.slice(0, MAX_RECENT_SEARCHES)
    }
    await uiStateDb.recentFileSearches.put({ key: 'recent', paths: paths })
  } catch (e) {
    console.warn('failed to save recent file search', e)
  }
}

// Removes all persisted UI rows for a deleted workspace (sidebar, git
// panel, file tree). Keys are 'workspace:'/'git:'/'tree:' + workspace id.
async function deleteWorkspaceState (workspaceId) {
  const keys = ['workspace:' + workspaceId, 'git:' + workspaceId, 'tree:' + workspaceId]
  try {
    await uiStateDb.sidebarState.delete(keys[0])
  } catch (e) {
    console.warn('failed to delete sidebar state', e)
  }
  try {
    await uiStateDb.gitPanelState.delete(keys[1])
  } catch (e) {
    console.warn('failed to delete git panel state', e)
  }
  try {
    await uiStateDb.fileTreeState.delete(keys[2])
  } catch (e) {
    console.warn('failed to delete file tree state', e)
  }
}

module.exports = {
  db: uiStateDb,
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
