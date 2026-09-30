const webviews = require('webviews.js')

var navigationButtons = {
  tabsList: document.getElementById('tabs-inner'),
  container: document.getElementById('toolbar-navigation-buttons'),
  backButton: document.getElementById('back-button'),
  forwardButton: document.getElementById('forward-button'),
  update: function (eventTabId) {
    const tabId = window.tabs && tabs.getSelected()
    if (eventTabId && eventTabId !== tabId) return
    const tab = tabId && tabs.get(tabId)
    if (!tab || !tab.url) {
      navigationButtons.backButton.disabled = true
      navigationButtons.forwardButton.disabled = true
      return
    }
    webviews.callAsync(tabId, 'canGoBack', function (err, canGoBack) {
      if (err || !window.tabs || tabs.getSelected() !== tabId) {
        return
      }
      navigationButtons.backButton.disabled = !canGoBack
    })
    webviews.callAsync(tabId, 'canGoForward', function (err, canGoForward) {
      if (err || !window.tabs || tabs.getSelected() !== tabId) {
        return
      }
      navigationButtons.forwardButton.disabled = !canGoForward
      if (canGoForward) {
        navigationButtons.container.classList.add('can-go-forward')
      } else {
        navigationButtons.container.classList.remove('can-go-forward')
      }
    })
  },
  initialize: function () {
    navigationButtons.container.hidden = false

    navigationButtons.backButton.addEventListener('click', function (e) {
      webviews.goBackIgnoringRedirects(tabs.getSelected())
    })

    navigationButtons.forwardButton.addEventListener('click', function () {
      webviews.callAsync(tabs.getSelected(), 'goForward')
    })

    navigationButtons.container.addEventListener('mouseenter', function () {
      /*
      Prevent scrollbars from showing up when hovering the navigation buttons, if one isn't already shown
      This also works around a chromium bug where a flickering scrollbar is shown during the expanding animation:
      https://github.com/minbrowser/min/pull/1665#issuecomment-868551126
      */
      if (navigationButtons.tabsList.scrollWidth <= navigationButtons.tabsList.clientWidth) {
        navigationButtons.tabsList.classList.add('disable-scroll')
      }
    })

    navigationButtons.container.addEventListener('mouseleave', function () {
      navigationButtons.tabsList.classList.remove('disable-scroll')
    })

    tasks.on('tab-selected', navigationButtons.update)
    webviews.bindEvent('did-navigate', this.update)
    webviews.bindEvent('did-navigate-in-page', this.update)
  }
}

module.exports = navigationButtons
