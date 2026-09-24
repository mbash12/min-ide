module.exports = function ({ webviews, urlParser, settings }) {
  // called whenever a new page starts loading, or an in-page navigation occurs
  function onPageURLChange (tab, url) {
    if (url.indexOf('https://') === 0 || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('file://') === 0 || url.indexOf('min://') === 0) {
      webviews.updateTabState(tab, {
        secure: true,
        url: url
      })
    } else {
      webviews.updateTabState(tab, {
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

  webviews.bindEvent('did-start-navigation', onNavigate)
  webviews.bindEvent('will-redirect', onNavigate)
  webviews.bindEvent('did-navigate', function (tabId, url, httpResponseCode, httpStatusText) {
    onPageURLChange(tabId, url)
  })

  webviews.bindEvent('did-finish-load', onPageLoad)

  webviews.bindEvent('page-title-updated', function (tabId, title, explicitSet) {
    webviews.updateTabState(tabId, {
      title: title
    })
  })

  /* safety net: page-title-updated is a pushed event and can be missed (e.g.
  when a view is recreated mid-navigation or the renderer is busy), so pull the
  final title once loading settles */
  webviews.bindEvent('did-stop-loading', function (tabId) {
    webviews.callAsync(tabId, 'getTitle', function (err, title) {
      const tab = webviews.getTabData(tabId)
      if (!err && title && tab && tab.title !== title) {
        webviews.updateTabState(tabId, { title: title })
      }
    })
  })

  webviews.bindEvent('did-fail-load', function (tabId, errorCode, errorDesc, validatedURL, isMainFrame) {
    if (errorCode && errorCode !== -3 && isMainFrame && validatedURL) {
      webviews.update(tabId, webviews.internalPages.error + '?ec=' + encodeURIComponent(errorCode) + '&url=' + encodeURIComponent(validatedURL))
    }
  })

  webviews.bindEvent('crashed', function (tabId, isKilled) {
    const tab = webviews.getTabData(tabId)
    if (!tab) return
    var url = tab.url

    webviews.updateTabState(tabId, {
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
    if (!urlParser.isInternalURL(webviews.getTabData(tabId).url)) {
      throw new Error()
    }
    webviews.callAsync(tabId, 'send', ['receiveSettingsData', settings.list])
  })
  webviews.bindIPC('setSetting', function (tabId, args) {
    if (!urlParser.isInternalURL(webviews.getTabData(tabId).url)) {
      throw new Error()
    }
    settings.set(args[0].key, args[0].value)
  })

  settings.listen(function () {
    workspaces.forEach(function (workspace) {
      workspace.tasks.forEach(function (task) {
        task.tabs.forEach(function (tab) {
          if (tab.url.startsWith('min://') && tab.hasWebContents) {
            try {
              webviews.callAsync(tab.id, 'send', ['receiveSettingsData', settings.list])
            } catch (e) {
            // webview might not actually exist
            }
          }
        })
      })
    })
  })

  webviews.bindIPC('scroll-position-change', function (tabId, args) {
    webviews.updateTabState(tabId, {
      scrollPosition: args[0]
    })
  })

  webviews.bindIPC('downloadFile', function (tabId, args) {
    if (webviews.getTabData(tabId).url.startsWith('min://')) {
      webviews.callAsync(tabId, 'downloadURL', [args[0]])
    }
  })
}
