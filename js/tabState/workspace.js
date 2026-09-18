const TaskList = require('tabState/task.js')
const TabList = require('tabState/tab.js')
const TabStack = require('tabRestore.js')

// Fork extension of upstream Min's TaskList (js/tabState/task.js, kept
// verbatim from upstream). WorkspaceList adds the fork's fields (profileId,
// path, archived) and emits both task-* and workspace-* events so older
// task-aware consumers keep working. Upstream merges touch task.js, not
// this file.

class WorkspaceList extends TaskList {
  constructor () {
    super()
  }

  get workspaces () { return this.tasks }
  set workspaces (v) { this.tasks = v }

  add (workspace, index, emit) {
    if (workspace === undefined) workspace = {}
    const id = super.add(Object.assign({}, workspace, {
      profileId: workspace.profileId || null,
      path: workspace.path || null,
      archived: !!workspace.archived
    }), (index === undefined || index === null) ? undefined : index, false)
    const newWorkspace = this.get(id)
    if (emit === undefined || emit) {
      const payload = Object.assign({}, newWorkspace, { tabHistory: workspace.tabHistory, tabs: workspace.tabs })
      this.emit('workspace-added', id, payload, index)
      this.emit('task-added', id, payload, index)
    }
    return id
  }

  update (id, data, emit = true) {
    super.update(id, data, false)
    if (emit) {
      for (const key in data) {
        this.emit('workspace-updated', id, key, data[key])
        this.emit('task-updated', id, key, data[key])
      }
    }
  }

  getStringifyableState () {
    const base = super.getStringifyableState()
    return { tasks: base.tasks, workspaces: base.tasks }
  }

  getCopyableState () {
    const base = super.getCopyableState()
    return { tasks: base.tasks, workspaces: base.tasks }
  }

  getWorkspaceContainingTab (tabId) {
    return this.getTaskContainingTab(tabId)
  }

  setSelected (id, emit = true, onWindow = windowId) {
    TaskList.prototype.setSelected.call(this, id, false, onWindow)
    if (onWindow === windowId && emit) {
      this.emit('workspace-selected', id)
      this.emit('task-selected', id)
      if (tabs.getSelected()) {
        this.emit('tab-selected', tabs.getSelected(), id)
      }
    }
  }

  destroy (id, emit = true) {
    if (emit) {
      this.get(id).tabs.forEach(tab => this.emit('tab-destroyed', tab.id, id))
      this.emit('workspace-destroyed', id)
      this.emit('task-destroyed', id)
      return super.destroy(id, false)
    }
    return super.destroy(id, false)
  }

  isArchived (id) {
    const ws = this.get(id)
    return !!(ws && ws.archived)
  }

  getActive () {
    return this.tasks.filter(ws => !ws.archived)
  }

  getArchived () {
    return this.tasks.filter(ws => ws.archived)
  }
}

module.exports = WorkspaceList
module.exports.WorkspaceList = WorkspaceList
module.exports.TaskList = WorkspaceList
