/* global ipc, MouseEvent */
const webviews = require('webviews.js')
const uiStateDB = require('util/uiStateDB.js')
const fileTree = require('sidebar/fileTree.js')
const gitPanel = require('sidebar/gitPanel.js')
const playbookPanel = require('sidebar/playbookPanel.js')
const agentPanel = require('sidebar/agentPanel.js')
const designPanel = require('sidebar/designPanel.js')
const docsPanel = require('sidebar/docsPanel.js')
const proSettingsPage = require('util/proSettingsPage.js')

/*
VSCode-style sidebar: a vertical activity bar with tab icons and a panel that
holds the content of the active tab.

- The navbar toggle button shows/hides the whole sidebar.
- Clicking an activity bar tab switches the panel; clicking the active tab
  again collapses/expands the panel (like VSCode).
- Dragging the resizer on the panel's right edge changes the panel width.
- When visible, the sidebar shifts the webviews (it never overlays them).
- The sidebar state (visibility, active tab, panel width) is scoped to the
  selected workspace and persisted in IndexedDB, so each workspace remembers
  its own layout across restarts.

Files, Source Control, Playbook, AI, Design, and Docs are populated by their own
modules. Docs is workspace-scoped and remains available even when a workspace
does not have a folder path.
*/

const sidebarMinPanelWidth = 180
const sidebarMaxPanelWidth = 640
/* tracked separately from the DOM: offsetWidth reads 0 while the sidebar or
the panel is display:none, so it can't be used for persistence */
let currentPanelWidth = 300

const sidebarEl = document.getElementById('sidebar')
const toggleButton = document.getElementById('sidebar-toggle-button')
const activityBar = sidebarEl.querySelector('#activity-bar')
const panelsEl = sidebarEl.querySelector('#sidebar-panels')
const resizer = sidebarEl.querySelector('#sidebar-resizer')
const ntpContent = document.getElementById('ntp-content')
const activityTabs = Array.from(document.querySelectorAll('.activity-bar-tab[data-sidebar-tab]'))
const settingsButton = document.getElementById('sidebar-settings-button')
const panels = Array.from(document.querySelectorAll('.sidebar-panel'))

function clampPanelWidth (width) {
  return Math.round(Math.min(sidebarMaxPanelWidth, Math.max(sidebarMinPanelWidth, width)))
}

function applyPanelWidthToDom () {
  panelsEl.style.width = currentPanelWidth + 'px'
}

const sidebar = {
  isVisible: false, // whether the whole sidebar (activity bar + panel) is shown
  activeTab: null, // 'ai' | 'files' | 'git' | 'playbook' | 'design' | 'docs'
  panelVisible: false, // whether the panel is expanded next to the activity bar
  currentShift: 0, // webview left margin currently applied
  currentWorkspaceId: null, // workspace the current state belongs to

  /* tabs that need a workspace path: hidden when the selected workspace has
  no path (like VSCode hiding Source Control without a folder). Playbook stays
  available — it can store automations per workspace without a folder. */
  pathTabs: ['files', 'git', 'design'],

  /* keeps the activity bar tabs that require a workspace path in sync with
  the selected workspace. Returns true when the active tab was hidden and the
  sidebar had to switch to another tab. */
  updatePathTabs: function () {
    const ws = workspaces.getSelected()
    let hasPath = !!(ws && ws.path)
    if (hasPath) {
      // a folder that was deleted or moved makes the workspace browser-only
      // until the user picks a new one; while the check is running the tabs
      // stay visible so a valid folder is never hidden for a moment
      const pathStatus = require('workspacePathStatus.js')
      pathStatus.refresh(ws)
      if (pathStatus.isUsable(ws.id) === false) {
        hasPath = false
      }
    }
    let activeHidden = false
    sidebar.pathTabs.forEach(function (tabId) {
      const tab = document.getElementById('sidebar-tab-' + tabId)
      const panelEl = document.getElementById('sidebar-panel-' + tabId)
      const hidden = !hasPath
      if (tab) tab.hidden = hidden
      if (panelEl) panelEl.hidden = hidden
      if (hidden && sidebar.activeTab === tabId) {
        activeHidden = true
      }
    })
    const playbookTab = document.getElementById('sidebar-tab-playbook')
    const playbookPanelEl = document.getElementById('sidebar-panel-playbook')
    if (playbookTab) playbookTab.hidden = false
    if (playbookPanelEl) playbookPanelEl.hidden = false
    if (activeHidden) {
      // fall back to the AI tab (always available)
      sidebar.activeTab = 'ai'
      sidebar.panelVisible = true
      sidebar.syncTabUI()
      sidebar.updateLayout()
      sidebar.persistState()
    }
    return activeHidden
  },

  /* total width the sidebar currently occupies (0 when hidden) */
  getShift: function () {
    if (!sidebar.isVisible) {
      return 0
    }
    // Measure the sidebar instead of summing the parts: the resizer strip is
    // part of its width, and the native views must start *after* it. Views
    // always paint above the renderer, so any overlap makes the strip
    // impossible to grab.
    return Math.round(sidebarEl.getBoundingClientRect().width)
  },

  /* applies the sidebar width to the webview margins and NTP background so
  the page content is pushed aside instead of covered */
  updateLayout: function () {
    const target = sidebar.getShift()
    const delta = target - sidebar.currentShift
    if (delta !== 0) {
      webviews.adjustMargin([0, 0, 0, delta])
      sidebar.currentShift = target
    }
    if (ntpContent) {
      ntpContent.style.marginLeft = sidebar.currentShift + 'px'
      ntpContent.style.width = 'calc(100% - ' + sidebar.currentShift + 'px)'
    }
  },

  show: function (tabId) {
    if (tabId) {
      sidebar.activeTab = tabId
      sidebar.panelVisible = true
    }
    sidebar.isVisible = true
    sidebarEl.hidden = false
    if (toggleButton) toggleButton.classList.add('active')
    sidebar.syncTabUI()
    sidebar.updateLayout()
    sidebar.persistState()
  },

  hide: function () {
    sidebar.isVisible = false
    sidebarEl.hidden = true
    if (toggleButton) toggleButton.classList.remove('active')
    sidebar.updateLayout()
    sidebar.persistState()
  },

  toggle: function () {
    if (sidebar.isVisible) {
      sidebar.hide()
    } else {
      sidebar.show()
    }
  },

  /* switches the active tab, or collapses/expands the panel when the active
  tab is clicked again (VSCode behavior) */
  selectTab: function (tabId) {
    if (sidebar.activeTab === tabId) {
      sidebar.panelVisible = !sidebar.panelVisible
    } else {
      sidebar.activeTab = tabId
      sidebar.panelVisible = true
    }
    sidebar.syncTabUI()
    sidebar.updateLayout()
    sidebar.persistState()
  },

  /* sets the panel width (clamped) and refreshes the layout */
  setPanelWidth: function (width) {
    currentPanelWidth = clampPanelWidth(width)
    applyPanelWidthToDom()
    sidebar.updateLayout()
    sidebar.persistState()
    return currentPanelWidth
  },

  /* returns the current state object for persistence */
  getState: function () {
    return {
      isVisible: sidebar.isVisible,
      activeTab: sidebar.activeTab,
      panelVisible: sidebar.panelVisible,
      panelWidth: currentPanelWidth
    }
  },

  /* applies a state object (from the db or defaults) to the UI */
  applyState: function (state) {
    state = state || {}
    sidebar.activeTab = state.activeTab || null
    sidebar.panelVisible = !!state.panelVisible && !!sidebar.activeTab
    if (state.panelWidth) {
      currentPanelWidth = clampPanelWidth(state.panelWidth)
      applyPanelWidthToDom()
    }
    sidebar.isVisible = !!state.isVisible
    sidebarEl.hidden = !sidebar.isVisible
    if (toggleButton) toggleButton.classList.toggle('active', sidebar.isVisible)
    sidebar.syncTabUI()
    sidebar.updateLayout()
  },

  /* saves the current state under the current workspace's key */
  persistState: function () {
    if (!sidebar.currentWorkspaceId) {
      return
    }
    uiStateDB.setSidebarState('workspace:' + sidebar.currentWorkspaceId, sidebar.getState())
  },

  /* switches the sidebar to the given workspace's persisted state */
  switchToWorkspace: async function (workspaceId) {
    if (workspaceId === sidebar.currentWorkspaceId) {
      return
    }
    // save the outgoing workspace's state first
    sidebar.persistState()
    sidebar.currentWorkspaceId = workspaceId
    const savedState = workspaceId ? await uiStateDB.getSidebarState('workspace:' + workspaceId) : null
    sidebar.applyState(savedState)
  },

  /* keeps the .active classes and placeholder labels in sync with the state */
  syncTabUI: function () {
    const panelShown = sidebar.isVisible && sidebar.panelVisible && !!sidebar.activeTab
    sidebarEl.classList.toggle('panel-collapsed', !panelShown)
    activityTabs.forEach(function (button) {
      const tabId = button.getAttribute('data-sidebar-tab')
      button.classList.toggle('active', sidebar.isVisible && tabId === sidebar.activeTab)
    })
    panels.forEach(function (panel) {
      const tabId = panel.getAttribute('data-sidebar-panel')
      panel.classList.toggle('active', panelShown && tabId === sidebar.activeTab)
    })
  },

  initialize: function () {
    // files, git, playbook, AI, design, and Docs panels are populated by their
    // own modules. Docs is intentionally not path-dependent.

    if (toggleButton) {
      toggleButton.addEventListener('click', function (e) {
        e.stopPropagation()
        sidebar.toggle()
      })
    }

    if (settingsButton) {
      settingsButton.title = l('viewSettings')
      settingsButton.addEventListener('click', function (e) {
        e.stopPropagation()
        proSettingsPage.open()
      })
    }

    activityTabs.forEach(function (button) {
      button.addEventListener('click', function (e) {
        e.stopPropagation()
        const tabId = button.getAttribute('data-sidebar-tab')
        if (!sidebar.isVisible) {
          sidebar.show(tabId)
        } else {
          sidebar.selectTab(tabId)
        }
      })
    })

    /* resizing: dragging the resizer changes the panel width. While the drag
    passes over the webviews (native views on top of the renderer), mouse
    events are relayed back through the 'view-mouse-event' IPC channel, the
    same way splitViewDivider does it. */
    let sidebarDragState = null

    function applyPanelWidth (windowX) {
      if (!sidebarDragState) return
      sidebar.setPanelWidth(windowX - sidebarDragState.startBarWidth)
    }

    function startSidebarDrag (e) {
      e.preventDefault()
      if (!sidebar.panelVisible) {
        // nothing to resize while only the activity bar is shown
        return
      }
      sidebarDragState = {
        startBarWidth: activityBar.offsetWidth,
        startPanelWidth: currentPanelWidth
      }

      function onMouseMove (moveEvent) {
        applyPanelWidth(moveEvent.clientX)
      }

      function onMouseUp () {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.classList.remove('is-resizing-sidebar')
        sidebarDragState = null
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      document.body.classList.add('is-resizing-sidebar')
    }

    if (resizer) {
      resizer.title = l('sidebarResize')
      resizer.addEventListener('mousedown', startSidebarDrag)

      ipc.on('view-mouse-event', function (e, args) {
        if (!sidebarDragState) return
        if (args.type === 'mousemove') {
          // prefer the window-relative cursor position: the page-relative x
          // shifts as the sidebar resizes the views, so converting it back to
          // window coordinates would double-count the movement
          if (typeof args.windowX === 'number') {
            applyPanelWidth(args.windowX)
          } else {
            applyPanelWidth(sidebar.currentShift + args.x)
          }
        } else if (args.type === 'mouseup') {
          document.dispatchEvent(new MouseEvent('mouseup'))
        }
      })
    }

    /* per-workspace state: save on switch, restore the new workspace's state.
    'workspace-selected' fires from WorkspaceStore.setSelected. */
    workspaces.on('workspace-selected', function (workspaceId) {
      sidebar.switchToWorkspace(workspaceId)
      sidebar.updatePathTabs()
    })
    workspaces.on('state-sync-change', function () {
      // workspace path may have been added/removed (e.g. via the modal)
      sidebar.updatePathTabs()
    })
    workspaces.on('workspace-updated', function (id, key) {
      if (key === 'path') {
        const selected = workspaces.getSelected()
        if (selected && id === selected.id) {
          sidebar.updatePathTabs()
        }
      }
    })

    /* the path check finishes after updatePathTabs has already run, so re-run
    it once the answer is in */
    require('workspacePathStatus.js').onChange(function () {
      sidebar.updatePathTabs()
    })

    // initial load: bind to the workspace selected during session restore
    const bindInitialState = function () {
      const selected = workspaces.getSelected()
      if (selected) {
        const id = selected.id
        sidebar.currentWorkspaceId = id
        uiStateDB.getSidebarState('workspace:' + id).then(function (state) {
          // only apply if the workspace hasn't switched while loading
          if (sidebar.currentWorkspaceId === id) {
            sidebar.applyState(state)
            sidebar.updatePathTabs()
          }
        })
      } else {
        // no workspace yet: hide path-dependent tabs
        sidebar.updatePathTabs()
      }
    }
    bindInitialState()

    fileTree.initialize()
    gitPanel.initialize()
    playbookPanel.initialize()
    agentPanel.initialize()
    designPanel.initialize()
    docsPanel.initialize()

    window.sidebar = sidebar
  }
}

module.exports = sidebar
