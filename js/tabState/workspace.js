const TaskList = require('tabState/task.js')
const OwnershipIndex = require('tabState/ownershipIndex.js')
const copyWorkspace = require('tabState/workspaceSerialization.js')

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
    this.byId = new Map()
    this.index = new OwnershipIndex()
    this.events = []
  }

  on (name, fn) {
    const listener = { name, fn }
    this.events.push(listener)
    return () => { this.events = this.events.filter(entry => entry !== listener) }
  }

  /* Emit synchronously like upstream TaskList: batching callbacks through
  setTimeout made listeners run a tick late, which broke any code that emits
  and then reads state assuming subscribers already ran. Cross-window
  batching still happens in windowSync's pendingEvents queue. */
  emit (name, ...data) {
    this.events.slice().forEach(listener => {
      if (listener.name === name || listener.name === '*') {
        listener.fn.apply(this, (listener.name === '*' ? [name] : []).concat(data))
      }
    })
  }

  add (workspace = {}, index, emit = true) {
    if (workspace.id && this.get(workspace.id)) return workspace.id
    const newWorkspace = makeWorkspace(workspace)
    restoreTaskList(newWorkspace, workspace.tasks)

    if (index !== undefined && index !== null) {
      this.workspaces.splice(index, 0, newWorkspace)
    } else {
      this.workspaces.push(newWorkspace)
    }

    this.byId.set(newWorkspace.id, newWorkspace)
    newWorkspace.tasks.workspace = newWorkspace
    newWorkspace.tasks.index.attach(this.index)
    wireTaskEvents(this, newWorkspace)

    if (emit) {
      this.emit('workspace-added', newWorkspace.id, copyWorkspace(newWorkspace), index)
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
      if (key === 'tasks' || Object.is(ws[key], data[key])) continue
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
      workspaces: this.workspaces.map(ws => copyWorkspace(ws, true))
    }
  }

  getCopyableState () {
    return {
      workspaces: this.workspaces.map(ws => copyWorkspace(ws))
    }
  }

  get (id) {
    return this.byId.get(id) || null
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
    const task = this.findTask(taskId)
    return task ? task.tabs.parentTaskList : null
  }

  findWorkspaceContainingTask (taskId) {
    const list = this.getTaskList(taskId)
    return list ? list.workspace : null
  }

  findTask (taskId) {
    return this.index.tasks.get(taskId) || null
  }

  findWorkspaceContainingTab (tabId) {
    const task = this.findTaskContainingTab(tabId)
    return task ? task.tabs.parentTaskList.workspace : null
  }

  findTaskContainingTab (tabId) {
    return this.index.tabs.get(tabId) || null
  }

  getSelectedTask () {
    const ws = this.getSelected()
    return ws ? ws.tasks.getSelected() : null
  }

  setSelected (id, emit = true, onWindow = windowId) {
    if (!this.get(id)) return false
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
    ws.tasks.dispose()
    this.byId.delete(id)
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

// Append the owner to task creation events so another window never restores
// a new background task into whichever workspace happens to be selected there.
function wireTaskEvents (store, ws) {
  ws.tasks.on('*', function (name, ...args) {
    if (name === 'state-sync-change') return
    if (name === 'tab-multi-selected' || name === 'tab-multi-selection-cleared') return
    if (name === 'task-added') args.push(ws.id)
    store.emit(name, ...args)
  })
}

module.exports = WorkspaceStore
module.exports.WorkspaceStore = WorkspaceStore
module.exports.TaskList = TaskList
