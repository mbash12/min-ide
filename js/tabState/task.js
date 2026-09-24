const TabList = require('tabState/tab.js')
const TabStack = require('tabRestore.js')
const OwnershipIndex = require('tabState/ownershipIndex.js')

// Upstream Min's TaskList, kept close to upstream/master so that merges from
// minbrowser/min apply cleanly. Fork divergence is limited to the marked
// FORK blocks below (this-reference fix, reorder); everything else is
// upstream. The Workspace level lives in js/tabState/workspace.js and owns
// one TaskList per workspace.

class TaskList {
  constructor () {
    this.tasks = [] // each task is {id, name, tabs: [], tabHistory: TabStack}
    this.index = new OwnershipIndex()
    this.workspace = null
    this.events = []
    this.pendingCallbacks = []
    this.pendingCallbackTimeout = null
  }

  on (name, fn) {
    const listener = { name, fn, active: true }
    this.events.push(listener)
    return () => {
      listener.active = false
      this.events = this.events.filter(entry => entry !== listener)
    }
  }

  static temporaryProperties = ['selectedInWindow']

  emit (name, ...data) {
    this.events.forEach(listener => {
      if (listener.name === name || listener.name === '*') {
        this.pendingCallbacks.push([listener, (listener.name === '*' ? [name] : []).concat(data)])
      }
    })
    if (this.pendingCallbacks.length && this.pendingCallbackTimeout === null) {
      this.pendingCallbackTimeout = setTimeout(() => {
        // Detach the batch first: callbacks can enqueue new events or dispose
        // the list without losing events or leaving its timer stuck.
        const callbacks = this.pendingCallbacks
        this.pendingCallbacks = []
        this.pendingCallbackTimeout = null
        callbacks.forEach(([listener, args]) => {
          if (!listener.active) return
          try {
            listener.fn.apply(this, args)
          } catch (error) {
            console.error('Task state listener failed', error)
          }
        })
      }, 0)
    }
  }

  dispose () {
    clearTimeout(this.pendingCallbackTimeout)
    this.pendingCallbackTimeout = null
    this.pendingCallbacks = []
    this.events.forEach(listener => { listener.active = false })
    this.events = []
    this.index.detach()
  }

  add (task = {}, index, emit = true) {
    if (task.id && this.get(task.id)) return task.id
    const newTask = {
      name: task.name || null,
      tabs: new TabList(task.tabs, this),
      tabHistory: new TabStack(task.tabHistory),
      collapsed: task.collapsed, // this property must stay undefined if it is already (since there is a difference between "explicitly uncollapsed" and "never collapsed")
      id: task.id || String(TaskList.getRandomId()),
      selectedInWindow: task.selectedInWindow || null,
      // FORK: the task's tiled layout, written by js/splitView.js. It has to be
      // listed here because this constructor is the restore whitelist: fields
      // that are not copied over are dropped when the session is restored.
      splitState: task.splitState || null,
      // FORK: task-scoped preferences (HANDOVER §2), a plain JSON key/value
      // map written via js/taskPrefs.js. null until first use.
      prefs: task.prefs || null
    }

    if (index !== undefined && index !== null) {
      this.tasks.splice(index, 0, newTask)
    } else {
      this.tasks.push(newTask)
    }

    newTask.tabs.ownerTask = newTask
    this.index.addTask(newTask)

    if (emit) {
      this.emit('task-added', newTask.id, Object.assign({}, newTask, { tabHistory: task.tabHistory, tabs: task.tabs }), index)
    }

    return newTask.id
  }

  update (id, data, emit=true) {
    let task = this.get(id)

    if (!task) {
      throw new ReferenceError('Attempted to update a task that does not exist.')
    }

    for (var key in data) {
      if (data[key] === undefined) {
        throw new ReferenceError('Key ' + key + ' is undefined.')
      }
      if (Object.is(task[key], data[key])) continue
      task[key] = data[key]
      if (emit) {
        this.emit('task-updated', id, key, data[key])
      }
    }
  }

  getStringifyableState () {
    return {
      tasks: this.tasks.map(task => Object.assign({}, task, { tabs: task.tabs.getStringifyableState() })).map(function(task) {
        //remove temporary properties from task
        let result = {}
        Object.keys(task)
        .filter(key => !TaskList.temporaryProperties.includes(key))
        .forEach(key => result[key] = task[key])
        return result
      })
    }
  }

  getCopyableState () {
    return {
      tasks: this.tasks.map(task => Object.assign({}, task, {tabs: task.tabs.tabs}))
    }
  }

  get (id) {
    return this.index.tasks.get(id) || null
  }

  getSelected () {
    return this.find(task => task.selectedInWindow === windowId)
  }

  byIndex (index) {
    return this.tasks[index]
  }

  getTaskContainingTab (tabId) {
    return this.index.tabs.get(tabId) || null
  }

  getIndex (id) {
    return this.tasks.findIndex(task => task.id === id)
  }

  setSelected (id, emit = true, onWindow=windowId) {
    const selected = this.get(id)
    if (!selected) return false
    for (var i = 0; i < this.tasks.length; i++) {
      if (this.tasks[i].selectedInWindow === onWindow) {
        this.tasks[i].selectedInWindow = null
      }
      if (this.tasks[i].id === id) {
        this.tasks[i].selectedInWindow = onWindow
      }
    }
    if (onWindow === windowId) {
      window.tabs = selected.tabs
      if (emit) {
        this.emit('task-selected', id)
        if (tabs.getSelected()) {
          this.emit('tab-selected', tabs.getSelected(), id)
        }
      }
    }
  }

  destroy (id, emit = true) {
    const index = this.getIndex(id)
    if (index < 0) return false
    const task = this.get(id)

    if (emit) {
    // emit the tab-destroyed event for all tabs in this task
      task.tabs.forEach(tab => this.emit('tab-destroyed', tab.id, id))

      this.emit('task-destroyed', id)
    }

    this.index.removeTask(task)
    this.tasks.splice(index, 1)

    return index
  }

  getLastActivity (id) {
    var tabs = this.get(id).tabs
    var lastActivity = 0

    for (var i = 0; i < tabs.count(); i++) {
      if (tabs.getAtIndex(i).lastActivity > lastActivity) {
        lastActivity = tabs.getAtIndex(i).lastActivity
      }
    }

    return lastActivity
  }

  isCollapsed (id) {
    var task = this.get(id)
    // FORK: use this instead of the global tasks object so multiple TaskList
    // instances (one per workspace) each resolve their own activity.
    return task.collapsed || (task.collapsed === undefined && Date.now() - this.getLastActivity(task.id) > (7 * 24 * 60 * 60 * 1000))
  }

  // FORK: reorder tasks within this list (used by the task overlay drag
  // reorder instead of mutating the internal array directly).
  reorder (fromIndex, toIndex, emit = true) {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= this.tasks.length || toIndex < 0 || toIndex >= this.tasks.length) return
    const moved = this.tasks.splice(fromIndex, 1)[0]
    this.tasks.splice(toIndex, 0, moved)
    if (emit) this.emit('task-moved', moved.id, fromIndex, toIndex)
  }

  getLength () {
    return this.tasks.length
  }

  map (fun) { return this.tasks.map(fun) }

  forEach (fun) { return this.tasks.forEach(fun) }

  indexOf (task) { return this.tasks.indexOf(task) }

  slice (...args) { return this.tasks.slice.apply(this.tasks, args) }

  splice (...args) {
    const removed = this.tasks.splice(...args)
    removed.forEach(task => this.index.removeTask(task))
    args.slice(2).forEach(task => {
      task.tabs.parentTaskList = this
      task.tabs.ownerTask = task
      this.index.addTask(task)
    })
    return removed
  }

  filter (...args) { return this.tasks.filter.apply(this.tasks, args) }

  find (filter) {
    for (var i = 0, len = this.tasks.length; i < len; i++) {
      if (filter(this.tasks[i], i, this.tasks)) {
        return this.tasks[i]
      }
    }
  }

  static getRandomId () {
    return Math.round(Math.random() * 100000000000000000)
  }
}

module.exports = TaskList
