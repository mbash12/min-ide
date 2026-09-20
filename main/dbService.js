/* global fs, path, ipc, userDataPath, windows, getWindowWebContents */
/* Centralized Database Service for Custom Features
Single-source-of-truth storage backed by SQLite (node:sqlite, WAL) for
preferences, workspace profiles, workspace snapshots, design documents,
workspace documents, notes, tab activity logs, and a scoped key-value store
covering workspace/task/tab extra state, sidebar and tile state, and AI
provider configuration.
*/

const { DatabaseSync } = require('node:sqlite')

const dbFilePath = path.join(userDataPath, 'min.db')
const legacyDbFilePath = path.join(userDataPath, 'custom_app_data.db')

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
const TAB_ACTIVITY_KEEP = 1000

const KV_SCOPES = [
  'workspace_state',
  'task_extra_state',
  'tab_extra_metadata',
  'sidebar_state',
  'tile_state',
  'ai_config',
  'provider_config'
]

const db = new DatabaseSync(dbFilePath)
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  snapshot_data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_workspace ON workspace_snapshots(workspace_id);
CREATE TABLE IF NOT EXISTS design_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_designs_workspace ON design_documents(workspace_id);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tab_activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  tab_id TEXT,
  url TEXT NOT NULL,
  title TEXT,
  metadata TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_workspace ON tab_activities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON tab_activities(timestamp);
CREATE TABLE IF NOT EXISTS kv_store (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
`)

/* One-time import of the legacy JSON store (custom_app_data.db). The file is
 * kept as <name>.migrated so a rollback only requires deleting min.db. */
function migrateLegacyJson () {
  let legacy
  try {
    if (!fs.existsSync(legacyDbFilePath)) return
    const raw = fs.readFileSync(legacyDbFilePath, 'utf-8')
    if (!raw || !raw.trim()) return
    legacy = JSON.parse(raw)
    if (!legacy || typeof legacy !== 'object') return
  } catch (e) {
    return
  }

  try {
    db.exec('BEGIN')
    const now = Date.now()
    const prefStmt = db.prepare('INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)')
    for (const key of Object.keys(legacy.user_preferences || {})) {
      const entry = legacy.user_preferences[key]
      const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
      const updated = entry && typeof entry === 'object' && isFinite(entry.updated_at) ? entry.updated_at : now
      prefStmt.run(key, JSON.stringify(value), updated)
    }
    const profileStmt = db.prepare('INSERT OR REPLACE INTO workspace_profiles (id, name, color, created_at) VALUES (?, ?, ?, ?)')
    for (const p of legacy.workspace_profiles || []) {
      if (!p || !p.id) continue
      profileStmt.run(String(p.id), String(p.name || 'Profile'), p.color || null, isFinite(p.created_at) ? p.created_at : now)
    }
    const snapshotStmt = db.prepare('INSERT OR REPLACE INTO workspace_snapshots (id, workspace_id, title, snapshot_data, created_at) VALUES (?, ?, ?, ?, ?)')
    for (const s of legacy.workspace_snapshots || []) {
      if (!s || !s.id) continue
      snapshotStmt.run(String(s.id), String(s.workspace_id || ''), s.title || null, JSON.stringify(s.snapshot_data || {}), isFinite(s.created_at) ? s.created_at : now)
    }
    const designStmt = db.prepare('INSERT OR REPLACE INTO design_documents (id, workspace_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const d of legacy.design_documents || []) {
      if (!d || !d.id) continue
      designStmt.run(String(d.id), d.workspace_id ? String(d.workspace_id) : null, String(d.title || ''), JSON.stringify(d.content || {}), isFinite(d.created_at) ? d.created_at : now, isFinite(d.updated_at) ? d.updated_at : now)
    }
    const docStmt = db.prepare('INSERT OR REPLACE INTO documents (id, workspace_id, title, markdown, private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const d of legacy.documents || []) {
      const doc = normalizeStoredDocument(d)
      if (!doc) continue
      docStmt.run(doc.id, doc.workspace_id, doc.title, doc.markdown, doc.private ? 1 : 0, doc.created_at, doc.updated_at)
    }
    const noteStmt = db.prepare('INSERT OR REPLACE INTO notes (id, title, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const n of legacy.notes || []) {
      const note = normalizeStoredNote(n)
      if (!note) continue
      noteStmt.run(note.id, note.title, note.markdown, note.created_at, note.updated_at)
    }
    const actStmt = db.prepare('INSERT OR REPLACE INTO tab_activities (id, workspace_id, tab_id, url, title, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const a of legacy.tab_activities || []) {
      if (!a || !a.url) continue
      actStmt.run(String(a.id || ('act-' + Math.random().toString(36).slice(2))), a.workspace_id ? String(a.workspace_id) : null, a.tab_id ? String(a.tab_id) : null, String(a.url), a.title || '', JSON.stringify(a.metadata || {}), isFinite(a.timestamp) ? a.timestamp : now)
    }
    db.exec('COMMIT')
    fs.renameSync(legacyDbFilePath, legacyDbFilePath + '.migrated')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch (e2) {}
    console.warn('dbService: legacy JSON migration failed', e)
  }
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
    private: value.private === true || value.private === 1,
    created_at: createdAt,
    updated_at: updatedAt
  }
}

function normalizeStoredNote (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = validateDocumentId(value.id)
  if (!id.ok) return null

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
    title: title,
    markdown: markdown,
    created_at: createdAt,
    updated_at: updatedAt
  }
}

// Initial migration of any legacy JSON state
migrateLegacyJson()

/* =====================================================================
   Database Operations
   ===================================================================== */

function parseJson (text, fallback) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return fallback
  }
}

/* --- User Preferences --- */
const prefGetStmt = db.prepare('SELECT value FROM user_preferences WHERE key = ?')
const prefSetStmt = db.prepare('INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)')

function getPreference (key) {
  const row = prefGetStmt.get(key)
  if (!row) return null
  return { value: parseJson(row.value, null), updated_at: row.updated_at }
}

function setPreference (key, value) {
  if (!key) return null
  const entry = { value: value, updated_at: Date.now() }
  prefSetStmt.run(key, JSON.stringify(value), entry.updated_at)
  return entry
}

/* --- Workspace Profiles --- */
const profileAllStmt = db.prepare('SELECT * FROM workspace_profiles')
const profileSetStmt = db.prepare('INSERT OR REPLACE INTO workspace_profiles (id, name, color, created_at) VALUES (?, ?, ?, ?)')
const profileDelStmt = db.prepare('DELETE FROM workspace_profiles WHERE id = ?')

function getProfiles () {
  return profileAllStmt.all()
}

function saveProfile (profile) {
  if (!profile || !profile.id) return null
  const updated = {
    id: String(profile.id),
    name: profile.name || 'Profile',
    color: profile.color || null,
    created_at: profile.created_at || Date.now()
  }
  profileSetStmt.run(updated.id, updated.name, updated.color, updated.created_at)
  return updated
}

function deleteProfile (profileId) {
  if (!profileId) return false
  profileDelStmt.run(String(profileId))
  return true
}

/* --- Workspace Snapshots --- */
const snapshotAllStmt = db.prepare('SELECT * FROM workspace_snapshots')
const snapshotWsStmt = db.prepare('SELECT * FROM workspace_snapshots WHERE workspace_id = ?')
const snapshotSetStmt = db.prepare('INSERT OR REPLACE INTO workspace_snapshots (id, workspace_id, title, snapshot_data, created_at) VALUES (?, ?, ?, ?, ?)')
const snapshotDelStmt = db.prepare('DELETE FROM workspace_snapshots WHERE id = ?')

function getSnapshots (workspaceId) {
  const rows = workspaceId ? snapshotWsStmt.all(String(workspaceId)) : snapshotAllStmt.all()
  return rows.map(function (row) {
    return Object.assign({}, row, { snapshot_data: parseJson(row.snapshot_data, {}) })
  })
}

function saveSnapshot (snapshot) {
  if (!snapshot || !snapshot.workspace_id) return null
  const id = snapshot.id || ('snapshot-' + Date.now() + '-' + Math.floor(Math.random() * 10000))
  const entry = {
    id: String(id),
    workspace_id: String(snapshot.workspace_id),
    title: snapshot.title || ('Snapshot ' + new Date().toLocaleString()),
    snapshot_data: snapshot.snapshot_data || {},
    created_at: snapshot.created_at || Date.now()
  }
  snapshotSetStmt.run(entry.id, entry.workspace_id, entry.title, JSON.stringify(entry.snapshot_data), entry.created_at)
  return entry
}

function deleteSnapshot (snapshotId) {
  if (!snapshotId) return false
  snapshotDelStmt.run(String(snapshotId))
  return true
}

/* --- Design Documents --- */
const designAllStmt = db.prepare('SELECT * FROM design_documents')
const designWsStmt = db.prepare('SELECT * FROM design_documents WHERE workspace_id = ?')
const designSetStmt = db.prepare('INSERT OR REPLACE INTO design_documents (id, workspace_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
const designDelStmt = db.prepare('DELETE FROM design_documents WHERE id = ?')

function getDesigns (workspaceId) {
  const rows = workspaceId ? designWsStmt.all(String(workspaceId)) : designAllStmt.all()
  return rows.map(function (row) {
    return Object.assign({}, row, { content: parseJson(row.content, {}) })
  })
}

function saveDesign (design) {
  if (!design || !design.title) return null
  const id = design.id || ('design-' + Date.now() + '-' + Math.floor(Math.random() * 10000))
  const entry = {
    id: String(id),
    workspace_id: design.workspace_id ? String(design.workspace_id) : null,
    title: design.title,
    content: design.content || {},
    created_at: design.created_at || Date.now(),
    updated_at: Date.now()
  }
  designSetStmt.run(entry.id, entry.workspace_id, entry.title, JSON.stringify(entry.content), entry.created_at, entry.updated_at)
  return entry
}

function deleteDesign (designId) {
  if (!designId) return false
  designDelStmt.run(String(designId))
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

function rowToDocument (row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    markdown: row.markdown,
    private: row.private === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

const docListStmt = db.prepare('SELECT * FROM documents WHERE workspace_id = ?')
const docGetStmt = db.prepare('SELECT * FROM documents WHERE workspace_id = ? AND id = ?')
const docInsertStmt = db.prepare('INSERT INTO documents (id, workspace_id, title, markdown, private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
const docUpdateStmt = db.prepare('UPDATE documents SET title = ?, markdown = ?, private = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
const docDeleteStmt = db.prepare('DELETE FROM documents WHERE workspace_id = ? AND id = ?')
const docIdCheckStmt = db.prepare('SELECT 1 FROM documents WHERE id = ?')

function newDocumentId () {
  let id
  do {
    id = 'doc-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000).toString(36)
  } while (docIdCheckStmt.get(id))
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
  const documents = docListStmt.all(workspace.value).map(documentMetadata)
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
  const row = docGetStmt.get(workspace.value, documentId.value)
  if (!row) return documentError('Document not found')
  return { ok: true, document: cloneDocument(rowToDocument(row)) }
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
  try {
    docInsertStmt.run(document.id, document.workspace_id, document.title, document.markdown, 0, document.created_at, document.updated_at)
  } catch (e) {
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

  const row = docGetStmt.get(workspace.value, documentId.value)
  if (!row) return documentError('Document not found')
  const document = rowToDocument(row)
  if (validatedTitle) document.title = validatedTitle.value
  if (validatedMarkdown) document.markdown = validatedMarkdown.value
  if (hasPrivate) document.private = changes.private
  document.updated_at = Date.now()

  try {
    docUpdateStmt.run(document.title, document.markdown, document.private ? 1 : 0, document.updated_at, workspace.value, documentId.value)
  } catch (e) {
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
  const row = docGetStmt.get(workspace.value, documentId.value)
  if (!row) return documentError('Document not found')
  docDeleteStmt.run(workspace.value, documentId.value)
  broadcastDocsChanged(workspace.value, row.id)
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
  const documents = docListStmt.all(workspace.value)
    .map(rowToDocument)
    .filter(function (document) {
      if (document.private === true) return false
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
  changes = changes && typeof changes === 'object' ? changes : {}
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

/* --- Global Notes --- */

/* Notes are global: they carry no workspace_id, so workspace deletion never
 * touches them, and the workspace switch does not change the list. They are
 * also user-only on purpose - this section deliberately has no ForAI helpers
 * and the collection is never exposed through minDocumentStore or the agent
 * tools, so there is no code path an AI session could use to read one. */

function noteMetadata (note) {
  return {
    id: note.id,
    title: note.title,
    created_at: note.created_at,
    updated_at: note.updated_at
  }
}

function cloneNote (note) {
  return Object.assign({}, note)
}

const noteListStmt = db.prepare('SELECT * FROM notes')
const noteGetStmt = db.prepare('SELECT * FROM notes WHERE id = ?')
const noteInsertStmt = db.prepare('INSERT INTO notes (id, title, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
const noteUpdateStmt = db.prepare('UPDATE notes SET title = ?, markdown = ?, updated_at = ? WHERE id = ?')
const noteDeleteStmt = db.prepare('DELETE FROM notes WHERE id = ?')
const noteIdCheckStmt = db.prepare('SELECT 1 FROM notes WHERE id = ?')

function newNoteId () {
  let id
  do {
    id = 'note-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000).toString(36)
  } while (noteIdCheckStmt.get(id))
  return id
}

/* The event contains only an identity, never title or markdown: it exists so
 * open note lists can refresh, not to move note content between processes. */
function broadcastNotesChanged (noteId) {
  try {
    if (typeof windows === 'undefined' || !windows || typeof windows.getAll !== 'function') return
    const payload = { noteId: noteId || null }
    const allWindows = windows.getAll()
    if (!Array.isArray(allWindows)) return
    allWindows.forEach(function (win) {
      try {
        const contents = typeof getWindowWebContents === 'function'
          ? getWindowWebContents(win)
          : (win && win.webContents)
        if (contents && typeof contents.send === 'function') {
          contents.send('notes-changed', payload)
        }
      } catch (e) {}
    })
  } catch (e) {}
}

function noteIdFromArg (value, id) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.id
  }
  return value !== undefined ? value : id
}

function listNotes () {
  const notes = noteListStmt.all().map(noteMetadata)
  notes.sort(function (a, b) {
    return (b.updated_at - a.updated_at) || (b.created_at - a.created_at) || a.title.localeCompare(b.title)
  })
  return { ok: true, notes: notes }
}

function getNote (value, id) {
  const noteId = validateDocumentId(noteIdFromArg(value, id))
  if (!noteId.ok) return noteId
  const row = noteGetStmt.get(noteId.value)
  if (!row) return documentError('Note not found')
  return { ok: true, note: cloneNote(row) }
}

function createNote (value, markdown) {
  let title = value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    title = value.title
    markdown = value.markdown
  }
  const validatedTitle = validateDocumentTitle(title, true)
  if (!validatedTitle.ok) return validatedTitle
  const validatedMarkdown = markdown === undefined
    ? { ok: true, value: '' }
    : validateDocumentMarkdown(markdown)
  if (!validatedMarkdown.ok) return validatedMarkdown

  const now = Date.now()
  const note = {
    id: newNoteId(),
    title: validatedTitle.value,
    markdown: validatedMarkdown.value,
    created_at: now,
    updated_at: now
  }
  try {
    noteInsertStmt.run(note.id, note.title, note.markdown, note.created_at, note.updated_at)
  } catch (e) {
    return documentError('Could not save note')
  }
  broadcastNotesChanged(note.id)
  return { ok: true, note: cloneNote(note) }
}

function updateNote (value, id, changes) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const payload = value
    id = payload.id
    changes = payload
  } else if (id && typeof id === 'object' && !Array.isArray(id)) {
    changes = id
    id = value
  }
  const noteId = validateDocumentId(id)
  if (!noteId.ok) return noteId
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return documentError('note changes must be an object')
  }

  const hasTitle = Object.prototype.hasOwnProperty.call(changes, 'title')
  const hasMarkdown = Object.prototype.hasOwnProperty.call(changes, 'markdown')
  if (!hasTitle && !hasMarkdown) {
    return documentError('At least one note field is required')
  }
  const validatedTitle = hasTitle ? validateDocumentTitle(changes.title, false) : null
  if (validatedTitle && !validatedTitle.ok) return validatedTitle
  const validatedMarkdown = hasMarkdown ? validateDocumentMarkdown(changes.markdown) : null
  if (validatedMarkdown && !validatedMarkdown.ok) return validatedMarkdown

  const row = noteGetStmt.get(noteId.value)
  if (!row) return documentError('Note not found')
  const title = validatedTitle ? validatedTitle.value : row.title
  const markdownValue = validatedMarkdown ? validatedMarkdown.value : row.markdown
  const updatedAt = Date.now()

  try {
    noteUpdateStmt.run(title, markdownValue, updatedAt, noteId.value)
  } catch (e) {
    return documentError('Could not save note')
  }
  broadcastNotesChanged(noteId.value)
  return { ok: true, note: cloneNote({ id: noteId.value, title: title, markdown: markdownValue, created_at: row.created_at, updated_at: updatedAt }) }
}

function deleteNote (value, id) {
  const noteId = validateDocumentId(noteIdFromArg(value, id))
  if (!noteId.ok) return noteId
  const row = noteGetStmt.get(noteId.value)
  if (!row) return documentError('Note not found')
  noteDeleteStmt.run(noteId.value)
  broadcastNotesChanged(row.id)
  return { ok: true }
}

/* --- Tab Activity Logs --- */
const actInsertStmt = db.prepare('INSERT INTO tab_activities (id, workspace_id, tab_id, url, title, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
const actAllStmt = db.prepare('SELECT * FROM tab_activities ORDER BY timestamp DESC LIMIT ?')
const actWsStmt = db.prepare('SELECT * FROM tab_activities WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?')
const actPruneStmt = db.prepare('DELETE FROM tab_activities WHERE id NOT IN (SELECT id FROM tab_activities ORDER BY timestamp DESC LIMIT ?)')

function logTabActivity (activity) {
  if (!activity || !activity.url) return null
  const entry = {
    id: 'act-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    workspace_id: activity.workspace_id ? String(activity.workspace_id) : null,
    tab_id: activity.tab_id ? String(activity.tab_id) : null,
    url: activity.url,
    title: activity.title || '',
    metadata: activity.metadata || {},
    timestamp: Date.now()
  }
  actInsertStmt.run(entry.id, entry.workspace_id, entry.tab_id, entry.url, entry.title, JSON.stringify(entry.metadata), entry.timestamp)
  // keep the last N entries
  actPruneStmt.run(TAB_ACTIVITY_KEEP)
  return entry
}

function getTabActivities (workspaceId, limit) {
  const max = limit || 100
  const rows = workspaceId
    ? actWsStmt.all(String(workspaceId), max)
    : actAllStmt.all(max)
  return rows.map(function (row) {
    return Object.assign({}, row, { metadata: parseJson(row.metadata, {}) })
  }).reverse()
}

/* --- Scoped key-value store ---
   Covers the remaining blueprint entities: workspace_state, task_extra_state,
   tab_extra_metadata, sidebar_state, tile_state, ai_config, provider_config. */
const kvGetStmt = db.prepare('SELECT value FROM kv_store WHERE scope = ? AND key = ?')
const kvSetStmt = db.prepare('INSERT OR REPLACE INTO kv_store (scope, key, value, updated_at) VALUES (?, ?, ?, ?)')
const kvDelStmt = db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?')
const kvListStmt = db.prepare('SELECT key, value FROM kv_store WHERE scope = ?')

function validScope (scope) {
  return typeof scope === 'string' && KV_SCOPES.includes(scope)
}

function kvGet (scope, key) {
  if (!validScope(scope) || !key) return null
  const row = kvGetStmt.get(scope, String(key))
  return row ? parseJson(row.value, null) : null
}

function kvSet (scope, key, value) {
  if (!validScope(scope) || !key) return false
  kvSetStmt.run(scope, String(key), JSON.stringify(value === undefined ? null : value), Date.now())
  return true
}

function kvDelete (scope, key) {
  if (!validScope(scope) || !key) return false
  kvDelStmt.run(scope, String(key))
  return true
}

function kvList (scope) {
  if (!validScope(scope)) return {}
  const out = {}
  kvListStmt.all(scope).forEach(function (row) {
    out[row.key] = parseJson(row.value, null)
  })
  return out
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

/* Global Notes are user-only by design. There are intentionally no AI-facing
 * accessors for this collection anywhere in the bundle, so the only callers
 * these handlers can ever have are the notes page and the notes panel. */
ipc.handle('db:listNotes', async () => listNotes())
ipc.handle('db:getNote', async (event, data) => getNote(data))
ipc.handle('db:createNote', async (event, data) => {
  return createNote(data && data.title, data && data.markdown)
})
ipc.handle('db:updateNote', async (event, data) => updateNote(data))
ipc.handle('db:deleteNote', async (event, data) => deleteNote(data))

/* Removes every row belonging to a deleted workspace: documents, designs,
snapshots and tab activities. Workspace-scoped collections share the
workspace_id key, so one sweep covers all of them. */
function deleteWorkspaceData (workspaceId) {
  const id = String(workspaceId)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM documents WHERE workspace_id = ?').run(id)
    db.prepare('DELETE FROM design_documents WHERE workspace_id = ?').run(id)
    db.prepare('DELETE FROM workspace_snapshots WHERE workspace_id = ?').run(id)
    db.prepare('DELETE FROM tab_activities WHERE workspace_id = ?').run(id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
  }
  broadcastDocsChanged(id, null)
  return { ok: true }
}

ipc.handle('db:deleteWorkspaceData', async (event, workspaceId) => deleteWorkspaceData(workspaceId))

ipc.handle('db:logTabActivity', async (event, activity) => logTabActivity(activity))
ipc.handle('db:getTabActivities', async (event, data) => getTabActivities(data && data.workspaceId, data && data.limit))

ipc.handle('db:kvGet', async (event, data) => kvGet(data && data.scope, data && data.key))
ipc.handle('db:kvSet', async (event, data) => kvSet(data && data.scope, data && data.key, data && data.value))
ipc.handle('db:kvDelete', async (event, data) => kvDelete(data && data.scope, data && data.key))
ipc.handle('db:kvList', async (event, scope) => kvList(scope))

/* Sync variants for callers that cannot await (session save on unload). */
ipc.on('db:kvSetSync', function (event, data) {
  event.returnValue = kvSet(data && data.scope, data && data.key, data && data.value)
})
ipc.on('db:kvGetSync', function (event, data) {
  event.returnValue = kvGet(data && data.scope, data && data.key)
})

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
