/* Reusable transaction for workspace-owned rows. Statements are prepared
   once instead of reparsed for every deleted workspace. */

module.exports = function createWorkspaceCleanup (db) {
  var statements = [
    db.prepare('DELETE FROM documents WHERE workspace_id = ?'),
    db.prepare('DELETE FROM design_documents WHERE workspace_id = ?'),
    db.prepare('DELETE FROM workspace_snapshots WHERE workspace_id = ?'),
    db.prepare('DELETE FROM tab_activities WHERE workspace_id = ?')
  ]

  return function deleteWorkspaceData (workspaceId) {
    var id = String(workspaceId)
    try {
      db.exec('BEGIN')
      statements.forEach(function (statement) { statement.run(id) })
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (rollbackError) {}
      return { ok: false, error: 'Could not delete workspace data' }
    }
    return { ok: true }
  }
}
