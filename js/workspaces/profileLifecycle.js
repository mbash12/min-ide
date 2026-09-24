/* global ipc */
const profiles = require('profiles.js')

module.exports = function ({ workspaces, tasks, splitView, editorView, webviews, confirmDiscardTabs, switchToTab, addTab }) {
  /* changes the profile (session partition) used by a workspace. Only web tab
  views are recreated: a partition is a creation-time webPreference, so it
  cannot be swapped on a live webContents - the web tabs' views are destroyed
  and lazily rebuilt on the new partition, while editor/terminal/document/note
  tabs, tasks, and the split layout all stay untouched. Private tabs keep their
  own per-tab partition and are not affected either. */

  function setWorkspaceProfile (workspaceId, profileId, options) {
    options = options || {}
    var ws = workspaces.get(workspaceId)
    if (!ws) {
      return false
    }

    if (ws.profileId === profileId) {
      return true
    }

    // update the record first so any view recreated from now on gets the new
    // partition
    workspaces.update(workspaceId, { profileId: profileId })

    const isSelected = !!(workspaces.getSelected() && workspaces.getSelected().id === workspaceId)
    const selectedTabId = isSelected && tasks.getSelected() && tasks.getSelected().tabs.getSelected()

    ws.tasks.forEach(function (task) {
      task.tabs.get().forEach(function (tab) {
        if ((tab.kind || 'web') !== 'web' || tab.private) {
          return
        }
        webviews.destroy(tab.id, { preserveSplit: true })
      })
    })

    if (isSelected) {
      // rebuild the visible surface: showSplit recreates missing pane views,
      // switchToTab recreates a destroyed selected tab (no-op for live views)
      if (splitView.isSplit()) {
        splitView.showSplit()
      }
      if (selectedTabId) {
        switchToTab(selectedTabId, { focusWebview: true })
      } else if (tasks.getSelected() && tasks.getSelected().tabs.count() === 0) {
        addTab()
      }
    }
    return true
  }

  /* Handles a profile being deleted from Pro Settings. The live workspace
  assignment is updated first, and all old views are recreated lazily against
  the default partition instead of leaving the deleted profile id in memory. */
  function getProfileDeletionTasks (profileId) {
    const affected = []
    workspaces.forEach(function (ws) {
      if (ws.profileId === profileId) {
        ws.tasks.forEach(function (task) {
          affected.push({ workspace: ws, task: task })
        })
      }
    })
    return affected
  }

  function confirmProfileDeletion (profileId) {
    const affectedTasks = getProfileDeletionTasks(profileId)
    const affectedTabs = []
    affectedTasks.forEach(function (entry) {
      affectedTabs.push.apply(affectedTabs, entry.task.tabs.get())
    })
    return confirmDiscardTabs(affectedTabs)
  }

  function applyProfileDeleted (profileId) {
    if (!profileId) {
      return false
    }

    workspaces.filter(ws => ws.profileId === profileId).forEach(ws => {
      setWorkspaceProfile(ws.id, null)
    })
    return true
  }

  function handleProfileDeleted (profileId) {
    if (!profileId || !confirmProfileDeletion(profileId)) {
      return false
    }
    return applyProfileDeleted(profileId)
  }

  /* Workspace names that currently use a profile (archived ones count - the
  profile is still assigned to them). Deletion is blocked while this is
  non-empty, per the blueprint's "profile tidak boleh dihapus selama masih
  digunakan Workspace". */
  function getProfileUsageWorkspaces (profileId) {
    const names = []
    workspaces.forEach(function (ws) {
      if (ws.profileId === profileId) {
        names.push(ws.name || ws.id)
      }
    })
    return names
  }

  /* Clears selected data types on a profile's session partition, then reloads
  the live web tabs of every workspace that uses it so the effect (e.g. being
  logged out) is visible immediately. Non-web tabs are left alone - editors,
  terminals, documents and notes do not depend on site storage. Tabs whose
  views were never created just pick up the cleared partition when they are
  opened. `profileId` null means the default profile (persist:webcontent). */
  function clearProfileData (profileId, types) {
    const partition = profiles.getPartition(profileId) || 'persist:webcontent'
    return ipc.invoke('clearProfileData', { partition: partition, types: types }).then(function (ok) {
      if (!ok) {
        return { ok: false }
      }
      var reloaded = 0
      workspaces.forEach(function (ws) {
        if ((ws.profileId || null) !== (profileId || null)) {
          return
        }
        ws.tasks.forEach(function (task) {
          task.tabs.get().forEach(function (tab) {
            if ((tab.kind || 'web') !== 'web' || !webviews.hasViewForTab(tab.id)) {
              return
            }
            webviews.callAsync(tab.id, 'reload')
            reloaded++
          })
        })
      })
      return { ok: true, reloaded: reloaded }
    }, function () {
      return { ok: false }
    })
  }

  return { setWorkspaceProfile, handleProfileDeleted, applyProfileDeleted, getProfileUsageWorkspaces, clearProfileData }
}
