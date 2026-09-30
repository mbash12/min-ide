// Apply remote state without echoing it back. Missing objects are expected
// when a window opens while another one is creating/closing workspaces.
function applyWindowEvent (store, event, sourceWindowId, fallbackTasks) {
  const [name, id, key, value, owner] = event
  const list = store.getTaskList(id)
  const tabTask = store.findTask(owner || value)
  switch (name) {
    case 'workspace-added':
      store.add(key, value, false)
      break
    case 'workspace-selected':
      store.setSelected(id, false, sourceWindowId)
      break
    case 'workspace-destroyed':
      store.destroy(id, false)
      break
    case 'workspace-updated':
      if (store.get(id)) store.update(id, { [key]: value }, false)
      break
    case 'task-added': {
      const ws = owner && store.get(owner)
      // Only legacy events without an owner may use the selected workspace.
      const target = owner ? ws && ws.tasks : fallbackTasks
      if (target) target.add(key, value, false)
      break
    }
    case 'task-selected':
      if (list) list.setSelected(id, false, sourceWindowId)
      break
    case 'task-destroyed':
      if (list) list.destroy(id, false)
      break
    case 'task-updated':
      if (list) list.update(id, { [key]: value }, false)
      break
    case 'task-moved':
      if (list) list.reorder(list.getIndex(id), value, false)
      break
    case 'tab-added':
      if (tabTask) tabTask.tabs.add(key, value, false)
      break
    case 'tab-updated':
      if (tabTask && tabTask.tabs.has(id)) tabTask.tabs.update(id, { [key]: value }, false)
      break
    case 'tab-selected': {
      const task = store.findTask(key)
      if (task && task.tabs.has(id)) task.tabs.setSelected(id, false)
      break
    }
    case 'tab-destroyed': {
      const task = store.findTask(key)
      if (task) task.tabs.destroy(id, false)
      break
    }
    case 'tab-splice': {
      const task = store.findTask(id)
      if (task) task.tabs.spliceNoEmit(...event.slice(2))
      break
    }
  }
}

module.exports = applyWindowEvent
