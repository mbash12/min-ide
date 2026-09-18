/* VSCode-style editor tabs for workspace files. Single-clicking a file in
the sidebar tree (or picking it from the !file bang) opens a temporary
"preview" tab (shown in italic). Opening another file reuses the same
preview tab; double-clicking the tab (or its file row) pins it, so it stops
being replaced and behaves like a regular tab. */

const EDITOR_BASE = 'min://app/pages/editor/index.html'

const editorView = {
  /* the URL for an editor tab showing filePath */
  getEditorURL: function (filePath) {
    const ws = typeof workspaces !== 'undefined' && workspaces.getSelected ? workspaces.getSelected() : null
    let url = EDITOR_BASE + '?path=' + encodeURIComponent(filePath)
    if (ws && ws.path) {
      url += '&workspace=' + encodeURIComponent(ws.path)
    }
    return url
  },

  isEditorURL: function (url) {
    return typeof url === 'string' && url.startsWith(EDITOR_BASE)
  },

  isEditorTab: function (tabId) {
    return editorView.isEditorURL(tabs.get(tabId)?.url)
  },

  /* The editor page reports its dirty state through the view IPC bridge. Keep
  the confirmation here so every host action (close, profile switch, archive,
  and preview replacement) uses the same small guard. */
  isDirty: function (tabId) {
    const webviews = require('webviews.js')
    return editorView.isEditorTab(tabId) && webviews.isEditorDirty(tabId)
  },
  confirmDiscard: function (tabId) {
    if (!editorView.isDirty(tabId)) {
      return true
    }

    const tab = tabs.get(tabId)
    const name = tab && tab.title ? ' in "' + tab.title + '"' : ''
    return typeof confirm !== 'function' || confirm('Discard unsaved changes' + name + '?')
  },
  allowDiscard: function (tabId) {
    const webviews = require('webviews.js')
    if (!editorView.isDirty(tabId)) {
      return
    }

    // Clear the renderer-side state immediately, then let the page disable
    // its own beforeunload warning before the view is destroyed or navigated.
    webviews.setEditorDirty(tabId, false)
    if (webviews.hasViewForTab(tabId)) {
      webviews.callAsync(tabId, 'executeJavaScript', 'window.editorAllowUnload && window.editorAllowUnload()')
    }
  },

  /* extracts the file path from an editor tab's URL */
  getFilePath: function (tabId) {
    const tab = tabs.get(tabId)
    if (!tab || !editorView.isEditorURL(tab.url)) {
      return null
    }
    try {
      return decodeURIComponent(new URL(tab.url).searchParams.get('path')) || null
    } catch (e) {
      return null
    }
  },

  /* finds an existing pinned (non-preview) editor tab for filePath in the
  selected task, so opening the same file twice focuses it instead of
  creating a duplicate */
  findPinnedTab: function (filePath) {
    return tabs.get().find(function (tab) {
      if (tab.preview || !editorView.isEditorURL(tab.url)) {
        return false
      }
      try {
        return decodeURIComponent(new URL(tab.url).searchParams.get('path')) === filePath
      } catch (e) {
        return false
      }
    })?.id || null
  },

  /* the current preview tab of the selected task, or null */
  findPreviewTab: function () {
    return tabs.get().find(function (tab) {
      return tab.preview && editorView.isEditorURL(tab.url)
    })?.id || null
  },

  /* opens filePath in the editor. Implements the preview behavior:
  - reuses and switches to an existing pinned tab for this file
  - if the preview tab already shows this file, just focus it
  - otherwise repoints the existing preview tab to this file
  - otherwise creates a new preview tab
  Returns the tab id that now shows the file. */
  openFile: function (filePath) {
    const browserUI = require('browserUI.js')

    const pinnedId = editorView.findPinnedTab(filePath)

    if (pinnedId) {
      browserUI.switchToTab(pinnedId)
      return pinnedId
    }

    const previewId = editorView.findPreviewTab()

    if (previewId) {
      const previewPath = editorView.getFilePath(previewId)
      if (previewPath === filePath) {
        browserUI.switchToTab(previewId)
        return previewId
      }
      if (!editorView.confirmDiscard(previewId)) {
        return previewId
      }
      const url = editorView.getEditorURL(filePath)
      editorView.allowDiscard(previewId)
      tabs.update(previewId, { url: url })
      require('webviews.js').update(previewId, url)
      browserUI.switchToTab(previewId)
      return previewId
    }

    // no preview tab exists yet - create one
    const tabId = tabs.add({
      url: editorView.getEditorURL(filePath),
      private: false
    })

    // tabs.add() drops unknown properties, so the preview flag has to be
    // set afterwards
    tabs.update(tabId, { preview: true })

    browserUI.addTab(tabId, { enterEditMode: false })

    return tabId
  },

  /* pins the given tab so it stops being replaced by future files */
  pinTab: function (tabId) {
    if (tabs.get(tabId)?.preview) {
      tabs.update(tabId, { preview: false })
    }
  }
}

// when a preview tab is edited, make it persistent (VSCode behavior)
try {
  const webviews = require('webviews.js')
  webviews.bindIPC('editorBecomeDirty', function (tabId, args) {
    const isDirty = !args || args[0] !== false
    webviews.setEditorDirty(tabId, isDirty)
    if (tabs.get(tabId)?.preview) {
      if (isDirty) {
        tabs.update(tabId, { preview: false })
      }
    }
  })

  // App/window close is the one destruction path that does not pass through
  // browserUI. The main renderer's beforeunload event gives Electron a chance
  // to ask before any dirty editor view is torn down with the window.
  window.addEventListener('beforeunload', function (e) {
    if (Object.keys(webviews.editorDirtyTabs).some(function (tabId) {
      return webviews.isEditorDirty(tabId)
    })) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
} catch (e) {}

module.exports = editorView
