/* VSCode-style editor tabs for workspace files. Single-clicking a file in
the sidebar tree (or picking it from the !file bang) opens a temporary
"preview" tab (shown in italic). Opening another file reuses the same
preview tab; double-clicking the tab (or its file row) pins it, so it stops
being replaced and behaves like a regular tab. */

const EDITOR_BASE = 'min://app/pages/editor/index.html'
const DIFF_BASE = 'min://app/pages/diff/index.html'

const editorView = {
  /* the URL of an editor tab. It is deliberately generic: the file lives in
  the tab's `resource` and reaches the page through the preload bridge, so no
  workspace path ends up in the address bar or in the saved session. */
  getEditorURL: function () {
    return EDITOR_BASE
  },

  /* tabs carry their kind, which is what everything else keys off */
  isEditorTabData: function (tab) {
    return !!tab && tab.kind === 'editor'
  },

  isEditorTab: function (tabId) {
    return editorView.isEditorTabData(tabs.get(tabId))
  },

  /* diff tabs show a git comparison instead of a plain file */
  isDiffTabData: function (tab) {
    return !!tab && tab.kind === 'diff'
  },

  isDiffTab: function (tabId) {
    return editorView.isDiffTabData(tabs.get(tabId))
  },

  /* The editor page reports its dirty state through the view IPC bridge. Keep
  the confirmation here so every host action (close, profile switch, archive,
  and preview replacement) uses the same small guard. */
  isDirty: function (tabId) {
    const webviews = require('webviews.js')
    return (editorView.isEditorTab(tabId) || editorView.isDiffTab(tabId)) && webviews.isEditorDirty(tabId)
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

  /* the file an editor tab shows, kept on the tab itself */
  getFilePath: function (tabId) {
    const tab = tabs.get(tabId)
    if (!editorView.isEditorTabData(tab)) {
      return null
    }
    return tab.resource || null
  },

  /* finds an existing pinned (non-preview) editor tab for filePath in the
  selected task, so opening the same file twice focuses it instead of
  creating a duplicate */
  findPinnedTab: function (filePath) {
    return tabs.get().find(function (tab) {
      return !tab.preview && editorView.isEditorTabData(tab) && tab.resource === filePath
    })?.id || null
  },

  /* the current preview tab of the selected task, or null. Editor and diff
  tabs share one slot, like VSCode's single preview editor */
  findPreviewTab: function () {
    return tabs.get().find(function (tab) {
      return tab.preview && (editorView.isEditorTabData(tab) || editorView.isDiffTabData(tab))
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
      const url = editorView.getEditorURL()
      editorView.allowDiscard(previewId)
      // a diff preview may be repurposed here; drop its descriptor
      tabs.update(previewId, { url: url, kind: 'editor', resource: filePath, diff: null })
      // the URL does not change, so the view has to be told about the new file
      // and reloaded for the page to pick it up
      require('webviews.js').updateResource(previewId)
      require('webviews.js').update(previewId, url)
      browserUI.switchToTab(previewId)
      return previewId
    }

    // no preview tab exists yet - create one
    const tabId = tabs.add({
      url: editorView.getEditorURL(),
      kind: 'editor',
      resource: filePath,
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
  },

  /* opens a git diff as an editor tab, reusing the shared preview slot.
  desc: { cwd, resource, title, left: {type, ref, path}, right: {...},
  editable } - the descriptor is stored on the tab so a restored session
  re-resolves the contents instead of keeping them in the saved state */
  openDiff: function (desc) {
    const browserUI = require('browserUI.js')
    const key = JSON.stringify(desc)

    // the same diff is already open (preview or pinned): just focus it
    const existing = tabs.get().find(function (tab) {
      return editorView.isDiffTabData(tab) && tab.diff && JSON.stringify(tab.diff) === key
    })
    if (existing) {
      browserUI.switchToTab(existing.id)
      return existing.id
    }

    const previewId = editorView.findPreviewTab()

    if (previewId) {
      if (!editorView.confirmDiscard(previewId)) {
        return previewId
      }
      editorView.allowDiscard(previewId)
      tabs.update(previewId, { url: DIFF_BASE, kind: 'diff', resource: desc.resource, diff: desc })
      // the URL does not change, so the view has to be told about the new
      // resource (and the new diff extras) and reloaded
      require('webviews.js').updateResource(previewId)
      require('webviews.js').update(previewId, DIFF_BASE)
      browserUI.switchToTab(previewId)
      return previewId
    }

    const tabId = tabs.add({
      url: DIFF_BASE,
      kind: 'diff',
      resource: desc.resource,
      private: false
    })

    // tabs.add() drops unknown properties, so preview and the descriptor
    // have to be set afterwards
    tabs.update(tabId, { preview: true, diff: desc })

    browserUI.addTab(tabId, { enterEditMode: false })

    return tabId
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
