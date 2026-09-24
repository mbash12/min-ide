/* fades out tabs that are inactive */

var tabBar = require('navbar/tabBar.js')

var tabActivity = {
  minFadeAge: 330000,
  refresh: function () {
    if (!window.tabs) {
      return
    }
    requestAnimationFrame(function () {
      if (!window.tabs) return
      var tabSet = tabs.get()
      var selected = tabs.getSelected()
      var time = Date.now()

      tabSet.forEach(function (tab) {
        var el = tabBar.getTab(tab.id)
        // the tab can be in another task, whose elements are not in the DOM
        if (!el) return
        if (selected === tab.id) { // never fade the current tab
          el.classList.remove('fade')
          return
        }
        if (time - tab.lastActivity > tabActivity.minFadeAge) { // the tab has been inactive for greater than minActivity, and it is not currently selected
          el.classList.add('fade')
        } else {
          el.classList.remove('fade')
        }
      })
    })
  },
  initialize: function () {
    setInterval(tabActivity.refresh, 7500)

    tasks.on('tab-selected', tabActivity.refresh)
  }
}

module.exports = tabActivity
