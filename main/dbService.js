/* global fs, path, ipc, userDataPath, writeFileAtomic, windows, getWindowWebContents */
/* Centralized Database Service for Custom Features
Manages single-source-of-truth storage for preferences, workspace profiles,
workspace snapshots, design documents, workspace documents, and tab activity
logs.
*/

const dbFilePath = path.join(userDataPath, 'custom_app_data.db')

/* Documents deliberately stay small and local. These limits protect the
 * renderer and the AI tool from accidentally turning one note into an
 * unbounded context or database write. */
const DOCUMENT_WORKSPACE_ID_MAX_LENGTH = 200
const DOCUMENT_ID_MAX_LENGTH = 200
const DOCUMENT_TITLE_MAX_LENGTH = 200
const DOCUMENT_MARKDOWN_MAX_LENGTH = 1024 * 1024
const DOCUMENT_AI_MAX_RESULTS = 50
const DOCUMENT_AI_DEFAULT_RESULTS = 20
const DOCUMENT_AI_QUERY_MAX_LENGTH = 200
const DOCUMENT_AI_SNIPPET_MAX_LENGTH = 240

/* In-memory store backed by atomic file persistence */
let dbState = {
  version: 1,
  user_preferences: {},
  workspace_profiles: [],
  workspace_snapshots: [],
  design_documents: [],
  documents: [],
  tab_activities: []
}

function documentError (message) {
  return { ok: false, error: message }
}

function validateDocumentWorkspaceId (value) {
  if (value === null || value === undefined || (typeof value !== 'string' && typeof value !== 'number')) {
    return documentError('workspaceId is required')
  }
  const workspaceId = String(value).trim()
  if (!workspaceId) return documentError('workspaceId is required')
  if (workspaceId.length > DOCUMENT_WORKSPACE_ID_MAX_LENGTH) {
    return documentError('workspaceId is too long')
  }
  return { ok: true, value: workspaceId }
}

function validateDocumentId (value) {
  if (value === null || value === undefined || (typeof value !== 'string' && typeof value !== 'number')) {
    return documentError('document id is required')
  }
  const id = String(value).trim()
  if (!id) return documentError('document id is required')
  if (id.length > DOCUMENT_ID_MAX_LENGTH) return documentError('document id is too long')
  return { ok: true, value: id }
}

function validateDocumentTitle (value, allowDefault) {
  if (value === null || value === undefined) {
    if (allowDefault) return { ok: true, value: 'Untitled' }
    return documentError('title is required')
  }
  if (typeof value !== 'string') return documentError('title must be a string')
  const title = value.trim()
  if (!title) return documentError('title is required')
  if (title.length > DOCUMENT_TITLE_MAX_LENGTH) return documentError('title is too long')
  return { ok: true, value: title }
}

function validateDocumentMarkdown (value) {
  if (value === null || value === undefined) return documentError('markdown must be a string')
  if (typeof value !== 'string') return documentError('markdown must be a string')
  if (value.length > DOCUMENT_MARKDOWN_MAX_LENGTH) return documentError('markdown is too long')
  return { ok: true, value: value }
}

function normalizeStoredDocument (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const workspace = validateDocumentWorkspaceId(value.workspace_id)
  const id = validateDocumentId(value.id)
  if (!workspace.ok || !id.ok) return null

  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim().slice(0, DOCUMENT_TITLE_MAX_LENGTH)
    : 'Untitled'
  const markdown = typeof value.markdown === 'string'
    ? value.markdown.slice(0, DOCUMENT_MARKDOWN_MAX_LENGTH)
    : ''
  const createdAt = typeof value.created_at === 'number' && isFinite(value.created_at)
    ? value.created_at
    : 0
  const updatedAt = typeof value.updated_at === 'number' && isFinite(value.updated_at)
    ? value.updated_at
    : createdAt

  return {
    id: id.value,
    workspace_id: workspace.value,
    title: title,
    markdown: markdown,
    private: value.private === true,
    created_at: createdAt,
    updated_at: updatedAt
  }
}

function normalizeDocumentState () {
  const stored = Array.isArray(dbState.documents) ? dbState.documents : []
  dbState.documents = stored.map(normalizeStoredDocument).filter(function (document) {
    return !!document
  })
}

function loadDatabase () {
  try {
    if (fs.existsSync(dbFilePath)) {
      const raw = fs.readFileSync(dbFilePath, 'utf-8')
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw)
        dbState = Object.assign({}, dbState, parsed)
        normalizeDocumentState()
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
      normalizeDocumentState()
    }
  } catch (e) {
    console.warn('dbService: failed to load database file, starting clean', e)
    normalizeDocumentState()
  }
}

function saveDatabase () {
  try {
    writeFileAtomic.sync(dbFilePath, JSON.stringify(dbState, null, 2), {})
    return true
  } catch (e) {
    console.error('dbService: failed to save database file', e)
    return false
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

/* --- Workspace Documents --- */

function documentMetadata (document) {
  return {
    id: document.id,
    workspace_id: document.workspace_id,
    title: document.title,
    private: document.private === true,
    created_at: document.created_at,
    updated_at: document.updated_at
  }
}

function cloneDocument (document) {
  return Object.assign({}, document, { private: document.private === true })
}

function findDocumentIndex (workspaceId, id) {
  return dbState.documents.findIndex(function (document) {
    return document.workspace_id === workspaceId && document.id === id
  })
}

function newDocumentId () {
  let id
  do {
    id = 'doc-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000).toString(36)
  } while (dbState.documents.some(function (document) { return document.id === id }))
  return id
}

/* The event contains only an identity. In particular, do not add title,
 * markdown, snippets, or counts here: Docs are available to AI only after an
 * explicit tool call, and this event is solely for UI refreshes. */
function broadcastDocsChanged (workspaceId, documentId) {
  try {
    if (typeof windows === 'undefined' || !windows || typeof windows.getAll !== 'function') return
    const payload = {
      workspaceId: workspaceId,
      documentId: documentId || null
    }
    const allWindows = windows.getAll()
    if (!Array.isArray(allWindows)) return
    allWindows.forEach(function (win) {
      try {
        const contents = typeof getWindowWebContents === 'function'
          ? getWindowWebContents(win)
          : (win && win.webContents)
        if (contents && typeof contents.send === 'function') {
          contents.send('docs-changed', payload)
        }
      } catch (e) {}
    })
  } catch (e) {}
}

function documentWorkspaceAndId (workspaceId, id) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    return {
      workspaceId: workspaceId.workspaceId,
      id: workspaceId.id
    }
  }
  return { workspaceId: workspaceId, id: id }
}

function listDocuments (workspaceId) {
  const workspace = validateDocumentWorkspaceId(workspaceId)
  if (!workspace.ok) return workspace
  const documents = dbState.documents
    .filter(function (document) { return document.workspace_id === workspace.value })
    .map(documentMetadata)
  documents.sort(function (a, b) {
    return (b.updated_at - a.updated_at) || (b.created_at - a.created_at) || a.title.localeCompare(b.title)
  })
  return { ok: true, documents: documents }
}

function getDocument (workspaceId, id) {
  const identity = documentWorkspaceAndId(workspaceId, id)
  const workspace = validateDocumentWorkspaceId(identity.workspaceId)
  if (!workspace.ok) return workspace
  const documentId = validateDocumentId(identity.id)
  if (!documentId.ok) return documentId
  const index = findDocumentIndex(workspace.value, documentId.value)
  if (index < 0) return documentError('Document not found')
  return { ok: true, document: cloneDocument(dbState.documents[index]) }
}

function createDocument (workspaceId, title, markdown, options) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    const payload = workspaceId
    workspaceId = payload.workspaceId
    title = payload.title
    markdown = payload.markdown
    options = payload.options || options
  }
  const workspace = validateDocumentWorkspaceId(workspaceId)
  if (!workspace.ok) return workspace
  const validatedTitle = validateDocumentTitle(title, true)
  if (!validatedTitle.ok) return validatedTitle
  const validatedMarkdown = markdown === undefined
    ? { ok: true, value: '' }
    : validateDocumentMarkdown(markdown)
  if (!validatedMarkdown.ok) return validatedMarkdown

  const now = Date.now()
  const document = {
    id: newDocumentId(),
    workspace_id: workspace.value,
    title: validatedTitle.value,
    markdown: validatedMarkdown.value,
    private: false,
    created_at: now,
    updated_at: now
  }
  dbState.documents.push(document)
  if (!saveDatabase()) {
    dbState.documents.pop()
    return documentError('Could not save document')
  }
  if (!options || options.broadcast !== false) broadcastDocsChanged(workspace.value, document.id)
  return { ok: true, document: cloneDocument(document) }
}

function updateDocument (workspaceId, id, changes, options) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    const payload = workspaceId
    workspaceId = payload.workspaceId
    id = payload.id
    changes = payload
    options = options || payload.options
  }
  const workspace = validateDocumentWorkspaceId(workspaceId)
  if (!workspace.ok) return workspace
  const documentId = validateDocumentId(id)
  if (!documentId.ok) return documentId
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return documentError('document changes must be an object')
  }

  const hasTitle = Object.prototype.hasOwnProperty.call(changes, 'title')
  const hasMarkdown = Object.prototype.hasOwnProperty.call(changes, 'markdown')
  const hasPrivate = Object.prototype.hasOwnProperty.call(changes, 'private')
  if (!hasTitle && !hasMarkdown && !hasPrivate) {
    return documentError('At least one document field is required')
  }
  const validatedTitle = hasTitle ? validateDocumentTitle(changes.title, false) : null
  if (validatedTitle && !validatedTitle.ok) return validatedTitle
  const validatedMarkdown = hasMarkdown ? validateDocumentMarkdown(changes.markdown) : null
  if (validatedMarkdown && !validatedMarkdown.ok) return validatedMarkdown
  if (hasPrivate && typeof changes.private !== 'boolean') {
    return documentError('private must be a boolean')
  }

  const index = findDocumentIndex(workspace.value, documentId.value)
  if (index < 0) return documentError('Document not found')
  const document = dbState.documents[index]
  const previous = Object.assign({}, document)
  if (validatedTitle) document.title = validatedTitle.value
  if (validatedMarkdown) document.markdown = validatedMarkdown.value
  if (hasPrivate) document.private = changes.private
  document.updated_at = Date.now()

  if (!saveDatabase()) {
    dbState.documents[index] = previous
    return documentError('Could not save document')
  }
  if (!options || options.broadcast !== false) broadcastDocsChanged(workspace.value, document.id)
  return { ok: true, document: cloneDocument(document) }
}

function deleteDocument (workspaceId, id) {
  const identity = documentWorkspaceAndId(workspaceId, id)
  const workspace = validateDocumentWorkspaceId(identity.workspaceId)
  if (!workspace.ok) return workspace
  const documentId = validateDocumentId(identity.id)
  if (!documentId.ok) return documentId
  const index = findDocumentIndex(workspace.value, documentId.value)
  if (index < 0) return documentError('Document not found')
  const removed = dbState.documents.splice(index, 1)[0]
  if (!saveDatabase()) {
    dbState.documents.splice(index, 0, removed)
    return documentError('Could not save document')
  }
  broadcastDocsChanged(workspace.value, removed.id)
  return { ok: true }
}

function documentAiLimit (value) {
  const numeric = Number(value)
  if (!isFinite(numeric) || numeric <= 0) return DOCUMENT_AI_DEFAULT_RESULTS
  return Math.max(1, Math.min(DOCUMENT_AI_MAX_RESULTS, Math.floor(numeric)))
}

function documentSnippet (markdown, query) {
  const text = String(markdown || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const needle = String(query || '').toLowerCase()
  const index = needle ? text.toLowerCase().indexOf(needle) : 0
  const center = index < 0 ? 0 : index
  const context = Math.floor(DOCUMENT_AI_SNIPPET_MAX_LENGTH / 2)
  let start = Math.max(0, center - context)
  const end = Math.min(text.length, start + DOCUMENT_AI_SNIPPET_MAX_LENGTH)
  if (end - start < DOCUMENT_AI_SNIPPET_MAX_LENGTH) start = Math.max(0, end - DOCUMENT_AI_SNIPPET_MAX_LENGTH)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = '…' + snippet
  if (end < text.length) snippet += '…'
  return snippet.slice(0, DOCUMENT_AI_SNIPPET_MAX_LENGTH)
}

function aiDocumentUnavailable () {
  /* Do not distinguish a private record from a missing/cross-workspace one. */
  return documentError('Document not found or unavailable')
}

function listDocumentsForAI (workspaceId, options) {
  const listed = listDocuments(workspaceId)
  if (!listed.ok) return listed
  const limit = documentAiLimit(options && options.limit)
  return {
    ok: true,
    documents: listed.documents
      .filter(function (document) { return document.private !== true })
      .slice(0, limit)
  }
}

function searchDocumentsForAI (workspaceId, query, options) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    const payload = workspaceId
    workspaceId = payload.workspaceId
    query = payload.query
    options = payload
  }
  const workspace = validateDocumentWorkspaceId(workspaceId)
  if (!workspace.ok) return workspace
  if (typeof query !== 'string' || !query.trim()) return documentError('query is required')
  query = query.trim()
  if (query.length > DOCUMENT_AI_QUERY_MAX_LENGTH) return documentError('query is too long')
  const lowerQuery = query.toLowerCase()
  const limit = documentAiLimit(options && options.limit)
  const documents = dbState.documents
    .filter(function (document) {
      if (document.workspace_id !== workspace.value || document.private === true) return false
      const title = document.title.toLowerCase()
      const markdown = document.markdown.toLowerCase()
      return title.indexOf(lowerQuery) !== -1 || markdown.indexOf(lowerQuery) !== -1
    })
    .sort(function (a, b) {
      return (b.updated_at - a.updated_at) || (b.created_at - a.created_at)
    })
    .map(function (document) {
      return {
        id: document.id,
        workspace_id: document.workspace_id,
        title: document.title,
        snippet: documentSnippet(document.markdown, query),
        created_at: document.created_at,
        updated_at: document.updated_at
      }
    })
  return { ok: true, documents: documents.slice(0, limit) }
}

function getDocumentForAI (workspaceId, id) {
  const got = getDocument(workspaceId, id)
  if (!got.ok || !got.document || got.document.private === true) return aiDocumentUnavailable()
  return got
}

function createDocumentForAI (workspaceId, input) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    input = workspaceId
    workspaceId = input.workspaceId
  }
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  if (Object.prototype.hasOwnProperty.call(input, 'private')) {
    return documentError('AI cannot change document privacy')
  }
  const created = createDocument(workspaceId, input.title, input.markdown)
  if (!created.ok) return created
  return { ok: true, document: documentMetadata(created.document) }
}

function updateDocumentForAI (workspaceId, id, changes) {
  if (workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)) {
    const payload = workspaceId
    workspaceId = payload.workspaceId
    id = payload.id
    changes = payload
  }
  changes = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {}
  if (Object.prototype.hasOwnProperty.call(changes, 'private')) {
    return documentError('AI cannot change document privacy')
  }
  const got = getDocumentForAI(workspaceId, id)
  if (!got.ok) return got
  const patch = {}
  if (Object.prototype.hasOwnProperty.call(changes, 'title')) patch.title = changes.title
  if (Object.prototype.hasOwnProperty.call(changes, 'markdown')) patch.markdown = changes.markdown
  const updated = updateDocument(workspaceId, id, patch)
  if (!updated.ok) return updated
  return { ok: true, document: documentMetadata(updated.document) }
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

/* Workspace Docs are always addressed by both workspaceId and document id.
 * The renderer-facing handlers intentionally expose only the UI CRUD API;
 * AI privacy checks live in the main-only helpers below and cannot be
 * bypassed by an IPC flag. */
ipc.handle('db:listDocuments', async (event, workspaceId) => listDocuments(workspaceId))
ipc.handle('db:getDocument', async (event, data) => getDocument(data))
ipc.handle('db:createDocument', async (event, data) => {
  return createDocument(data && data.workspaceId, data && data.title)
})
ipc.handle('db:updateDocument', async (event, data) => {
  return updateDocument(data && data.workspaceId, data && data.id, data)
})
ipc.handle('db:deleteDocument', async (event, data) => deleteDocument(data))

/* Removes every row belonging to a deleted workspace: documents, designs,
snapshots and tab activities. Workspace-scoped collections share the
workspace_id key, so one sweep covers all of them. */
function deleteWorkspaceData (workspaceId) {
  const id = String(workspaceId)
  const before = {
    documents: dbState.documents.length,
    designs: dbState.design_documents.length,
    snapshots: dbState.workspace_snapshots.length,
    activities: dbState.tab_activities.length
  }
  dbState.documents = dbState.documents.filter(document => String(document.workspace_id) !== id)
  dbState.design_documents = dbState.design_documents.filter(design => String(design.workspace_id) !== id)
  dbState.workspace_snapshots = dbState.workspace_snapshots.filter(snapshot => String(snapshot.workspace_id) !== id)
  dbState.tab_activities = dbState.tab_activities.filter(activity => String(activity.workspace_id) !== id)
  saveDatabase()
  broadcastDocsChanged(id, null)
  return { ok: true, removed: before }
}

ipc.handle('db:deleteWorkspaceData', async (event, workspaceId) => deleteWorkspaceData(workspaceId))

ipc.handle('db:logTabActivity', async (event, activity) => logTabActivity(activity))
ipc.handle('db:getTabActivities', async (event, data) => getTabActivities(data && data.workspaceId, data && data.limit))

/* Used by main/agentTools.js in the concatenated main bundle. Keeping these
 * accessors out of IPC makes it impossible for a renderer caller to request
 * an AI privacy bypass. */
var minDocumentStore = {
  list: listDocuments,
  get: getDocument,
  create: createDocument,
  update: updateDocument,
  delete: deleteDocument,
  listForAI: listDocumentsForAI,
  searchForAI: searchDocumentsForAI,
  getForAI: getDocumentForAI,
  createForAI: createDocumentForAI,
  updateForAI: updateDocumentForAI
}

if (typeof global !== 'undefined') {
  global.minDocumentStore = minDocumentStore
  global.listDocumentsForAI = listDocumentsForAI
  global.searchDocumentsForAI = searchDocumentsForAI
  global.getDocumentForAI = getDocumentForAI
  global.createDocumentForAI = createDocumentForAI
  global.updateDocumentForAI = updateDocumentForAI
}
