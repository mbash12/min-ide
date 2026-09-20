var urlParser = require('util/urlParser.js')
var settings = require('util/settings/settings.js')

/* implements selecting webviews, switching between them, and creating new ones. */

var hasSeparateTitlebar = settings.get('useSeparateTitlebar')
var windowIsMaximized = false // affects navbar height on Windows
var windowIsFullscreen = false

// called whenever a new page starts loading, or an in-page navigation occurs
function onPageURLChange (tab, url) {
  if (url.indexOf('https://') === 0 || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('file://') === 0 || url.indexOf('min://') === 0) {
    tabs.update(tab, {
      secure: true,
      url: url
    })
  } else {
    tabs.update(tab, {
      secure: false,
      url: url
    })
  }

  webviews.callAsync(tab, 'setVisualZoomLevelLimits', [1, 3])
}

// called whenever a navigation finishes
function onNavigate (tabId, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
  if (isMainFrame) {
    onPageURLChange(tabId, url)
  }
}

// called whenever the page finishes loading
function onPageLoad (tabId) {
  // page preview capture is disabled: the stale screenshot placeholder looked
  // like a broken blur overlay when the drawer was open
}

function scrollOnLoad (tabId, scrollPosition) {
  const listener = function (eTabId) {
    if (eTabId === tabId) {
      // the scrollable content may not be available until some time after the load event, so attempt scrolling several times
      // but stop once we've successfully scrolled once so we don't overwrite user scroll attempts that happen later
      for (let i = 0; i < 3; i++) {
        var done = false
        setTimeout(function () {
          if (!done) {
            webviews.callAsync(tabId, 'executeJavaScript', `
            (function() {
              window.scrollTo(0, ${scrollPosition})
              return window.scrollY === ${scrollPosition}
            })()
            `, function (err, completed) {
              if (!err && completed) {
                done = true
              }
            })
          }
        }, 750 * i)
      }
      webviews.unbindEvent('did-finish-load', listener)
    }
  }
  webviews.bindEvent('did-finish-load', listener)
}

function setAudioMutedOnCreate (tabId, muted) {
  const listener = function () {
    webviews.callAsync(tabId, 'setAudioMuted', muted)
    webviews.unbindEvent('did-navigate', listener)
  }
  webviews.bindEvent('did-navigate', listener)
}

/* Internal surfaces used to put what they show in the URL query ('path' for the
editor, 'cwd' for the terminal). Tabs opened back then are still in the saved
session, so read it for them; tabs opened now carry it as the tab's resource
instead and never need this. */
function legacyResourceFromURL (url) {
  if (typeof url !== 'string' || !url.startsWith('min://') || url.indexOf('?') === -1) {
    return null
  }
  try {
    const params = new URL(url).searchParams
    return params.get('path') || params.get('cwd') || null
  } catch (e) {
    return null
  }
}

const webviews = {
  viewFullscreenMap: {}, // tabId, isFullscreen
  selectedId: null,
  // Editor pages report their unsaved state through editorView. Keep this in
  // the shared view layer so it is also cleared when a view is recreated by a
  // profile change, navigation, or a remote window update.
  editorDirtyTabs: {},
  placeholderRequests: [],
  asyncCallbacks: {},
  splitProvider: null, // set by splitView.initialize() - provides split view state
  internalPages: {
    error: 'min://app/pages/error/index.html'
  },
  events: [],
  IPCEvents: [],
  hasViewForTab: function(tabId) {
    if (!tabId) return false
    const task = workspaces.findTaskContainingTab(tabId)
    return !!(task && task.tabs.get(tabId) && task.tabs.get(tabId).hasWebContents)
  },
  setEditorDirty: function (tabId, isDirty) {
    if (isDirty) {
      webviews.editorDirtyTabs[tabId] = true
    } else {
      delete webviews.editorDirtyTabs[tabId]
    }
  },
  isEditorDirty: function (tabId) {
    return !!webviews.editorDirtyTabs[tabId]
  },
  bindEvent: function (event, fn) {
    webviews.events.push({
      event: event,
      fn: fn
    })
  },
  unbindEvent: function (event, fn) {
    for (var i = 0; i < webviews.events.length; i++) {
      if (webviews.events[i].event === event && webviews.events[i].fn === fn) {
        webviews.events.splice(i, 1)
        i--
      }
    }
  },
  emitEvent: function (event, tabId, args) {
    if (!webviews.hasViewForTab(tabId)) {
      // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
      return
    }
    webviews.events.forEach(function (ev) {
      if (ev.event === event) {
        ev.fn.apply(this, [tabId].concat(args))
      }
    })
  },
  bindIPC: function (name, fn) {
    webviews.IPCEvents.push({
      name: name,
      fn: fn
    })
  },
  viewMargins: [0, 0, 0, 0], // top, right, bottom, left
  adjustMargin: function (margins) {
    for (var i = 0; i < margins.length; i++) {
      webviews.viewMargins[i] += margins[i]
    }
    webviews.resize()
  },
  getViewBounds: function (tabId = webviews.selectedId, skipSplit = false) {
    // in split view, each pane gets half of the window
    // (skipSplit is used internally when computing the full-window base rect)
    if (!skipSplit && webviews.splitProvider && webviews.splitProvider.isSplit()) {
      const paneBounds = webviews.splitProvider.getBoundsForTab(tabId)
      if (paneBounds) {
        return paneBounds
      }
    }

    if (webviews.viewFullscreenMap[tabId]) {
      return {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      }
    } else {
      if (!hasSeparateTitlebar && (window.platformType === 'linux' || window.platformType === 'windows') && !windowIsMaximized && !windowIsFullscreen) {
        var navbarHeight = 48
      } else {
        var navbarHeight = 36
      }

      const viewMargins = webviews.viewMargins

      let position = {
        x: 0 + Math.round(viewMargins[3]),
        y: 0 + Math.round(viewMargins[0]) + navbarHeight,
        width: window.innerWidth - Math.round(viewMargins[1] + viewMargins[3]),
        height: window.innerHeight - Math.round(viewMargins[0] + viewMargins[2]) - navbarHeight
      }

      return position
    }
  },
  /* what the view for a tab should be told it is showing: the file or folder
  an internal surface points at, plus the workspace it belongs to (the editor
  uses that as its file access boundary). Web tabs have neither. */
  getViewResourceFor: function (tabId) {
    const tab = tabs.get(tabId)
    const home = workspaces.findWorkspaceContainingTab(tabId)
    const out = {
      resource: (tab && tab.resource) || legacyResourceFromURL(tab && tab.url),
      rootPath: (home && home.path) || null
    }
    if (tab && (tab.kind || 'web') !== 'web') {
      // per-surface extras: persisted state and user preferences, read by
      // the page through window.minViewResource.extra (§15, §27)
      const extra = {}
      if (tab.kind === 'terminal') {
        extra.scrollback = tab.terminalScrollback || null
        extra.shell = tab.terminalShell || null
        extra.fontSize = settings.get('terminalFontSize')
      }
      if (tab.kind === 'editor') {
        extra.fontSize = settings.get('editorFontSize')
        extra.tabSize = settings.get('editorTabSize')
        extra.wordWrap = settings.get('editorWordWrap')
      }
      if (tab.kind === 'document' || tab.kind === 'note') {
        extra.defaultMode = settings.get('docsDefaultMode')
      }
      if (Object.keys(extra).length > 0) {
        out.extra = extra
      }
    }
    return out
  },
  /* points an existing view at another file without rebuilding it; the page
  picks the new resource up on its next load */
  updateResource: function (tabId) {
    const viewResource = webviews.getViewResourceFor(tabId)
    ipc.send('setViewResource', {
      id: tabId,
      resource: viewResource.resource,
      rootPath: viewResource.rootPath
    })
  },
  add: function (tabId, existingViewId) {
    var tabData = tabs.get(tabId)

    // needs to be called before the view is created to that its listeners can be registered
    if (tabData.scrollPosition) {
      scrollOnLoad(tabId, tabData.scrollPosition)
    }

    if (tabData.muted) {
      setAudioMutedOnCreate(tabId, tabData.muted)
    }

    // if the tab is private, we want to partition it. See http://electron.atom.io/docs/v0.34.0/api/web-view-tag/#partition
    // since tab IDs are unique, we can use them as partition names
    var partition
    if (tabData.private === true) {
      partition = tabId.toString() // options.tabId is a number, which remote.session.fromPartition won't accept. It must be converted to a string first
    } else if (tabData.url && (function (url) {
      const source = urlParser.getSourceURL(url)
      return source === 'min://profiles' || source.startsWith('min://profiles?') ||
             source === 'min://proSettings' || source.startsWith('min://proSettings?') ||
             url === 'min://profiles' || url.startsWith('min://profiles?') ||
             url === 'min://proSettings' || url.startsWith('min://proSettings?') ||
             url.startsWith('min://app/pages/profiles/') ||
             url.startsWith('min://app/pages/proSettings/')
    })(tabData.url)) {
      // internal UI pages must share the default session with the main window,
      // otherwise their localStorage (workspace profiles) would be isolated
      partition = null
    } else {
      // if the containing workspace uses a profile, its tabs get an
      // isolated session partition (cookies / storage only)
      const home = workspaces.findWorkspaceContainingTab(tabId)
      partition = require('profiles.js').getPartition(home ? home.profileId : null) || 'persist:webcontent'
    }

    const viewResource = webviews.getViewResourceFor(tabId)
    ipc.send('createView', {
      existingViewId,
      id: tabId,
      webPreferences: {
        partition: partition
      },
      boundsString: JSON.stringify(webviews.getViewBounds(tabId)),
      events: webviews.events.map(e => e.event).filter((i, idx, arr) => arr.indexOf(i) === idx),
      resource: viewResource.resource,
      rootPath: viewResource.rootPath,
      extra: viewResource.extra
    })

    if (!existingViewId) {
      if (tabData.url) {
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse(tabData.url) })
      } else if (tabData.private) {
        // workaround for https://github.com/minbrowser/min/issues/872
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse('min://newtab') })
      }
    }

    const ownerTask = workspaces.findTaskContainingTab(tabId)
    if (ownerTask) {
      ownerTask.tabs.update(tabId, {
        hasWebContents: true
      })
    }
  },
  /* true when the user is typing in chrome (sidebar, address bar, etc.) so
  a page view must not steal keyboard focus */
  isChromeFocused: function () {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (el.isContentEditable) return true
    const sidebar = document.getElementById('sidebar')
    return !!(sidebar && sidebar.contains(el))
  },
  setSelected: function (id, options) { // options.focus - whether to focus the view. Defaults to true.
    webviews.emitEvent('view-hidden', webviews.selectedId)

    webviews.selectedId = id

    // create the view if it doesn't already exist
    if (!webviews.hasViewForTab(id)) {
      webviews.add(id)
    }

    if (webviews.placeholderRequests.length > 0) {
      // another overlay is showing; keep the current view detached
      webviews.requestPlaceholder()
      return
    }

    if (webviews.splitProvider && webviews.splitProvider.isSplit()) {
      // in split view, keep both views attached; just switch which one is active
      webviews.splitProvider.setActiveTab(id)
    }

    ipc.send('setView', {
      id: id,
      bounds: webviews.getViewBounds(id),
      focus: !options || options.focus !== false
    })
    webviews.emitEvent('view-shown', id)
  },
  update: function (id, url) {
    ipc.send('loadURLInView', { id: id, url: urlParser.parse(url) })
  },
  destroy: function (id, options) {
    // if the destroyed tab is part of a split view, exit split mode first
    // (this also determines which tab remains visible). preserveSplit skips
    // that teardown for callers that will re-show the same group afterwards
    // (e.g. profile switching recreates web views but keeps the layout).
    if (!(options && options.preserveSplit) &&
      webviews.splitProvider && webviews.splitProvider.getGroupForTab && webviews.splitProvider.getGroupForTab(id)) {
      webviews.splitProvider.handleTabDestroyed(id)
    }

    webviews.emitEvent('view-hidden', id)

    if (webviews.hasViewForTab(id)) {
      const ownerTask = workspaces.findTaskContainingTab(id)
      if (ownerTask) {
        ownerTask.tabs.update(id, {
          hasWebContents: false
        })
      }
    }
    //we may be destroying a view for which the tab object no longer exists, so this message should be sent unconditionally
    ipc.send('destroyView', id)

    delete webviews.viewFullscreenMap[id]
    delete webviews.editorDirtyTabs[id]
    if (webviews.selectedId === id) {
      webviews.selectedId = null
    }
  },
  requestPlaceholder: function (reason) {
    if (reason && !webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.push(reason)
    }
    // no screenshot placeholder — the view is simply detached and the
    // calling overlay (drawer / modal / dialog) covers the gap instead
    setTimeout(function () {
      if (webviews.placeholderRequests.length > 0) {
        ipc.send('hideCurrentView')
        webviews.emitEvent('view-hidden', webviews.selectedId)
      }
    }, 0)
  },
  hidePlaceholder: function (reason) {
    if (webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.splice(webviews.placeholderRequests.indexOf(reason), 1)
    }

    if (webviews.placeholderRequests.length === 0) {
      // multiple things can request a placeholder at the same time, but we should only show the view again if nothing requires a placeholder anymore
      if (webviews.hasViewForTab(webviews.selectedId)) {
        if (webviews.splitProvider && webviews.splitProvider.isSplit()) {
          // re-attach both panes
          ipc.send('setSplitView', {
            ids: webviews.splitProvider.getPaneIds(),
            bounds: webviews.splitProvider.getBounds(),
            activeId: webviews.selectedId
          })
        } else {
          ipc.send('setView', {
            id: webviews.selectedId,
            bounds: webviews.getViewBounds(),
            focus: true
          })
        }
        webviews.emitEvent('view-shown', webviews.selectedId)
      }
    }
  },
  releaseFocus: function () {
    ipc.send('focusMainWebContents')
  },
  focus: function () {
    if (webviews.selectedId) {
      ipc.send('focusView', webviews.selectedId)
    }
  },
  resize: function () {
    if (webviews.splitProvider && webviews.splitProvider.isSplit()) {
      // resize both panes
      webviews.splitProvider.getPaneIds().forEach(function (id) {
        ipc.send('setBounds', { id: id, bounds: webviews.getViewBounds(id) })
      })
      // keep the divider in sync with the new layout
      if (webviews.splitProvider.onLayoutChange) {
        webviews.splitProvider.onLayoutChange()
      }
    } else {
      ipc.send('setBounds', { id: webviews.selectedId, bounds: webviews.getViewBounds() })
    }
  },
  goBackIgnoringRedirects: async function (id) {
    const navHistory = await webviews.getNavigationHistory(id)
    // If the current page is an internal page resulting from a redirect (error pages or reader mode), go back two pages

    var url = navHistory.entries[navHistory.activeIndex].url

    if (urlParser.isInternalURL(url) && navHistory.activeIndex > 1 && navHistory.entries[navHistory.activeIndex - 1].url === urlParser.getSourceURL(url)) {
      webviews.callAsync(id, 'canGoToOffset', -2, function (err, result) {
        if (!err && result === true) {
          webviews.callAsync(id, 'goToOffset', -2)
        } else {
          webviews.callAsync(id, 'goBack')
        }
      })
    } else {
      webviews.callAsync(id, 'goBack')
    }
  },
  /*
  Can be called as
  callAsync(id, method, args, callback) -> invokes method with args, runs callback with (err, result)
  callAsync(id, method, callback) -> invokes method with no args, runs callback with (err, result)
  callAsync(id, property, value, callback) -> sets property to value
  callAsync(id, property, callback) -> reads property, runs callback with (err, result)
   */
  callAsync: function (id, method, argsOrCallback, callback) {
    var args = argsOrCallback
    var cb = callback
    if (argsOrCallback instanceof Function && !cb) {
      args = []
      cb = argsOrCallback
    }
    if (!(args instanceof Array)) {
      args = [args]
    }
    if (cb) {
      var callId = Math.random()
      webviews.asyncCallbacks[callId] = cb
    }
    ipc.send('callViewMethod', { id: id, callId: callId, method: method, args: args })
  },
  getNavigationHistory: function (id) {
    return ipc.invoke('getNavigationHistory', id)
  }
}

window.addEventListener('resize', throttle(function () {
  if (webviews.placeholderRequests.length > 0) {
    // can't set view bounds if the view is hidden
    return
  }
  webviews.resize()
}, 75))

// leave HTML fullscreen when leaving window fullscreen
ipc.on('leave-full-screen', function () {
  // electron normally does this automatically (https://github.com/electron/electron/pull/13090/files), but it doesn't work for BrowserViews
  for (var view in webviews.viewFullscreenMap) {
    if (webviews.viewFullscreenMap[view]) {
      webviews.callAsync(view, 'executeJavaScript', 'document.exitFullscreen()')
    }
  }
})

webviews.bindEvent('enter-html-full-screen', function (tabId) {
  // HTML fullscreen needs the whole window, so exit split view
  if (webviews.splitProvider && webviews.splitProvider.isSplit()) {
    webviews.splitProvider.handleHtmlFullscreen()
  }
  webviews.viewFullscreenMap[tabId] = true
  webviews.resize()
})

webviews.bindEvent('leave-html-full-screen', function (tabId) {
  webviews.viewFullscreenMap[tabId] = false
  webviews.resize()
})

ipc.on('maximize', function () {
  windowIsMaximized = true
  webviews.resize()
})

ipc.on('unmaximize', function () {
  windowIsMaximized = false
  webviews.resize()
})

ipc.on('enter-full-screen', function () {
  windowIsFullscreen = true
  webviews.resize()
})

ipc.on('leave-full-screen', function () {
  windowIsFullscreen = false
  webviews.resize()
})

webviews.bindEvent('did-start-navigation', onNavigate)
webviews.bindEvent('will-redirect', onNavigate)
webviews.bindEvent('did-navigate', function (tabId, url, httpResponseCode, httpStatusText) {
  onPageURLChange(tabId, url)
})

webviews.bindEvent('did-finish-load', onPageLoad)

webviews.bindEvent('page-title-updated', function (tabId, title, explicitSet) {
  tabs.update(tabId, {
    title: title
  })
})

webviews.bindEvent('did-fail-load', function (tabId, errorCode, errorDesc, validatedURL, isMainFrame) {
  if (errorCode && errorCode !== -3 && isMainFrame && validatedURL) {
    webviews.update(tabId, webviews.internalPages.error + '?ec=' + encodeURIComponent(errorCode) + '&url=' + encodeURIComponent(validatedURL))
  }
})

webviews.bindEvent('crashed', function (tabId, isKilled) {
  var url = tabs.get(tabId).url

  tabs.update(tabId, {
    url: webviews.internalPages.error + '?ec=crash&url=' + encodeURIComponent(url)
  })

  // the existing process has crashed, so we can't reuse it
  webviews.destroy(tabId)
  webviews.add(tabId)

  if (tabId === tabs.getSelected()) {
    webviews.setSelected(tabId)
  }
})

webviews.bindIPC('getSettingsData', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  webviews.callAsync(tabId, 'send', ['receiveSettingsData', settings.list])
})
webviews.bindIPC('setSetting', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  settings.set(args[0].key, args[0].value)
})

settings.listen(function () {
  tasks.forEach(function (task) {
    task.tabs.forEach(function (tab) {
      if (tab.url.startsWith('min://')) {
        try {
          webviews.callAsync(tab.id, 'send', ['receiveSettingsData', settings.list])
        } catch (e) {
          // webview might not actually exist
        }
      }
    })
  })
})

webviews.bindIPC('scroll-position-change', function (tabId, args) {
  tabs.update(tabId, {
    scrollPosition: args[0]
  })
})

webviews.bindIPC('downloadFile', function (tabId, args) {
  if (tabs.get(tabId).url.startsWith('min://')) {
    webviews.callAsync(tabId, 'downloadURL', [args[0]])
  }
})

ipc.on('view-event', function (e, args) {
  webviews.emitEvent(args.event, args.tabId, args.args)
})

ipc.on('async-call-result', function (e, args) {
  webviews.asyncCallbacks[args.callId](args.error, args.result)
  delete webviews.asyncCallbacks[args.callId]
})

ipc.on('view-ipc', function (e, args) {
  if (!webviews.hasViewForTab(args.id)) {
    // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
    return
  }
  webviews.IPCEvents.forEach(function (item) {
    if (item.name === args.name) {
      item.fn(args.id, [args.data], args.frameId, args.frameURL)
    }
  })
})

/* focus the view when the window is focused */

ipc.on('windowFocus', function () {
  if (webviews.placeholderRequests.length === 0 && !webviews.isChromeFocused()) {
    webviews.focus()
  }
})

module.exports = webviews
