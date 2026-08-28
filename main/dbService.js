/* global fs, path, ipc, userDataPath, writeFileAtomic */
/* Centralized Database Service for Custom Features
Manages single-source-of-truth storage for preferences, workspace profiles,
workspace snapshots, design documents, and tab activity logs.
*/

const dbFilePath = path.join(userDataPath, 'custom_app_data.db')

/* In-memory store backed by atomic file persistence */
let dbState = {
  version: 1,
  user_preferences: {},
  workspace_profiles: [],
  workspace_snapshots: [],
  design_documents: [],
  tab_activities: []
}

function loadDatabase () {
  try {
    if (fs.existsSync(dbFilePath)) {
      const raw = fs.readFileSync(dbFilePath, 'utf-8')
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw)
        dbState = Object.assign({}, dbState, parsed)
      }
    } else {
      // Legacy auto-migration from sessionRestore.json if exists
      const sessionPath = path.join(userDataPath, 'sessionRestore.json')
      if (fs.existsSync(sessionPath)) {
        try {
          const sessRaw = fs.readFileSync(sessionPath, 'utf-8')
          if (sessRaw) {
            const sessData = JSON.parse(sessRaw)
            saveSnapshot({
              id: 'initial-restore-snapshot',
              workspace_id: 'default',
              title: 'Initial Session Restore Archive',
              snapshot_data: sessData,
              created_at: Date.now()
            })
          }
        } catch (e2) {}
      }
    }
  } catch (e) {
    console.warn('dbService: failed to load database file, starting clean', e)
  }
}

function saveDatabase () {
  try {
    writeFileAtomic.sync(dbFilePath, JSON.stringify(dbState, null, 2), {})
  } catch (e) {
    console.error('dbService: failed to save database file', e)
  }
}

// Initial load
loadDatabase()

/* =====================================================================
   Database Operations
   ===================================================================== */

/* --- User Preferences --- */
function getPreference (key) {
  return dbState.user_preferences[key] || null
}

function setPreference (key, value) {
  if (!key) return null
  dbState.user_preferences[key] = {
    value: value,
    updated_at: Date.now()
  }
  saveDatabase()
  return dbState.user_preferences[key]
}

/* --- Workspace Profiles --- */
function getProfiles () {
  return dbState.workspace_profiles || []
}

function saveProfile (profile) {
  if (!profile || !profile.id) return null
  const idx = dbState.workspace_profiles.findIndex(p => p.id === profile.id)
  const updated = {
    id: profile.id,
    name: profile.name || 'Profile',
    color: profile.color || null,
    created_at: profile.created_at || Date.now()
  }
  if (idx >= 0) {
    dbState.workspace_profiles[idx] = updated
  } else {
    dbState.workspace_profiles.push(updated)
  }
  saveDatabase()
  return updated
}

function deleteProfile (profileId) {
  if (!profileId) return false
  dbState.workspace_profiles = dbState.workspace_profiles.filter(p => p.id !== profileId)
  saveDatabase()
  return true
}

/* --- Workspace Snapshots --- */
function getSnapshots (workspaceId) {
  if (!workspaceId) return dbState.workspace_snapshots
  return dbState.workspace_snapshots.filter(s => s.workspace_id === workspaceId)
}

function saveSnapshot (snapshot) {
  if (!snapshot || !snapshot.workspace_id) return null
  const id = snapshot.id || ('snapshot-' + Date.now() + '-' + Math.floor(Math.random() * 10000))
  const entry = {
    id: id,
    workspace_id: snapshot.workspace_id,
    title: snapshot.title || ('Snapshot ' + new Date().toLocaleString()),
    snapshot_data: snapshot.snapshot_data || {},
    created_at: snapshot.created_at || Date.now()
  }
  const idx = dbState.workspace_snapshots.findIndex(s => s.id === id)
  if (idx >= 0) {
    dbState.workspace_snapshots[idx] = entry
  } else {
    dbState.workspace_snapshots.push(entry)
  }
  saveDatabase()
  return entry
}

function deleteSnapshot (snapshotId) {
  if (!snapshotId) return false
  dbState.workspace_snapshots = dbState.workspace_snapshots.filter(s => s.id !== snapshotId)
  saveDatabase()
  return true
}

/* --- Design Documents --- */
function getDesigns (workspaceId) {
  if (!workspaceId) return dbState.design_documents
  return dbState.design_documents.filter(d => d.workspace_id === workspaceId)
}

function saveDesign (design) {
  if (!design || !design.title) return null
  const id = design.id || ('design-' + Date.now() + '-' + Math.floor(Math.random() * 10000))
  const entry = {
    id: id,
    workspace_id: design.workspace_id || null,
    title: design.title,
    content: design.content || {},
    created_at: design.created_at || Date.now(),
    updated_at: Date.now()
  }
  const idx = dbState.design_documents.findIndex(d => d.id === id)
  if (idx >= 0) {
    dbState.design_documents[idx] = entry
  } else {
    dbState.design_documents.push(entry)
  }
  saveDatabase()
  return entry
}

function deleteDesign (designId) {
  if (!designId) return false
  dbState.design_documents = dbState.design_documents.filter(d => d.id !== designId)
  saveDatabase()
  return true
}

/* --- Tab Activity Logs --- */
function logTabActivity (activity) {
  if (!activity || !activity.url) return null
  const entry = {
    id: 'act-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    workspace_id: activity.workspace_id || null,
    tab_id: activity.tab_id || null,
    url: activity.url,
    title: activity.title || '',
    metadata: activity.metadata || {},
    timestamp: Date.now()
  }
  dbState.tab_activities.push(entry)
  // keep last 1000 entries
  if (dbState.tab_activities.length > 1000) {
    dbState.tab_activities = dbState.tab_activities.slice(-1000)
  }
  saveDatabase()
  return entry
}

function getTabActivities (workspaceId, limit) {
  let list = dbState.tab_activities
  if (workspaceId) {
    list = list.filter(a => a.workspace_id === workspaceId)
  }
  const max = limit || 100
  return list.slice(-max)
}

/* =====================================================================
   IPC Handlers
   ===================================================================== */
ipc.handle('db:getPreference', async (event, key) => getPreference(key))
ipc.handle('db:setPreference', async (event, data) => setPreference(data && data.key, data && data.value))

ipc.handle('db:getProfiles', async () => getProfiles())
ipc.handle('db:saveProfile', async (event, profile) => saveProfile(profile))
ipc.handle('db:deleteProfile', async (event, profileId) => deleteProfile(profileId))

ipc.handle('db:getSnapshots', async (event, workspaceId) => getSnapshots(workspaceId))
ipc.handle('db:saveSnapshot', async (event, snapshot) => saveSnapshot(snapshot))
ipc.handle('db:deleteSnapshot', async (event, snapshotId) => deleteSnapshot(snapshotId))

ipc.handle('db:getDesigns', async (event, workspaceId) => getDesigns(workspaceId))
ipc.handle('db:saveDesign', async (event, design) => saveDesign(design))
ipc.handle('db:deleteDesign', async (event, designId) => deleteDesign(designId))

ipc.handle('db:logTabActivity', async (event, activity) => logTabActivity(activity))
ipc.handle('db:getTabActivities', async (event, data) => getTabActivities(data && data.workspaceId, data && data.limit))
