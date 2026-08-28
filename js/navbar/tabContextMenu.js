const remoteMenu = require('remoteMenuRenderer.js')
const browserUI = require('browserUI.js')
const webviews = require('webviews.js')
const readerView = require('readerView.js')
const urlParser = require('util/urlParser.js')
const splitView = require('splitView.js')
const tabBar = require('navbar/tabBar.js')

function closeTab (tabId) {
  if (tabs.get(tabId).url.startsWith(webviews.internalPages.error)) {
    // reload the original page rather than show the error page again
    webviews.update(tabId, new URL(tabs.get(tabId).url).searchParams.get('url'))
  } else {
    // this can't be an error page, use the normal reload method
    webviews.callAsync(tabId, 'reload')
  }
}

function getTabMenu (tabId) {
  // when tabs are multi-selected, show only bulk actions - individual
  // actions are confusing when they would apply to a single tab
  if (tabs.getMultiSelectedCount() > 1) {
    return [
      [
        {
          label: l('tabMenuCloseSelectedTabs'),
          click: function () {
            const multiSelected = tabs.getMultiSelected()
            multiSelected.forEach(function (id) {
              tabBar.events.emit('tab-closed', id)
            })
          }
        }
      ]
    ]
  }

  const tabMenu = [
    [
      {
        label: l('appMenuDuplicateTab'),
        click: function () {
          const sourceTab = tabs.get(tabId)
          // strip tab id so that a new one is generated
          const newTab = tabs.add({ ...sourceTab, id: undefined })

          browserUI.addTab(newTab, { enterEditMode: false })
        }
      },
      {
        label: l('tabMenuNewWindow'),
        click: function () {
          // insert after current task
          let index
          if (tasks.getSelected()) {
            index = tasks.getIndex(tasks.getSelected().id) + 1
          }
          const newTask = tasks.get(tasks.add({}, index))

          const targetTab = tabs.get(tabId)
          tabs.destroy(targetTab.id)

          newTask.tabs.add(targetTab)

          ipc.send('newWindow', { initialTask: newTask.id })

          browserUI.switchToTask(tasks.getSelected().id)
        }
      }
    ]
  ]

  if (tabs.get(tabId).url && (readerView.isReader(tabId) || !urlParser.isInternalURL(tabs.get(tabId).url))) {
    if (!readerView.isReader(tabId)) {
      tabMenu[0].push({
        label: l('enterReaderView'),
        click: function () {
          readerView.enter(tabId, tabs.get(tabId).url)
        }
      })
    } else {
      tabMenu[0].push({
        label: l('exitReaderView'),
        click: function () {
          readerView.exit(tabId)
        }
      })
    }
  }

  tabMenu[0].push({
    label: l('tabMenuReload'),
    click: function () {
      closeTab(tabId)
    }
  })

  // split view actions
  if (splitView.isSplit()) {
    tabMenu[0].push({
      label: l('tabMenuExitSplitView'),
      click: function () {
        splitView.destroy()
      }
    })
  } else {
    // start the split-pair selection flow: the next tab clicked becomes the pair
    tabMenu[0].push({
      label: l('tabMenuSplitView'),
      click: function () {
        splitView.startSelection(tabId)
      }
    })
  }

  return tabMenu
}

const tabContextMenu = {
  show: function (tabId) {
    remoteMenu.open(getTabMenu(tabId))
  },
  initialize: function () {
    const container = document.getElementById('tabs-inner')
    container.addEventListener('contextmenu', function (e) {
      let node = e.target

      while (node) {
        if (node.classList.contains('tab-item')) {
          tabContextMenu.show(node.getAttribute('data-tab'))
          e.stopPropagation()
          break
        }
        node = node.parentNode
      }
    })
  }
}

module.exports = tabContextMenu
