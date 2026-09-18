const TabList = require('tabState/tab.js')
const TabStack = require('tabRestore.js')

class WorkspaceList {
  constructor () {
    this.workspaces = []
    this.events = []
    this.pendingCallbacks = []
    this.pendingCallbackTimeout = null
  }

  on (name, fn) {
    this.events.push({ name, fn })
  }

  static temporaryProperties = ['selectedInWindow']

  emit (name, ...data) {
    this.events.forEach(listener => {
      if (listener.name === name || listener.name === '*') {
        this.pendingCallbacks.push([listener.fn, (listener.name === '*' ? [name] : []).concat(data)])
        if (!this.pendingCallbackTimeout) {
          this.pendingCallbackTimeout = setTimeout(() => {
            this.pendingCallbacks.forEach(t => t[0].apply(this, t[1]))
            this.pendingCallbacks = []
            this.pendingCallbackTimeout = null
          }, 0)
        }
      }
    })
  }

  add (workspace, index, emit) {
    if (workspace === undefined) workspace = {}
    if (emit === undefined) emit = true
    const newWorkspace = {
      name: workspace.name || null,
      profileId: workspace.profileId || null,
      path: workspace.path || null,
      tabs: new TabList(workspace.tabs, this),
      tabHistory: new TabStack(workspace.tabHistory),
      collapsed: workspace.collapsed,
      archived: !!workspace.archived,
      id: workspace.id || String(WorkspaceList.getRandomId()),
      selectedInWindow: workspace.selectedInWindow || null
    }
    if (index !== undefined && index !== null) {
      this.workspaces.splice(index, 0, newWorkspace)
    } else {
      this.workspaces.push(newWorkspace)
    }
    if (emit) {
      this.emit('workspace-added', newWorkspace.id, Object.assign({}, newWorkspace, { tabHistory: workspace.tabHistory, tabs: workspace.tabs }), index)
      this.emit('task-added', newWorkspace.id, Object.assign({}, newWorkspace, { tabHistory: workspace.tabHistory, tabs: workspace.tabs }), index)
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
      ws[key] = data[key]
      if (emit) {
        this.emit('workspace-updated', id, key, data[key])
        this.emit('task-updated', id, key, data[key])
      }
    }
  }

  getStringifyableState () {
    return {
      tasks: this.workspaces.map(ws => Object.assign({}, ws, { tabs: ws.tabs.getStringifyableState() })).map(function (ws) {
        const result = {}
        Object.keys(ws).filter(key => !WorkspaceList.temporaryProperties.includes(key)).forEach(key => { result[key] = ws[key] })
        return result
      }),
      workspaces: this.workspaces.map(ws => Object.assign({}, ws, { tabs: ws.tabs.getStringifyableState() })).map(function (ws) {
        const result = {}
        Object.keys(ws).filter(key => !WorkspaceList.temporaryProperties.includes(key)).forEach(key => { result[key] = ws[key] })
        return result
      })
    }
  }

  getCopyableState () {
    return {
      tasks: this.workspaces.map(ws => Object.assign({}, ws, { tabs: ws.tabs.tabs })),
      workspaces: this.workspaces.map(ws => Object.assign({}, ws, { tabs: ws.tabs.tabs }))
    }
  }

  get (id) {
    return this.find(ws => ws.id === id) || null
  }

  getSelected () {
    return this.find(ws => ws.selectedInWindow === windowId)
  }

  byIndex (index) {
    return this.workspaces[index]
  }

  getWorkspaceContainingTab (tabId) {
    return this.find(ws => ws.tabs.has(tabId)) || null
  }

  getTaskContainingTab (tabId) {
    return this.getWorkspaceContainingTab(tabId)
  }

  getIndex (id) {
    return this.workspaces.findIndex(ws => ws.id === id)
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
      window.tabs = this.get(id).tabs
      if (emit) {
        this.emit('workspace-selected', id)
        this.emit('task-selected', id)
        if (tabs.getSelected()) {
          this.emit('tab-selected', tabs.getSelected(), id)
        }
      }
    }
  }

  destroy (id, emit = true) {
    const index = this.getIndex(id)
    if (emit) {
      this.get(id).tabs.forEach(tab => this.emit('tab-destroyed', tab.id, id))
      this.emit('workspace-destroyed', id)
      this.emit('task-destroyed', id)
    }
    if (index < 0) return false
    this.workspaces.splice(index, 1)
    return index
  }

  getLastActivity (id) {
    const wsTabs = this.get(id).tabs
    let lastActivity = 0
    for (let i = 0; i < wsTabs.count(); i++) {
      if (wsTabs.getAtIndex(i).lastActivity > lastActivity) {
        lastActivity = wsTabs.getAtIndex(i).lastActivity
      }
    }
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
  splice (...args) { return this.workspaces.splice.apply(this.workspaces, args) }
  filter (...args) { return this.workspaces.filter.apply(this.workspaces, args) }
  find (filter) {
    for (let i = 0, len = this.workspaces.length; i < len; i++) {
      if (filter(this.workspaces[i], i, this.workspaces)) {
        return this.workspaces[i]
      }
    }
  }

  get tasks () { return this.workspaces }
  set tasks (v) { this.workspaces = v }

  static getRandomId () {
    return Math.round(Math.random() * 100000000000000000)
  }
}

const TaskList = WorkspaceList

module.exports = WorkspaceList
module.exports.WorkspaceList = WorkspaceList
module.exports.TaskList = TaskList
