/*
Implements split view: groups of two tabs that share the window side by side.
The groups belong to the task they were created in and are persisted with it
(the task record carries splitState, which session restore already saves), so
switching tasks or workspaces and restarting the browser brings the layout
back. Only one window shows a given task's layout at a time.

Concept: each split is a *group* of two tabs.
- Only one group is shown in the window at a time (two panes side by side);
  the other groups are remembered (paused) and their tabs look normal in the tab bar.
- Clicking a tab of the shown group moves focus between its panes.
- Clicking a tab of a paused group shows that group instead.
- Clicking a tab that belongs to no group pauses the shown group and shows the
  tab full-window; clicking a group member again resumes its group.
- A group is destroyed when one of its tabs is closed or moved away, or when
  entering HTML fullscreen.

To avoid a circular dependency with webviews.js, this module receives a reference
to the webviews module via initialize(), and webviews reads back the split state
through the webviews.splitProvider hook.
*/

const gutterWidth = 4 // gap between two panes
const minPaneWidth = 100 // minimum width of a pane when resizing
const maxPanesPerGroup = 3 // most panes a single tiled group can hold

let tileStateMirrorTimer = null // debounces the tile_state DB mirror in persist()

/* a new group starts with the width divided evenly */
function evenFractions (count) {
  return new Array(count).fill(1 / count)
}

/* the saved pane widths of a group: one positive entry per pane, normalized to
add up to 1. Anything unusable falls back to an even split. Layouts saved
before a group could hold more than two panes stored a single splitRatio, which
is still read so those layouts keep their divider position. */
function readFractions (group, paneCount) {
  if (Array.isArray(group.fractions) && group.fractions.length === paneCount) {
    const usable = group.fractions.every(f => typeof f === 'number' && isFinite(f) && f > 0)
    if (usable) {
      const total = group.fractions.reduce((a, b) => a + b, 0)
      return group.fractions.map(f => f / total)
    }
  }
  if (paneCount === 2 && typeof group.splitRatio === 'number' && isFinite(group.splitRatio)) {
    const left = Math.min(1, Math.max(0, group.splitRatio))
    return [left, 1 - left]
  }
  return evenFractions(paneCount)
}

/* panes are kept in tab bar order, so the leftmost pane is the leftmost tab.
Each pane keeps its own width while the group is reordered. */
function normalizeGroupOrder (group) {
  const widthsByTab = {}
  group.paneTabIds.forEach(function (tabId, i) {
    widthsByTab[tabId] = group.fractions[i]
  })
  const activeTabId = group.paneTabIds[group.activePane]

  group.paneTabIds = group.paneTabIds.slice().sort(function (a, b) {
    return tabs.getIndex(a) - tabs.getIndex(b)
  })
  group.fractions = group.paneTabIds.map(tabId => widthsByTab[tabId])
  group.activePane = Math.max(0, group.paneTabIds.indexOf(activeTabId))
}

const splitView = {
  groups: [], // [{ paneTabIds: [tabId, ...2-3], activePane: 0|1|2, fractions: [0.5, 0.5] }]
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
  /* copies the layout onto the selected task record. The session restore data
  is built from the task records, so this is all that is needed to persist it.
  Assigned directly instead of through tasks.update() because this also runs on
  every divider drag, and an update() call would emit an event each time. */
  persist: function () {
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
    if (tileStateMirrorTimer) {
      clearTimeout(tileStateMirrorTimer)
    }
    tileStateMirrorTimer = setTimeout(function () {
      tileStateMirrorTimer = null
      try {
        require('util/customDataStore.js')
          .kvSet('tile_state', taskId, state)
          .catch(function () {})
      } catch (e) {}
    }, 500)
  },
  /* loads the layout saved on the selected task. Groups whose tabs no longer
  exist (or that share a tab) are dropped, and the shown group is only restored
  when the tab that was active in it is still the selected one, so the pane
  layout and the tab bar can't disagree. */
  restoreForSelectedTask: function () {
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
      if (!group.paneTabIds.every(tabId => tabs.has(tabId))) {
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
    splitView.persist()
    splitView.notifyGroupsChanged()
    splitView.showSplit()
  },
  /* tiles two tabs, or adds the second one to the group the first already
  belongs to. A group holds up to maxPanesPerGroup panes; once it is full the
  new tab takes the place of the active pane. Panes follow the tab bar order,
  so the tab that comes first in the tab list becomes the left pane. */
  tileTabs: function (tabAId, tabBId, activeTabId = tabBId) {
    const indexA = tabs.getIndex(tabAId)
    const indexB = tabs.getIndex(tabBId)
    if (indexA < 0 || indexB < 0 || tabAId === tabBId) {
      return
    }

    let group = splitView.getGroupForTab(tabAId) || splitView.getGroupForTab(tabBId)
    if (!group) {
      group = {
        paneTabIds: [tabAId, tabBId],
        activePane: 0,
        fractions: evenFractions(2)
      }
      splitView.groups.push(group)
    } else if (!group.paneTabIds.includes(tabBId)) {
      // a tab may only belong to one group
      splitView.removeTabFromGroups(tabBId, group)
      if (group.paneTabIds.length < maxPanesPerGroup) {
        group.paneTabIds.push(tabBId)
        group.fractions = evenFractions(group.paneTabIds.length)
      } else {
        group.paneTabIds[group.activePane] = tabBId
      }
    }

    // the pane containing the active tab gets focus
    normalizeGroupOrder(group)
    const activePane = group.paneTabIds.indexOf(activeTabId)
    group.activePane = activePane >= 0 ? activePane : 0

    splitView.persist()
    splitView.notifyGroupsChanged()
    splitView.showGroup(splitView.groups.indexOf(group))
  },
  /* removes a tab from the group it is in, keeping the rest of the group
  tiled. When the tab that was being shown is the removed one, the group's
  active pane takes over as the selected tab. */
  untileTab: function (tabId) {
    const group = splitView.getGroupForTab(tabId)
    if (!group) {
      return
    }
    splitView.detachTab(group, tabId)
  },
  /* takes a tab out of a group. The group disappears once it holds fewer than
  two panes; a shown group that survives is laid out again. */
  detachTab: function (group, tabId) {
    const index = group.paneTabIds.indexOf(tabId)
    const groupIndex = splitView.groups.indexOf(group)
    if (index < 0 || groupIndex < 0) {
      return
    }
    const wasShown = splitView.activeGroupIndex === groupIndex
    const wasActiveTab = wasShown && splitView.getActiveTabId() === tabId

    group.paneTabIds.splice(index, 1)
    group.fractions.splice(index, 1)

    if (group.paneTabIds.length < 2) {
      // tile relationships need at least two tabs
      splitView.removeGroup(groupIndex, group.paneTabIds[0])
      return
    }

    // the panes that are left share the whole width, keeping their proportions
    const remaining = group.fractions.reduce((a, b) => a + b, 0)
    if (remaining > 0) {
      group.fractions = group.fractions.map(fraction => fraction / remaining)
    }

    if (group.activePane > index) {
      group.activePane--
    } else if (group.activePane >= group.paneTabIds.length) {
      group.activePane = group.paneTabIds.length - 1
    }

    if (wasShown) {
      const activeId = group.paneTabIds[group.activePane]
      if (wasActiveTab) {
        tabs.setSelected(activeId)
      }
      splitView.applyLayout()
      splitView.webviews.resize()
    }

    splitView.persist()
    splitView.notifyGroupsChanged()
  },
  /* removes a tab from every group except `keep`, so a tab never ends up in
  two groups at once */
  removeTabFromGroups: function (tabId, keep) {
    splitView.groups.slice().forEach(function (group) {
      if (group !== keep && group.paneTabIds.includes(tabId)) {
        splitView.detachTab(group, tabId)
      }
    })
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
    splitView.persist()

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
    splitView.persist()
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
  /* takes tabId out of every group it belongs to. The group survives if it
  still holds two panes, so closing one pane of A+B+C leaves A+C tiled. */
  handleTabDestroyed: function (tabId) {
    splitView.groups.slice().forEach(function (group) {
      if (group.paneTabIds.includes(tabId)) {
        splitView.detachTab(group, tabId)
      }
    })
  },
  /* called from browserUI.switchToTab while split: switches which pane is active,
  shows the group of the clicked tab if it belongs to a paused group, or pauses
  the shown group and shows the clicked tab full-window. */
  setActiveTab: function (tabId) {
    const shownGroup = splitView.getActiveGroup()

    if (shownGroup) {
      const paneIndex = shownGroup.paneTabIds.indexOf(tabId)
      if (paneIndex >= 0) {
        shownGroup.activePane = paneIndex
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
  is moved. Groups whose tabs were moved away lose those panes, and a group
  that drops below two panes is destroyed. */
  handleTabReorder: function () {
    if (splitView.groups.length === 0) {
      return
    }

    splitView.groups.slice().forEach(function (group) {
      group.paneTabIds.slice().forEach(function (tabId) {
        if (tabs.getIndex(tabId) < 0) {
          splitView.detachTab(group, tabId)
        }
      })
    })
    if (splitView.groups.length === 0) {
      return
    }

    splitView.groups.forEach(function (group) {
      normalizeGroupOrder(group)
    })

    if (splitView.isSplit()) {
      splitView.applyLayout()
    }
    splitView.persist()
    splitView.notifyGroupsChanged()
  },
  /* moves the boundary between pane `index` and pane `index + 1` to windowX,
  keeping the combined width of the two panes constant. liveResize skips the
  full setSplitView IPC (which detaches and re-attaches views) and only resizes
  the existing views, which is what we want while dragging a divider. */
  setDividerPosition: function (index, windowX, liveResize = false) {
    const group = splitView.getActiveGroup()
    if (!group || index < 0 || index >= group.paneTabIds.length - 1) {
      return
    }

    const full = splitView.webviews.getViewBounds(group.paneTabIds[group.activePane], true)
    const count = group.paneTabIds.length
    const available = Math.max(0, full.width - gutterWidth * (count - 1))
    if (available <= 0) {
      return
    }
    const minFraction = Math.min(minPaneWidth, Math.floor(available / count)) / available

    // the boundary sits after the panes to its left, plus the gutters before it
    const fractionBefore = group.fractions.slice(0, index).reduce((a, b) => a + b, 0)
    const leftOfBoundary = available * fractionBefore + gutterWidth * index
    const pairTotal = group.fractions[index] + group.fractions[index + 1]

    // the two panes keep their combined width, so only the split between them changes
    const upperBound = Math.max(minFraction, pairTotal - minFraction)
    const leftFraction = Math.min(Math.max((windowX - full.x - leftOfBoundary) / available, minFraction), upperBound)

    group.fractions[index] = leftFraction
    group.fractions[index + 1] = pairTotal - leftFraction

    splitView.persist()
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
  /* pane widths in pixels for the full view width. The stored fractions are
  clamped so no pane is narrower than minPaneWidth, and the result always adds
  up to the width that is left between the gutters. */
  computePaneWidths: function (group, totalWidth) {
    const count = group.paneTabIds.length
    const available = Math.max(0, totalWidth - gutterWidth * (count - 1))
    const minWidth = Math.min(minPaneWidth, Math.floor(available / count))
    const maxWidth = Math.max(minWidth, available - minWidth * (count - 1))

    const widths = group.fractions.map(fraction => Math.round(available * fraction))
    for (let i = 0; i < count; i++) {
      widths[i] = Math.min(Math.max(widths[i], minWidth), maxWidth)
    }

    // rounding and clamping can leave a few pixels over; hand them back to the
    // panes that still have room
    let remainder = available - widths.reduce((a, b) => a + b, 0)
    for (let i = 0; i < count && remainder !== 0; i++) {
      const target = Math.min(Math.max(widths[i] + remainder, minWidth), maxWidth)
      remainder -= target - widths[i]
      widths[i] = target
    }

    return widths
  },
  /* computes the bounds for each pane: the panes sit side by side in tab bar
  order, separated by a gutter */
  getBounds: function () {
    const group = splitView.getActiveGroup()
    if (!group) {
      return []
    }
    const full = splitView.webviews.getViewBounds(group.paneTabIds[group.activePane], true)
    const bounds = []
    let x = full.x

    splitView.computePaneWidths(group, full.width).forEach(function (width) {
      bounds.push({
        x: x,
        y: full.y,
        width: width,
        height: full.height
      })
      x += width + gutterWidth
    })

    return bounds
  },
  /* the left edge of the boundary between pane `index` and pane `index + 1` */
  getDividerLeft: function (index) {
    const group = splitView.getActiveGroup()
    if (!group) {
      return null
    }
    const full = splitView.webviews.getViewBounds(group.paneTabIds[group.activePane], true)
    const widths = splitView.computePaneWidths(group, full.width)
    let x = full.x
    for (let i = 0; i < index; i++) {
      x += widths[i] + gutterWidth
    }
    return x + widths[index]
  },
  getBoundsForTab: function (tabId) {
    const group = splitView.getActiveGroup()
    if (!group) {
      return null
    }
    const paneIndex = group.paneTabIds.indexOf(tabId)
    if (paneIndex < 0) {
      return null
    }
    return splitView.getBounds()[paneIndex] || null
  },
  /* removes both the visible split and all paused groups from the window.
  Workspace/profile/task lifecycle changes use this instead of destroy(), since
  paused groups are otherwise left behind and can later point at unrelated
  tabs. The selected task keeps its saved layout: this only tears down what the
  window is showing, so selecting the task again restores it. */
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
    splitView.tileTabs(anchorTabId, clickedTabId)
  }
}

module.exports = splitView
