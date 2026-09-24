const { maxPanesPerGroup, readFractions } = require('splitView/layout.js')

module.exports = function (splitView) {
  const mirrorTimers = new Map()
  /* copies the layout onto the selected task record. The session restore data
  is built from the task records, so this is all that is needed to persist it.
  Assigned directly instead of through tasks.update() because this also runs on
  every divider drag, and an update() call would emit an event each time. */
  function persist () {
    const task = typeof tasks !== 'undefined' && tasks && tasks.getSelected ? tasks.getSelected() : null
    if (!task) {
      return
    }
    task.splitState = {
      groups: splitView.groups.map(function (group) {
        return {
          paneTabIds: group.paneTabIds.slice(),
          activePane: group.activePane,
          fractions: group.fractions.slice()
        }
      }),
      activeGroupIndex: splitView.activeGroupIndex
    }
    /* mirror to the central DB's 'tile_state' scope (debounced - persist runs
    on every divider drag). The session blob stays the runtime source. */
    const taskId = task.id
    const state = task.splitState
    clearTimeout(mirrorTimers.get(taskId))
    mirrorTimers.set(taskId, setTimeout(function () {
      mirrorTimers.delete(taskId)
      if (workspaces.findTask(taskId) !== task) return
      try {
        require('util/customDataStore.js')
          .kvSet('tile_state', taskId, state)
          .catch(function () {})
      } catch (e) {}
    }, 500))
  }
  /* loads the layout saved on the selected task. Groups whose tabs no longer
  exist (or that share a tab) are dropped, and the shown group is only restored
  when the tab that was active in it is still the selected one, so the pane
  layout and the tab bar can't disagree. */
  function restoreForSelectedTask () {
    if (typeof tasks === 'undefined' || !tasks || !tasks.getSelected) {
      return
    }
    if (typeof tabs === 'undefined' || !tabs) {
      return
    }
    const task = tasks.getSelected()
    const state = task && task.splitState
    if (!state || !Array.isArray(state.groups)) {
      return
    }

    const restored = []
    let activeGroupIndex = null

    state.groups.forEach(function (group, index) {
      if (!group || !Array.isArray(group.paneTabIds)) {
        return
      }
      if (group.paneTabIds.length < 2 || group.paneTabIds.length > maxPanesPerGroup) {
        return
      }
      if (new Set(group.paneTabIds).size !== group.paneTabIds.length || !group.paneTabIds.every(tabId => tabs.has(tabId))) {
        return
      }
      // a tab may only belong to one group
      if (restored.some(other => other.paneTabIds.some(tabId => group.paneTabIds.includes(tabId)))) {
        return
      }
      const activePane = Math.min(Math.max(0, group.activePane | 0), group.paneTabIds.length - 1)
      restored.push({
        paneTabIds: group.paneTabIds.slice(),
        activePane: activePane,
        fractions: readFractions(group, group.paneTabIds.length)
      })
      if (index === state.activeGroupIndex) {
        activeGroupIndex = restored.length - 1
      }
    })

    splitView.groups = restored
    splitView.activeGroupIndex = null

    if (activeGroupIndex !== null) {
      const group = restored[activeGroupIndex]
      if (tabs.getSelected() === group.paneTabIds[group.activePane]) {
        splitView.activeGroupIndex = activeGroupIndex
        splitView.showSplit()
      } else {
        // the group comes back paused, with the pane of the restored tab active
        const restoredPane = group.paneTabIds.indexOf(tabs.getSelected())
        if (restoredPane >= 0) {
          group.activePane = restoredPane
        }
      }
    }

    splitView.notifyGroupsChanged()
  }
  workspaces.on('task-destroyed', function (id) {
    clearTimeout(mirrorTimers.get(id))
    mirrorTimers.delete(id)
    require('util/customDataStore.js').kvDelete('tile_state', id).catch(function () {})
    require('util/customDataStore.js').kvDelete('task_extra_state', id).catch(function () {})
  })
  return { persist, restoreForSelectedTask }
}
