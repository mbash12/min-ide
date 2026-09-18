// Follows the active workspace's TaskList across workspace switches.
// window.tasks is re-pointed on every switch, so a one-time tasks.on(...)
// would go stale. followTaskList invokes subscribe(list) immediately with
// the current list and again with each new list after a workspace switch.
function followTaskList (subscribe) {
  subscribe(tasks)
  workspaces.on('workspace-selected', function () {
    subscribe(tasks)
  })
}

module.exports = { followTaskList }
