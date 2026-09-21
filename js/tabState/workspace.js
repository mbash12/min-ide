const TaskList = require('tabState/task.js')

// Fork workspace level: Workspace -> Task -> Tab.
//
// Each Workspace owns one upstream TaskList instance (its tasks), created
// once and kept alive for the workspace lifetime so TabList.parentTaskList
// pins stay valid. The store emits workspace-* events only; task-*/tab-*
// events come from the inner TaskList/TabList unchanged.

function makeWorkspace (workspace = {}) {
  const now = Date.now()
  return {
    id: workspace.id || String(TaskList.getRandomId()),
    name: workspace.name || null,
    profileId: workspace.profileId || null,
    path: workspace.path || null,
    archived: !!workspace.archived,
    activeTaskId: workspace.activeTaskId || null,
    collapsed: workspace.collapsed,
    selectedInWindow: workspace.selectedInWindow || null,
    createdAt: workspace.createdAt || now,
    updatedAt: workspace.updatedAt || workspace.createdAt || now,
    tasks: null // assigned below: TaskList instance
  }
}

function restoreTaskList (ws, taskRecords) {
  const list = new TaskList()
  ;(taskRecords || []).forEach(function (record) {
    list.add(record, undefined, false)
  })
  ws.tasks = list
}

class WorkspaceStore {
  constructor () {
    this.workspaces = [] // each workspace is {id, name, profileId, path, archived, activeTaskId, collapsed, selectedInWindow, tasks: TaskList}
    this.events = []
    this.pendingCallbacks = []
    this.pendingCallbackTimeout = null
  }

  on (name, fn) {
    this.events.push({ name, fn })
  }

  /* Emit synchronously like upstream TaskList: batching callbacks through
  setTimeout made listeners run a tick late, which broke any code that emits
  and then reads state assuming subscribers already ran. Cross-window
  batching still happens in windowSync's pendingEvents queue. */
  emit (name, ...data) {
    this.events.forEach(listener => {
      if (listener.name === name || listener.name === '*') {
        listener.fn.apply(this, (listener.name === '*' ? [name] : []).concat(data))
      }
    })
  }

  add (workspace = {}, index, emit = true) {
    const newWorkspace = makeWorkspace(workspace)
    restoreTaskList(newWorkspace, workspace.tasks)

    if (index !== undefined && index !== null) {
      this.workspaces.splice(index, 0, newWorkspace)
    } else {
      this.workspaces.push(newWorkspace)
    }

    wireTaskEvents(this, newWorkspace)

    if (emit) {
      this.emit('workspace-added', newWorkspace.id, describeWorkspace(newWorkspace), index)
    }

    return newWorkspace.id
  }

  update (id, data, emit = true) {
    const ws = this.get(id)
    if (!ws) {
      throw new ReferenceError('Attempted to update a workspace that does not exist.')
    }
    for (const key in data) {
      if (data[key] === undefined) {
        throw new ReferenceError('Key ' + key + ' is undefined.')
      }
      if (key === 'tasks') continue
      ws[key] = data[key]
      if (key !== 'updatedAt') {
        ws.updatedAt = Date.now()
      }
      if (emit) {
        this.emit('workspace-updated', id, key, data[key])
      }
    }
  }

  getStringifyableState () {
    return {
      workspaces: this.workspaces.map(ws => stringifyWorkspace(ws))
    }
  }

  getCopyableState () {
    return {
      workspaces: this.workspaces.map(ws => copyWorkspace(ws))
    }
  }

  get (id) {
    return this.find(ws => ws.id === id) || null
  }

  getSelected () {
    return this.find(ws => ws.selectedInWindow === windowId) || null
  }

  byIndex (index) {
    return this.workspaces[index]
  }

  getIndex (id) {
    return this.workspaces.findIndex(ws => ws.id === id)
  }

  // The task's parent list, or null. Task ids are globally unique randoms.
  getTaskList (taskId) {
    for (let i = 0; i < this.workspaces.length; i++) {
      if (this.workspaces[i].tasks.get(taskId)) {
        return this.workspaces[i].tasks
      }
    }
    return null
  }

  findWorkspaceContainingTask (taskId) {
    return this.find(ws => ws.tasks.get(taskId)) || null
  }

  findTask (taskId) {
    const list = this.getTaskList(taskId)
    return list ? list.get(taskId) : null
  }

  // Task ids and tab ids are separate namespaces, so a tab must be routed
  // through the task that owns it.
  findWorkspaceContainingTab (tabId) {
    if (!tabId) return null
    return this.find(ws => ws.tasks.find(task => task.tabs.has(tabId))) || null
  }

  findTaskContainingTab (tabId) {
    const ws = this.findWorkspaceContainingTab(tabId)
    return ws ? ws.tasks.getTaskContainingTab(tabId) : null
  }

  getSelectedTask () {
    const ws = this.getSelected()
    return ws ? ws.tasks.getSelected() : null
  }

  setSelected (id, emit = true, onWindow = windowId) {
    for (let i = 0; i < this.workspaces.length; i++) {
      if (this.workspaces[i].selectedInWindow === onWindow) {
        this.workspaces[i].selectedInWindow = null
      }
      if (this.workspaces[i].id === id) {
        this.workspaces[i].selectedInWindow = onWindow
      }
    }
    if (onWindow === windowId) {
      if (emit) {
        this.emit('workspace-selected', id)
      }
    }
  }

  destroy (id, emit = true) {
    const index = this.getIndex(id)
    const ws = this.get(id)
    if (emit && ws) {
      ws.tasks.forEach(task => {
        task.tabs.forEach(tab => this.emit('tab-destroyed', tab.id, task.id))
        this.emit('task-destroyed', task.id)
      })
      this.emit('workspace-destroyed', id)
    }
    if (index < 0) return false
    this.workspaces.splice(index, 1)
    return index
  }

  getLastActivity (id) {
    const ws = this.get(id)
    if (!ws) return 0
    let lastActivity = 0
    ws.tasks.forEach(task => {
      const activity = ws.tasks.getLastActivity(task.id)
      if (activity > lastActivity) {
        lastActivity = activity
      }
    })
    return lastActivity
  }

  isCollapsed (id) {
    const ws = this.get(id)
    return ws.collapsed || (ws.collapsed === undefined && Date.now() - this.getLastActivity(ws.id) > (7 * 24 * 60 * 60 * 1000))
  }

  isArchived (id) {
    const ws = this.get(id)
    return !!(ws && ws.archived)
  }

  getActive () {
    return this.workspaces.filter(ws => !ws.archived)
  }

  getArchived () {
    return this.workspaces.filter(ws => ws.archived)
  }

  getLength () {
    return this.workspaces.length
  }

  map (fun) { return this.workspaces.map(fun) }
  forEach (fun) { return this.workspaces.forEach(fun) }
  indexOf (ws) { return this.workspaces.indexOf(ws) }
  slice (...args) { return this.workspaces.slice.apply(this.workspaces, args) }
  filter (...args) { return this.workspaces.filter.apply(this.workspaces, args) }
  find (filter) {
    for (let i = 0, len = this.workspaces.length; i < len; i++) {
      if (filter(this.workspaces[i], i, this.workspaces)) {
        return this.workspaces[i]
      }
    }
  }
}

// Forward inner task/tab events to store subscribers. Events keep their
// exact upstream payload shapes; the owning workspace id is available via
// findWorkspaceContainingTask, so sync can route them.
function wireTaskEvents (store, ws) {
  ws.tasks.on('*', function (name, ...args) {
    if (name === 'state-sync-change') return
    if (name === 'tab-multi-selected' || name === 'tab-multi-selection-cleared') return
    store.emit(name, ...args)
  })
}

function describeWorkspace (ws) {
  return {
    id: ws.id,
    name: ws.name,
    profileId: ws.profileId,
    path: ws.path,
    archived: ws.archived,
    activeTaskId: ws.activeTaskId,
    collapsed: ws.collapsed,
    taskIds: ws.tasks.map(task => task.id)
  }
}

function stringifyWorkspace (ws) {
  const stringified = ws.tasks.getStringifyableState().tasks
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
    tasks: stringified
  }
  if (result.collapsed === undefined) delete result.collapsed
  return result
}

function copyWorkspace (ws) {
  return {
    id: ws.id,
    name: ws.name,
    profileId: ws.profileId,
    path: ws.path,
    archived: ws.archived,
    activeTaskId: ws.activeTaskId,
    collapsed: ws.collapsed,
    selectedInWindow: ws.selectedInWindow,
    tasks: ws.tasks.getCopyableState().tasks
  }
}

module.exports = WorkspaceStore
module.exports.WorkspaceStore = WorkspaceStore
module.exports.TaskList = TaskList
