/*
Implements split view: groups of two tabs that share the window side by side.
The split state is session-only and window-local (not synced across windows, not persisted).

Concept: each split is a *group* of two tabs.
- Only one group is shown in the window at a time (two panes side by side);
  the other groups are remembered (paused) and their tabs look normal in the tab bar.
- Clicking a tab of the shown group moves focus between its panes.
- Clicking a tab of a paused group shows that group instead.
- Clicking a tab that belongs to no group pauses the shown group and shows the
  tab full-window; clicking a group member again resumes its group.
- A group is destroyed when one of its tabs is closed or moved away, when
  switching tasks, or when entering HTML fullscreen.

To avoid a circular dependency with webviews.js, this module receives a reference
to the webviews module via initialize(), and webviews reads back the split state
through the webviews.splitProvider hook.
*/

const gutterWidth = 4 // gap between the two panes
const minPaneWidth = 100 // minimum width of a pane when resizing

const splitView = {
  groups: [], // [{ paneTabIds: [leftTabId, rightTabId], activePane: 0|1, splitRatio }]
  activeGroupIndex: null, // index into groups of the group currently shown, or null
  selectionAnchor: null, // tabId of the first tab in the split-pair selection flow
  onLayoutChange: null, // set by splitViewDivider.js to keep the divider in sync
  onSelectionChange: null, // set by tabBar.js to update the tab bar UI
  onGroupsChange: null, // set by tabBar.js to update group indicators

  initialize: function (webviewsModule) {
    splitView.webviews = webviewsModule
    webviewsModule.splitProvider = splitView
  },
  /* notifies the UI that the group composition changed (tabs added/removed
  from groups, groups shown/paused/destroyed) */
  notifyGroupsChanged: function () {
    if (splitView.onGroupsChange) {
      splitView.onGroupsChange()
    }
  },
  isSplit: function () {
    return splitView.activeGroupIndex !== null
  },
  getActiveGroup: function () {
    if (splitView.activeGroupIndex === null) {
      return null
    }
    return splitView.groups[splitView.activeGroupIndex]
  },
  getPaneIds: function () {
    const group = splitView.getActiveGroup()
    return group ? group.paneTabIds : null
  },
  getActiveTabId: function () {
    const group = splitView.getActiveGroup()
    if (group) {
      return group.paneTabIds[group.activePane]
    }
    return tabs.getSelected()
  },
  getOtherPaneTabId: function () {
    const group = splitView.getActiveGroup()
    if (!group) {
      return null
    }
    return group.paneTabIds[1 - group.activePane]
  },
  /* finds the group containing tabId (shown or paused) */
  getGroupForTab: function (tabId) {
    return splitView.groups.find(group => group.paneTabIds.includes(tabId)) || null
  },
  /* shows a group: pauses the currently shown group (if any) and displays
  the given group's panes */
  showGroup: function (groupIndex) {
    const group = splitView.groups[groupIndex]
    if (!group) {
      return
    }

    // if another group is shown, pause it first (it stays in the groups list)
    if (splitView.activeGroupIndex !== null && splitView.activeGroupIndex !== groupIndex) {
      splitView.activeGroupIndex = null
    }
    splitView.activeGroupIndex = groupIndex
    splitView.notifyGroupsChanged()
    splitView.showSplit()
  },
  /* creates a new split group (or reuses the group containing one of the tabs)
  and shows it. The panes follow the tab bar order: the tab that comes first
  in the tab list becomes the left pane. */
  enterWithPair: function (tabAId, tabBId, activeTabId = tabBId) {
    const indexA = tabs.getIndex(tabAId)
    const indexB = tabs.getIndex(tabBId)
    if (indexA < 0 || indexB < 0 || tabAId === tabBId) {
      return
    }

    // Reuse an existing group that contains one of the tabs. A tab can only
    // belong to one group; remove any other groups that contain either side
    // before assigning the pair so stale/old state cannot leave a tab in two
    // groups at once.
    let group = splitView.getGroupForTab(tabAId) || splitView.getGroupForTab(tabBId)
    splitView.groups.slice().reverse().forEach(function (candidate) {
      if (candidate !== group && (candidate.paneTabIds.includes(tabAId) || candidate.paneTabIds.includes(tabBId))) {
        splitView.removeGroup(splitView.groups.indexOf(candidate))
      }
    })
    if (group) {
      group.paneTabIds = [tabAId, tabBId]
    } else {
      group = {
        paneTabIds: [tabAId, tabBId],
        activePane: 0,
        splitRatio: 0.5
      }
      splitView.groups.push(group)
    }

    // the pane containing the active tab gets focus
    group.activePane = group.paneTabIds.indexOf(activeTabId)
    if (group.activePane < 0) {
      group.activePane = 0
    }
    group.splitRatio = 0.5

    splitView.notifyGroupsChanged()
    splitView.showGroup(splitView.groups.indexOf(group))
  },
  /* shows the active group's split layout */
  showSplit: function () {
    const group = splitView.getActiveGroup()
    if (!group) {
      return
    }

    // make sure both tabs have webviews
    group.paneTabIds.forEach(function (id) {
      if (!splitView.webviews.hasViewForTab(id)) {
        splitView.webviews.add(id)
      }
    })

    splitView.applyLayout()
    if (splitView.onLayoutChange) {
      splitView.onLayoutChange(true)
    }

    splitView.webviews.setSelected(group.paneTabIds[group.activePane], { focus: true })
    splitView.webviews.resize()
  },
  /* pauses the shown group: hides the panes and shows a single tab
  (preferredActiveId, or the active pane's tab) full-window. The group stays
  in the groups list and can be resumed later. */
  pause: function (preferredActiveId) {
    if (splitView.activeGroupIndex === null) {
      return
    }

    const activeId = preferredActiveId || splitView.getActiveTabId()

    splitView.activeGroupIndex = null

    ipc.send('unsplitView', {
      activeId: activeId,
      bounds: splitView.webviews.getViewBounds(activeId)
    })

    if (splitView.onLayoutChange) {
      splitView.onLayoutChange(false)
    }

    if (splitView.webviews.hasViewForTab(activeId)) {
      splitView.webviews.setSelected(activeId, { focus: true })
    }

    // restore the new tab page background state for the remaining tab
    const activeTab = tabs.get(activeId)
    if (activeTab && !activeTab.url) {
      document.body.classList.add('is-ntp')
    } else {
      document.body.classList.remove('is-ntp')
    }
  },
  /* removes a group from the groups list (pausing the window layout first if
  the removed group is the one shown). preferredActiveId picks the tab to show. */
  removeGroup: function (groupIndex, preferredActiveId) {
    const group = splitView.groups[groupIndex]
    if (!group) {
      return
    }

    if (splitView.activeGroupIndex === groupIndex) {
      splitView.activeGroupIndex = null
      splitView.groups.splice(groupIndex, 1)
      const activeId = preferredActiveId || group.paneTabIds[group.activePane]

      ipc.send('unsplitView', {
        activeId: activeId,
        bounds: splitView.webviews.getViewBounds(activeId)
      })

      if (splitView.onLayoutChange) {
        splitView.onLayoutChange(false)
      }

      if (splitView.webviews.hasViewForTab(activeId)) {
        splitView.webviews.setSelected(activeId, { focus: true })
      }

      const activeTab = tabs.get(activeId)
      if (activeTab && !activeTab.url) {
        document.body.classList.add('is-ntp')
      } else {
        document.body.classList.remove('is-ntp')
      }
    } else {
      splitView.groups.splice(groupIndex, 1)
      if (splitView.activeGroupIndex !== null && groupIndex < splitView.activeGroupIndex) {
        splitView.activeGroupIndex--
      }
    }
    splitView.notifyGroupsChanged()
  },
  /* destroys the shown group (or the group containing preferredActiveId) entirely */
  destroy: function (preferredActiveId) {
    let groupIndex = splitView.activeGroupIndex
    if (groupIndex === null && preferredActiveId) {
      const group = splitView.getGroupForTab(preferredActiveId)
      if (group) {
        groupIndex = splitView.groups.indexOf(group)
      }
    }
    if (groupIndex === null) {
      return
    }
    splitView.removeGroup(groupIndex, preferredActiveId)
  },
  /* removes every group containing tabId; if the shown group is affected,
  the other pane's tab (if any) becomes the visible tab */
  handleTabDestroyed: function (tabId) {
    const affectedGroups = splitView.groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.paneTabIds.includes(tabId))

    // remove from the end because removing a group changes later indices
    affectedGroups.reverse().forEach(({ group }) => {
      const index = splitView.groups.indexOf(group)
      if (index < 0) return
      const otherPaneId = group.paneTabIds[1 - group.paneTabIds.indexOf(tabId)]
      splitView.removeGroup(index, otherPaneId)
    })
  },
  /* called from browserUI.switchToTab while split: switches which pane is active,
  shows the group of the clicked tab if it belongs to a paused group, or pauses
  the shown group and shows the clicked tab full-window. */
  setActiveTab: function (tabId) {
    const shownGroup = splitView.getActiveGroup()

    if (shownGroup) {
      if (tabId === shownGroup.paneTabIds[0]) {
        shownGroup.activePane = 0
      } else if (tabId === shownGroup.paneTabIds[1]) {
        shownGroup.activePane = 1
      } else {
        const tabGroup = splitView.getGroupForTab(tabId)
        if (tabGroup) {
          // switching to a tab of another (paused) group: show that group
          const groupIndex = splitView.groups.indexOf(tabGroup)
          splitView.showGroup(groupIndex)
        } else {
          // switching to a tab that isn't in any group: pause the split
          splitView.pause(tabId)
        }
      }
    } else {
      const tabGroup = splitView.getGroupForTab(tabId)
      if (tabGroup) {
        // switching to a tab of a paused group: show that group
        splitView.showGroup(splitView.groups.indexOf(tabGroup))
      }
    }
  },
  /* reorders the panes of every group to match the tab bar order after a tab
  is moved. The pane whose tab comes first in the tab list becomes the left
  pane, and the active pane follows its tab. Groups whose tabs were moved away
  are destroyed. */
  handleTabReorder: function () {
    if (splitView.groups.length === 0) {
      return
    }

    // remove groups whose tabs are gone
    const groupsToRemove = []
    splitView.groups.forEach(function (group, index) {
      const indexA = tabs.getIndex(group.paneTabIds[0])
      const indexB = tabs.getIndex(group.paneTabIds[1])
      if (indexA < 0 || indexB < 0) {
        groupsToRemove.push(index)
      }
    })
    // remove in reverse index order to keep indices valid
    groupsToRemove.reverse().forEach(function (index) {
      splitView.removeGroup(index)
    })
    if (splitView.groups.length === 0) {
      return
    }

    // normalize the pane order of every group
    splitView.groups.forEach(function (group) {
      const [tabA, tabB] = group.paneTabIds
      const indexA = tabs.getIndex(tabA)
      const indexB = tabs.getIndex(tabB)
      if (indexA > indexB) {
        group.paneTabIds = [tabB, tabA]
        group.activePane = 1 - group.activePane
      }
    })

    if (splitView.isSplit()) {
      splitView.applyLayout()
    }
    splitView.notifyGroupsChanged()
  },
  /* sets the split ratio (0-1) of the shown group and updates the pane bounds.
  liveResize skips the full setSplitView IPC (which detaches and re-attaches
  views) and only resizes the existing views, which is what we want while
  dragging the divider. */
  setSplitRatio: function (ratio, liveResize = false) {
    const group = splitView.getActiveGroup()
    if (!group) {
      return
    }
    group.splitRatio = Math.min(1, Math.max(0, ratio))
    if (liveResize) {
      splitView.webviews.resize()
    } else {
      splitView.applyLayout()
      splitView.webviews.resize()
    }
  },
  /* sends the current pane layout to the main process */
  applyLayout: function () {
    const group = splitView.getActiveGroup()
    if (!group) {
      return
    }
    ipc.send('setSplitView', {
      ids: group.paneTabIds,
      bounds: splitView.getBounds(),
      activeId: group.paneTabIds[group.activePane]
    })
    if (splitView.onLayoutChange) {
      splitView.onLayoutChange()
    }
  },
  /* computes the bounds for each pane, splitting the full view rect by the
  shown group's splitRatio */
  getBounds: function () {
    const group = splitView.getActiveGroup()
    const full = splitView.webviews.getViewBounds(group.paneTabIds[group.activePane], true)
    const minWidth = Math.min(minPaneWidth, Math.floor(full.width / 4))
    const leftWidth = Math.round(full.width * group.splitRatio)
    const clampedLeftWidth = Math.min(Math.max(leftWidth, minWidth), full.width - minWidth - gutterWidth)
    const rightWidth = full.width - clampedLeftWidth - gutterWidth

    return [
      {
        x: full.x,
        y: full.y,
        width: clampedLeftWidth,
        height: full.height
      },
      {
        x: full.x + clampedLeftWidth + gutterWidth,
        y: full.y,
        width: rightWidth,
        height: full.height
      }
    ]
  },
  getBoundsForTab: function (tabId) {
    const group = splitView.getActiveGroup()
    if (!group) {
      return null
    }
    const bounds = splitView.getBounds()
    if (tabId === group.paneTabIds[0]) {
      return bounds[0]
    } else if (tabId === group.paneTabIds[1]) {
      return bounds[1]
    }
    return null
  },
  /* removes both the visible split and all paused groups. Workspace/profile
  lifecycle changes use this instead of destroy(), since paused groups are
  otherwise left behind and can later point at unrelated tabs. */
  clearAll: function (preferredActiveId) {
    const activeGroup = splitView.getActiveGroup()
    const hadActiveGroup = activeGroup !== null
    // window.tabs is undefined until the first task is selected (startup);
    // guard so workspace switches on a fresh state don't crash.
    const currentTabs = (typeof window !== 'undefined' && window.tabs) || (typeof tabs !== 'undefined' ? tabs : null)
    const selectedTab = currentTabs ? currentTabs.getSelected() : null
    const activeId = preferredActiveId || (activeGroup && activeGroup.paneTabIds[activeGroup.activePane]) || selectedTab

    splitView.activeGroupIndex = null
    splitView.groups = []

    if (hadActiveGroup) {
      if (activeId) {
        ipc.send('unsplitView', {
          activeId: activeId,
          bounds: splitView.webviews.getViewBounds(activeId)
        })
        if (splitView.webviews.hasViewForTab(activeId)) {
          splitView.webviews.setSelected(activeId, { focus: true })
        }
      }
      if (splitView.onLayoutChange) {
        splitView.onLayoutChange(false)
      }
    }

    if (splitView.selectionAnchor) {
      splitView.selectionAnchor = null
      if (splitView.onSelectionChange) {
        splitView.onSelectionChange(false)
      }
    }
    splitView.notifyGroupsChanged()
  },
  /* destroys all groups when switching tasks */
  handleTaskSwitch: function () {
    splitView.clearAll()
  },
  /* destroys all groups when a pane enters HTML fullscreen (needs the whole window) */
  handleHtmlFullscreen: function () {
    splitView.clearAll()
  },

  /* starts the split-pair selection flow: the tab bar enters a mode where the
  next tab clicked becomes the pair of anchorTabId */
  startSelection: function (anchorTabId) {
    splitView.selectionAnchor = anchorTabId
    if (splitView.onSelectionChange) {
      splitView.onSelectionChange(true, anchorTabId)
    }
  },
  cancelSelection: function () {
    if (!splitView.selectionAnchor) {
      return
    }
    splitView.selectionAnchor = null
    if (splitView.onSelectionChange) {
      splitView.onSelectionChange(false)
    }
  },
  isSelecting: function () {
    return splitView.selectionAnchor !== null
  },
  /* completes the selection flow: creates (or replaces) the split group with
  the anchor tab and the clicked tab */
  completeSelection: function (clickedTabId) {
    const anchorTabId = splitView.selectionAnchor
    splitView.selectionAnchor = null
    if (splitView.onSelectionChange) {
      splitView.onSelectionChange(false)
    }
    if (!anchorTabId || clickedTabId === anchorTabId) {
      return
    }

    // the clicked tab becomes the active tab (its pane gets focus)
    tabs.setSelected(clickedTabId)
    splitView.enterWithPair(anchorTabId, clickedTabId)
  }
}

module.exports = splitView
