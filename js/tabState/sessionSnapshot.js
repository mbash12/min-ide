// The store already returns new records; filter those directly instead of
// cloning the entire session through JSON before serializing it again.
module.exports = function sessionSnapshot (store, startupOption) {
  const state = store.getStringifyableState()
  state.workspaces.forEach(workspace => workspace.tasks.forEach(task => {
    const live = startupOption === 3 && store.findTask(task.id)
    task.tabs = live && live.selectedInWindow ? [] : task.tabs.filter(tab => !tab.private)
  }))
  return state
}
