// Keep ownership lookups independent of the selected workspace. Structural
// mutations update these maps synchronously, before deferred UI events run.
class OwnershipIndex {
  constructor () {
    this.tasks = new Map()
    this.tabs = new Map()
    this.parent = null
  }

  attach (parent) {
    this.detach()
    this.parent = parent
    this.tasks.forEach(task => parent.addTask(task))
  }

  detach () {
    if (this.parent) this.tasks.forEach(task => this.parent.removeTask(task))
    this.parent = null
  }

  addTask (task) {
    this.tasks.set(task.id, task)
    this.addTabs(task, task.tabs.tabs)
    if (this.parent) this.parent.addTask(task)
  }

  removeTask (task) {
    if (this.tasks.get(task.id) !== task) return
    this.removeTabs(task, task.tabs.tabs)
    this.tasks.delete(task.id)
    if (this.parent) this.parent.removeTask(task)
  }

  addTabs (task, tabs) {
    if (this.tasks.get(task.id) !== task) return
    tabs.forEach(tab => this.tabs.set(tab.id, task))
    if (this.parent) this.parent.addTabs(task, tabs)
  }

  removeTabs (task, tabs) {
    tabs.forEach(tab => {
      if (this.tabs.get(tab.id) === task) this.tabs.delete(tab.id)
    })
    if (this.parent) this.parent.removeTabs(task, tabs)
  }
}

module.exports = OwnershipIndex
