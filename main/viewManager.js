/* global minFigmaEngine */

var viewMap = {} // id: view
var viewStateMap = {} // id: view state

var temporaryPopupViews = {} // id: view

// rate limit on "open in app" requests
var globalLaunchRequests = 0
var figmaEngineAuthCallbacks = Object.create(null)

function isFigmaEngineAuthCallback (url) {
  var value = String(url || '')
  try {
    var parsed = new URL(value)
    var protocol = parsed.protocol.toLowerCase()
    var pathname = parsed.pathname.replace(/\/+/g, '/')
    var isFigmaProtocol = protocol === 'figma:' && (
      (parsed.hostname.toLowerCase() === 'app_auth' && pathname === '/redeem') ||
      pathname === '/app_auth/redeem'
    )
    var isFigmaWeb = /^(https?:)$/.test(protocol) &&
      /(^|\.)figma\.com$/i.test(parsed.hostname) &&
      pathname === '/app_auth/redeem'
    return (isFigmaProtocol || isFigmaWeb) && !!parsed.searchParams.get('g_secret')
  } catch (e) {
    // Keep handling malformed-but-common custom URLs such as
    // figma://app_auth/redeem?g_secret=... without sending them to xdg-open.
    return /^(?:figma:\/\/\/?app_auth\/redeem|https?:\/\/(?:[\w.-]+\.)?figma\.com\/app_auth\/redeem)\?[^#]*\bg_secret=/i.test(value)
  }
}

function consumeFigmaEngineAuthCallback (url) {
  if (!isFigmaEngineAuthCallback(url)) return false
  if (typeof minFigmaEngine === 'undefined' || !minFigmaEngine || !minFigmaEngine.redeemAuth) {
    return false
  }
  var status = minFigmaEngine.status && minFigmaEngine.status()
  if (!status || !status.running) return false

  var key = String(url || '')
  try {
    var parsed = new URL(key)
    key = parsed.searchParams.get('g_secret') || key
  } catch (e) {}
  if (figmaEngineAuthCallbacks[key]) return true
  figmaEngineAuthCallbacks[key] = true

  var redeem
  try {
    redeem = minFigmaEngine.redeemAuth(url)
  } catch (e) {
    delete figmaEngineAuthCallbacks[key]
    return false
  }
  if (redeem && typeof redeem.then === 'function') {
    redeem.then(function (result) {
      if (!result || result.ok !== true) delete figmaEngineAuthCallbacks[key]
    }).catch(function () {
      delete figmaEngineAuthCallbacks[key]
    })
  }
  setTimeout(function () {
    delete figmaEngineAuthCallbacks[key]
  }, 30000)
  return true
}

function getDefaultViewWebPreferences () {
  return (
    {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      scrollBounce: true,
      safeDialogs: true,
      safeDialogsMessage: 'Prevent this page from creating additional dialogs',
      preload: __dirname + '/dist/preload.js',
      contextIsolation: true,
      sandbox: true,
      enableRemoteModule: false,
      allowPopups: false,
      // partition: partition || 'persist:webcontent',
      enableWebSQL: false,
      autoplayPolicy: (settings.get('enableAutoplay') ? 'no-user-gesture-required' : 'user-gesture-required'),
      // match Chrome's default for anti-fingerprinting purposes (Electron defaults to 0)
      minimumFontSize: 6,
      javascript: !(settings.get('filtering')?.contentTypes?.includes('script'))
    }
  )
}

function createView (existingViewId, id, webPreferences, boundsString, events, resource, rootPath, extra) {
  if (viewStateMap[id]) {
    console.warn('Creating duplicate view')
  }

  const viewPrefs = Object.assign({}, getDefaultViewWebPreferences(), webPreferences)

  viewStateMap[id] = {
    loadedInitialURL: false,
    hasJS: viewPrefs.javascript, // need this later to see if we should swap the view for a JS-enabled one
    partition: viewPrefs.partition || null, // used to give popups the same session as their parent
    resource: resource || null, // what an internal surface is showing, see getViewResource
    rootPath: rootPath || null,
    extra: extra || null // per-surface extras (e.g. terminal scrollback for restore)
  }

  let view
  if (existingViewId) {
    view = temporaryPopupViews[existingViewId]
    delete temporaryPopupViews[existingViewId]

    // the initial URL has already been loaded, so set the background color
    view.setBackgroundColor('#fff')
    viewStateMap[id].loadedInitialURL = true
  } else {
    view = new WebContentsView({ webPreferences: viewPrefs })
  }

  events.forEach(function (event) {
    view.webContents.on(event, function (e) {
      var args = Array.prototype.slice.call(arguments).slice(1)

      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      if (!eventTarget) {
        // this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
        return
      }

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: event,
        args: args
      })
    })
  })

  view.webContents.on('will-navigate', function (event, url) {
    if (consumeFigmaEngineAuthCallback(url)) {
      event.preventDefault()
    }
  })

  view.webContents.on('select-bluetooth-device', function (event, deviceList, callback) {
    event.preventDefault()
    callback('')
  })

  view.webContents.setWindowOpenHandler(function (details) {
    if (details.url && consumeFigmaEngineAuthCallback(details.url)) {
      return {
        action: 'deny'
      }
    }

    if (details.url && !filterPopups(details.url)) {
      return {
        action: 'deny'
      }
    }

    /*
      Opening a popup with window.open() generally requires features to be set
      So if there are no features, the event is most likely from clicking on a link, which should open a new tab.
      Clicking a link can still have a "new-window" or "foreground-tab" disposition depending on which keys are pressed
      when it is clicked.
      (https://github.com/minbrowser/min/issues/1835)
    */
    if (details.url && details.url !== 'about:blank' && !details.features) {
      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: 'new-tab',
        args: [details.url, !(details.disposition === 'background-tab')]
      })
      return {
        action: 'deny'
      }
    }

    return {
      action: 'allow',
      createWindow: function (options) {
        // popups inherit the session partition of the view that opened them
        const popupPrefs = getDefaultViewWebPreferences()
        if (viewStateMap[id] && viewStateMap[id].partition) {
          popupPrefs.partition = viewStateMap[id].partition
        }
        const view = new WebContentsView({ webPreferences: popupPrefs, webContents: options.webContents })

        var popupId = Math.random().toString()
        temporaryPopupViews[popupId] = view

        const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

        getWindowWebContents(eventTarget).send('view-event', {
          tabId: id,
          event: 'did-create-popup',
          args: [popupId, details.url]
        })

        return view.webContents
      }
    }
  })

  view.webContents.on('ipc-message', function (e, channel, data) {
    var senderURL
    try {
      senderURL = e.senderFrame.url
    } catch (err) {
      // https://github.com/minbrowser/min/issues/2052
      console.warn('dropping message because senderFrame is destroyed', channel, data, err)
      return
    }

    const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

    if (!eventTarget) {
      // this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
      return
    }

    getWindowWebContents(eventTarget).send('view-ipc', {
      id: id,
      name: channel,
      data: data,
      frameId: e.frameId,
      frameURL: senderURL
    })
  })

  // Open a login prompt when site asks for http authentication
  view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') { // Only for basic auth
      return
    }
    event.preventDefault()
    var title = l('loginPromptTitle').replace('%h', authInfo.host)
    createPrompt({
      text: title,
      values: [{ placeholder: l('username'), id: 'username', type: 'text' },
        { placeholder: l('password'), id: 'password', type: 'password' }],
      ok: l('dialogConfirmButton'),
      cancel: l('dialogSkipButton'),
      width: 400,
      height: 200
    }, function (result) {
      // resend request with auth credentials
      callback(result.username, result.password)
    })
  })

  // show an "open in app" prompt for external protocols

  function handleExternalProtocol (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
    if (consumeFigmaEngineAuthCallback(url)) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault()
      return
    }

    var knownProtocols = ['http', 'https', 'file', 'min', 'about', 'data', 'javascript', 'chrome'] // TODO anything else?
    if (!knownProtocols.includes(url.split(':')[0])) {
      var externalApp = app.getApplicationNameForProtocol(url)
      if (externalApp) {
        var sanitizedName = externalApp.replace(/[^a-zA-Z0-9.]/g, '')
        if (globalLaunchRequests < 2) {
          globalLaunchRequests++
          setTimeout(function () {
            globalLaunchRequests--
          }, 20000)
          var result = electron.dialog.showMessageBoxSync({
            type: 'question',
            buttons: ['OK', 'Cancel'],
            message: l('openExternalApp').replace('%s', sanitizedName).replace(/\\/g, ''),
            detail: url.length > 160 ? url.substring(0, 160) + '...' : url
          })

          if (result === 0) {
            electron.shell.openExternal(url)
          }
        }
      }
    }
  }

  view.webContents.on('did-start-navigation', handleExternalProtocol)
  /*
  It's possible for an HTTP request to redirect to an external app link
  (primary use case for this is OAuth from desktop app > browser > back to app)
  and did-start-navigation isn't (always?) emitted for redirects, so we need this handler as well
  */
  view.webContents.on('will-redirect', handleExternalProtocol)

  /*
  the JS setting can only be set when the view is created, so swap the view on navigation if the setting value changed
  This can occur if the user manually changed the setting, or if we are navigating between an internal page (always gets JS)
  and an external one
  */
  view.webContents.on('did-start-navigation', function (event) {
    if (event.isMainFrame && !event.isSameDocument) {
      const hasJS = viewStateMap[id].hasJS
      const shouldHaveJS = (!(settings.get('filtering')?.contentTypes?.includes('script'))) || event.url.startsWith('min://')
      if (hasJS !== shouldHaveJS) {
        setTimeout(function () {
          view.webContents.stop()
          const currentWindow = getWindowFromViewContents(view.webContents)
          destroyView(id)
          const newView = createView(existingViewId, id, Object.assign({}, webPreferences, { javascript: shouldHaveJS }), boundsString, events)
          loadURLInView(id, event.url, currentWindow)

          if (currentWindow) {
            setView(id, getWindowWebContents(currentWindow))
            focusView(id)
          }
        }, 0)
      }
    }
  })

  view.setBounds(JSON.parse(boundsString))

  viewMap[id] = view

  return view
}

function destroyView (id) {
  if (!viewMap[id]) {
    return
  }

  windows.getAll().forEach(function (window) {
    const state = windows.getState(window)
    if (state.selectedView === id) {
      window.getContentView().removeChildView(viewMap[id])
      state.selectedView = null
    }
    if (state.splitPaneIds && state.splitPaneIds.includes(id)) {
      window.getContentView().removeChildView(viewMap[id])
      state.splitPaneIds = null
    }
  })
  viewMap[id].webContents.destroy()

  delete viewMap[id]
  delete viewStateMap[id]
}

function destroyAllViews () {
  for (const id in viewMap) {
    destroyView(id)
  }
}

function setView (id, senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const state = windows.getState(win)

  // changing views can cause flickering, so we only want to call it if the view is actually changing
  // see https://github.com/minbrowser/min/issues/1966
  if (state.selectedView !== viewMap[id]) {
    if (state.splitPaneIds) {
      // split view: keep both panes attached, just switch which one is active
      if (viewStateMap[id].loadedInitialURL && !win.getContentView().children.includes(viewMap[id])) {
        win.getContentView().addChildView(viewMap[id])
      }
      state.selectedView = id
    } else {
      // remove all prior views
      win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))
      if (viewStateMap[id].loadedInitialURL) {
        win.getContentView().addChildView(viewMap[id])
      } else {
        win.getContentView().removeChildView(viewMap[id])
      }
      state.selectedView = id
    }
  }
}

/* attaches two views side by side (split view) */

function setSplitView (ids, bounds, activeId, senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const state = windows.getState(win)

  // remove all prior views
  win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))

  ids.forEach(function (id, i) {
    if (viewMap[id] && viewStateMap[id].loadedInitialURL) {
      win.getContentView().addChildView(viewMap[id])
      viewMap[id].setBounds(bounds[i])
    }
  })

  state.splitPaneIds = ids
  state.selectedView = activeId
}

/* detaches the inactive pane and returns to a single full-window view */

function unsplitView (activeId, bounds, senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const state = windows.getState(win)

  if (state.splitPaneIds) {
    state.splitPaneIds.forEach(function (id) {
      if (id !== activeId && viewMap[id]) {
        win.getContentView().removeChildView(viewMap[id])
      }
    })
  }

  state.splitPaneIds = null
  state.selectedView = activeId
  if (viewMap[activeId]) {
    viewMap[activeId].setBounds(bounds)
  }
}

function setBounds (id, bounds) {
  if (viewMap[id]) {
    viewMap[id].setBounds(bounds)
  }
}

function focusView (id) {
  // empty views can't be focused because they won't propogate keyboard events correctly, see https://github.com/minbrowser/min/issues/616
  // also, make sure the view exists, since it might not if the app is shutting down
  if (viewMap[id] && (viewMap[id].webContents.getURL() !== '' || viewMap[id].webContents.isLoading())) {
    viewMap[id].webContents.focus()
    return true
  } else if (getWindowFromViewContents(viewMap[id]?.webContents)) {
    getWindowWebContents(getWindowFromViewContents(viewMap[id]?.webContents)).focus()
    return true
  }
}

function hideCurrentView (senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const state = windows.getState(win)
  const currentId = state.selectedView
  if (currentId) {
    // hide all attached views (including both panes in split view)
    win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))
    state.selectedView = null
    state.splitPaneIds = null
    if (win.isFocused()) {
      getWindowWebContents(win).focus()
    }
  }
}

function getView (id) {
  return viewMap[id]
}

function getTabIDFromWebContents (contents) {
  for (var id in viewMap) {
    if (viewMap[id].webContents === contents) {
      return id
    }
  }
}

/* the id of the view whose webContents is `contents`, or null */
function getViewIdForContents (contents) {
  return Object.keys(viewMap).find(id => viewMap[id].webContents === contents) || null
}

/* What a view is showing. The fork's internal surfaces (editor, terminal,
document) keep the file or folder they point at here instead of in the URL, so
neither the address bar nor the saved session carries workspace paths. */
function getViewResource (id) {
  const state = id ? viewStateMap[id] : null
  return {
    resource: (state && state.resource) || null,
    rootPath: (state && state.rootPath) || null,
    extra: (state && state.extra) || null
  }
}

function getWindowFromViewContents (webContents) {
  const viewId = getViewIdForContents(webContents)
  return windows.getAll().find(win => {
    const state = windows.getState(win)
    return state.selectedView === viewId || (state.splitPaneIds && state.splitPaneIds.includes(viewId))
  })
}

ipc.on('createView', function (e, args) {
  createView(args.existingViewId, args.id, args.webPreferences, args.boundsString, args.events, args.resource, args.rootPath, args.extra)
})

/* the preload reads this synchronously, before the page's own scripts run */
ipc.on('getViewResource', function (e) {
  e.returnValue = getViewResource(getViewIdForContents(e.sender))
})

/* internal surfaces can point their view at another file without rebuilding it */
ipc.on('setViewResource', function (e, args) {
  const state = args && args.id ? viewStateMap[args.id] : null
  if (state) {
    state.resource = args.resource || null
    state.rootPath = args.rootPath || null
  }
})

ipc.on('destroyView', function (e, id) {
  destroyView(id)
})

ipc.on('destroyAllViews', function () {
  destroyAllViews()
})

ipc.on('setView', function (e, args) {
  setView(args.id, e.sender)
  setBounds(args.id, args.bounds)
  if (args.focus && BrowserWindow.fromWebContents(e.sender) && BrowserWindow.fromWebContents(e.sender).isFocused()) {
    const couldFocus = focusView(args.id)
    if (!couldFocus) {
      e.sender.focus()
    }
  }
})

ipc.on('setSplitView', function (e, args) {
  setSplitView(args.ids, args.bounds, args.activeId, e.sender)
  if (args.activeId) {
    focusView(args.activeId)
  }
})

ipc.on('unsplitView', function (e, args) {
  unsplitView(args.activeId, args.bounds, e.sender)
  if (args.activeId) {
    focusView(args.activeId)
  }
})

ipc.on('setBounds', function (e, args) {
  setBounds(args.id, args.bounds)
})

ipc.on('focusView', function (e, id) {
  focusView(id)
})

/* relays mouse events from page views to their owning window's renderer,
used by the split view divider and the sidebar resizer to track drags over
the panes. */
ipc.on('view-mouse-event', function (e, args) {
  const eventWindow = getWindowFromViewContents(e.sender)
  if (eventWindow) {
    const viewId = Object.keys(viewMap).find(id => viewMap[id].webContents === e.sender)
    /* The page-relative coordinates in args shift while a drag resizes the
    views, so a listener that converts them back to window coordinates
    double-counts the movement. Report the cursor position inside the window
    instead; it is independent of the views' current bounds. */
    let windowX = null
    let windowY = null
    try {
      // required lazily: main modules share one concatenated scope, so this
      // must not depend on main.js having run its own require first
      const point = require('electron').screen.getCursorScreenPoint()
      const bounds = eventWindow.getContentBounds()
      windowX = point.x - bounds.x
      windowY = point.y - bounds.y
    } catch (err) {}
    getWindowWebContents(eventWindow).send('view-mouse-event', Object.assign({}, args, { viewId, windowX, windowY }))
  }
})

ipc.on('hideCurrentView', function (e) {
  hideCurrentView(e.sender)
})

function loadURLInView (id, url, win) {
  // wait until the first URL is loaded to set the background color so that new tabs can use a custom background
  if (!viewStateMap[id].loadedInitialURL) {
    // Give the site a chance to display something before setting the background, in case it has its own dark theme
    viewMap[id].webContents.once('dom-ready', function () {
      viewMap[id].setBackgroundColor('#fff')
    })
    // If the view has no URL, it won't be attached yet
    if (win && (id === windows.getState(win).selectedView || (windows.getState(win).splitPaneIds && windows.getState(win).splitPaneIds.includes(id)))) {
      win.getContentView().addChildView(viewMap[id])
    }
  }
  viewMap[id].webContents.loadURL(url)
  viewStateMap[id].loadedInitialURL = true
}

ipc.on('loadURLInView', function (e, args) {
  const win = windows.windowFromContents(e.sender)?.win
  loadURLInView(args.id, args.url, win)
})

ipc.on('callViewMethod', function (e, data) {
  var error, result
  try {
    var webContents = viewMap[data.id].webContents
    var methodOrProp = webContents[data.method]
    if (methodOrProp instanceof Function) {
      // call function
      result = methodOrProp.apply(webContents, data.args)
    } else {
      // set property
      if (data.args && data.args.length > 0) {
        webContents[data.method] = data.args[0]
      }
      // read property
      result = methodOrProp
    }
  } catch (e) {
    error = e
  }
  if (result instanceof Promise) {
    result.then(function (result) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error: null, result })
      }
    })
    result.catch(function (error) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error, result: null })
      }
    })
  } else if (data.callId) {
    e.sender.send('async-call-result', { callId: data.callId, error, result })
  }
})

ipc.handle('getNavigationHistory', function (e, id) {
  if (!viewMap[id]?.webContents) {
    return null
  }
  const entries = []
  const activeIndex = viewMap[id].webContents.navigationHistory.getActiveIndex()
  const size = viewMap[id].webContents.navigationHistory.length()

  for (let i = 0; i < size; i++) {
    entries.push(viewMap[id].webContents.navigationHistory.getEntryAtIndex(i))
  }

  return {
    activeIndex,
    entries
  }
})

ipc.on('saveViewCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
  }

  view.webContents.capturePage().then(function (image) {
    view.webContents.downloadURL(image.toDataURL())
  })
})

global.getView = getView
