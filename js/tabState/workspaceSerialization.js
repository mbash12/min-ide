function copyWorkspace (ws, permanent = false) {
  const result = {
    id: ws.id,
    name: ws.name,
    profileId: ws.profileId,
    path: ws.path,
    archived: ws.archived,
    activeTaskId: ws.activeTaskId,
    collapsed: ws.collapsed,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    tasks: permanent ? ws.tasks.getStringifyableState().tasks : ws.tasks.getCopyableState().tasks
  }
  if (permanent) {
    if (result.collapsed === undefined) delete result.collapsed
  } else {
    result.selectedInWindow = ws.selectedInWindow
  }
  return result
}

module.exports = copyWorkspace
