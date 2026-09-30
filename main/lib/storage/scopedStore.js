/* Prepared statements for small main-process stores that share the base
   database: tab activity and scoped JSON key/value state. */

module.exports = function createScopedStore (db, options) {
  var scopes = new Set(options.scopes)
  var parseJson = options.parseJson
  var keepActivities = options.keepActivities
  var onProviderConfigChanged = options.onProviderConfigChanged

  var actInsertStmt = db.prepare('INSERT INTO tab_activities (id, workspace_id, tab_id, url, title, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
  var actAllStmt = db.prepare('SELECT * FROM tab_activities ORDER BY timestamp DESC LIMIT ?')
  var actWsStmt = db.prepare('SELECT * FROM tab_activities WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?')
  var actPruneStmt = db.prepare('DELETE FROM tab_activities WHERE id NOT IN (SELECT id FROM tab_activities ORDER BY timestamp DESC LIMIT ?)')
  var kvGetStmt = db.prepare('SELECT value FROM kv_store WHERE scope = ? AND key = ?')
  var kvSetStmt = db.prepare('INSERT OR REPLACE INTO kv_store (scope, key, value, updated_at) VALUES (?, ?, ?, ?)')
  var kvDelStmt = db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?')
  var kvListStmt = db.prepare('SELECT key, value FROM kv_store WHERE scope = ?')
  var activityPruneCounter = 0
  var ACTIVITY_PRUNE_EVERY = 50

  function validScope (scope) {
    return typeof scope === 'string' && scopes.has(scope)
  }

  function logTabActivity (activity) {
    if (!activity || !activity.url) return null
    var entry = {
      id: 'act-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      workspace_id: activity.workspace_id ? String(activity.workspace_id) : null,
      tab_id: activity.tab_id ? String(activity.tab_id) : null,
      url: activity.url,
      title: activity.title || '',
      metadata: activity.metadata || {},
      timestamp: Date.now()
    }
    actInsertStmt.run(entry.id, entry.workspace_id, entry.tab_id, entry.url, entry.title, JSON.stringify(entry.metadata), entry.timestamp)
    if (++activityPruneCounter >= ACTIVITY_PRUNE_EVERY) {
      activityPruneCounter = 0
      actPruneStmt.run(keepActivities)
    }
    return entry
  }

  function getTabActivities (workspaceId, limit) {
    var max = limit || 100
    var rows = workspaceId
      ? actWsStmt.all(String(workspaceId), max)
      : actAllStmt.all(max)
    return rows.map(function (row) {
      return Object.assign({}, row, { metadata: parseJson(row.metadata, {}) })
    }).reverse()
  }

  function kvGet (scope, key) {
    if (!validScope(scope) || !key) return null
    var row = kvGetStmt.get(scope, String(key))
    return row ? parseJson(row.value, null) : null
  }

  function kvSet (scope, key, value) {
    if (!validScope(scope) || !key) return false
    kvSetStmt.run(scope, String(key), JSON.stringify(value === undefined ? null : value), Date.now())
    if (scope === 'provider_config') onProviderConfigChanged()
    return true
  }

  function kvDelete (scope, key) {
    if (!validScope(scope) || !key) return false
    kvDelStmt.run(scope, String(key))
    if (scope === 'provider_config') onProviderConfigChanged()
    return true
  }

  function kvList (scope) {
    if (!validScope(scope)) return {}
    var out = {}
    kvListStmt.all(scope).forEach(function (row) {
      out[row.key] = parseJson(row.value, null)
    })
    return out
  }

  return {
    logTabActivity: logTabActivity,
    getTabActivities: getTabActivities,
    kvGet: kvGet,
    kvSet: kvSet,
    kvDelete: kvDelete,
    kvList: kvList
  }
}
