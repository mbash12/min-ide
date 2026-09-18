const EventEmitter = require('events')

const webviews = require('webviews.js')
const readerView = require('readerView.js')
const tabAudio = require('tabAudio.js')
const dragula = require('dragula')
const settings = require('util/settings/settings.js')
const urlParser = require('util/urlParser.js')

const tabEditor = require('navbar/tabEditor.js')
const progressBar = require('navbar/progressBar.js')
const permissionRequests = require('navbar/permissionRequests.js')
const splitView = require('splitView.js')
const editorView = require('editorView.js')

/* lead icons for the fork's internal surfaces (they never emit a favicon event) */
const internalKindIcons = {
  editor: 'carbon:code',
  terminal: 'carbon:terminal',
  document: 'carbon:document'
}

/* built-in min:// pages that carry no kind still get an icon from their name */
const internalPageIcons = {
  settings: 'carbon:settings',
  proSettings: 'carbon:machine-learning-model'
}

function getInternalPageIcon (tabData) {
  const kindIcon = internalKindIcons[tabData.kind]
  if (kindIcon) {
    return kindIcon
  }
  // normalize both short ('min://settings') and stored full forms
  const parsed = urlParser.parse(tabData.url || '')
  const prefix = 'min://app/pages/'
  if (!parsed.startsWith(prefix)) {
    return null
  }
  // e.g. 'settings/index.html' -> 'settings'
  const page = parsed.slice(prefix.length).split('?')[0].split('#')[0].split('/')[0]
  return internalPageIcons[page] || null
}

const tabBar = {
  navBar: document.getElementById('navbar'),
  container: document.getElementById('tabs'),
  containerInner: document.getElementById('tabs-inner'),
  tabElementMap: {}, // tabId: tab element
  events: new EventEmitter(),
  dragulaInstance: null,
  getTab: function (tabId) {
    return tabBar.tabElementMap[tabId]
  },
  getTabInput: function (tabId) {
    return tabBar.getTab(tabId).querySelector('.tab-input')
  },
  setActiveTab: function (tabId) {
    var activeTab = document.querySelector('.tab-item.active')

    if (activeTab) {
      activeTab.classList.remove('active')
      activeTab.removeAttribute('aria-selected')
    }

    var el = tabBar.getTab(tabId)
    if (!el) {
      // the tab can be in another task, whose elements are not in the DOM
      return
    }
    el.classList.add('active')
    el.setAttribute('aria-selected', 'true')

    requestAnimationFrame(function () {
      el.scrollIntoView()
    })
  },
  updateMultiSelected: function () {
    const multiSelected = tabs.getMultiSelected()
    tabs.get().forEach(function (tab) {
      const el = tabBar.getTab(tab.id)
      if (el) {
        if (multiSelected.includes(tab.id) && tab.id !== tabs.getSelected()) {
          el.classList.add('multi-selected')
          el.setAttribute('aria-selected', 'true')
        } else {
          el.classList.remove('multi-selected')
          if (tab.id !== tabs.getSelected()) {
            el.removeAttribute('aria-selected')
          }
        }
      }
    })
  },
  createTab: function (data) {
    var tabEl = document.createElement('div')
    tabEl.className = 'tab-item'
    tabEl.setAttribute('data-tab', data.id)
    tabEl.setAttribute('role', 'tab')

    tabEl.appendChild(readerView.getButton(data.id))
    tabEl.appendChild(progressBar.create())

    // icons

    var iconArea = document.createElement('span')
    iconArea.className = 'tab-icon-area'

    if (data.private) {
      var pbIcon = document.createElement('i')
      pbIcon.className = 'icon-tab-is-private tab-icon tab-info-icon i carbon:view-off'
      iconArea.appendChild(pbIcon)
    }

    var closeTabButton = document.createElement('button')
    closeTabButton.className = 'tab-icon tab-close-button i carbon:close'

    closeTabButton.addEventListener('click', function (e) {
      tabBar.events.emit('tab-closed', data.id)
      // prevent the searchbar from being opened
      e.stopPropagation()
    })

    iconArea.appendChild(closeTabButton)

    tabEl.appendChild(iconArea)

    // lead icon: favicon / globe fallback / audio indicator share one slot

    var faviconBox = document.createElement('span')
    faviconBox.className = 'tab-favicon-box'

    var faviconImg = document.createElement('img')
    faviconImg.className = 'tab-favicon-img'
    faviconImg.setAttribute('aria-hidden', 'true')
    faviconImg.hidden = true

    var faviconFallback = document.createElement('i')
    faviconFallback.className = 'tab-favicon-fallback i carbon:globe'
    faviconFallback.title = ''

    faviconBox.appendChild(faviconImg)
    faviconBox.appendChild(faviconFallback)
    faviconBox.appendChild(tabAudio.getButton(data.id))

    faviconBox.addEventListener('click', function (e) {
      e.stopPropagation()
    })

    tabEl.appendChild(faviconBox)

    // title

    var titleContainer = document.createElement('div')
    titleContainer.className = 'title-container'

    var title = document.createElement('span')
    title.className = 'title'

    // URL

    var urlElement = document.createElement('span')
    urlElement.className = 'url-element'

    titleContainer.appendChild(title)
    titleContainer.appendChild(urlElement)

    tabEl.appendChild(titleContainer)

    // click to enter edit mode or switch to a tab
    tabEl.addEventListener('click', function (e) {
      // split-pair selection mode: the next tab clicked becomes the split pair
      if (splitView.isSelecting()) {
        splitView.completeSelection(data.id)
        return
      }

      if (e.shiftKey) {
        // shift-click: select a range of tabs for multi-select
        const activeId = tabs.getSelected()
        if (activeId && activeId !== data.id) {
          tabs.setMultiSelectedRange(activeId, data.id)
          tabBar.updateMultiSelected()
        } else if (activeId === data.id) {
          // shift-clicking the active tab clears the selection
          tabs.clearMultiSelected()
          tabBar.updateMultiSelected()
        }
        return
      }

      // a plain click clears any multi-selection
      if (tabs.getMultiSelectedCount() > 0) {
        tabs.clearMultiSelected()
        tabBar.updateMultiSelected()
      }

      if (tabs.getSelected() !== data.id) { // else switch to tab if it isn't focused
        tabBar.events.emit('tab-selected', data.id)
      } else { // the tab is focused, edit tab instead
        tabEditor.show(data.id)
      }
    })

    tabEl.addEventListener('auxclick', function (e) {
      if (e.which === 2) { // if mouse middle click -> close tab
        const multiSelected = tabs.getMultiSelected()
        if (multiSelected.length > 1 && multiSelected.includes(data.id)) {
          // middle-clicking a multi-selected tab closes all selected tabs
          multiSelected.forEach(id => tabBar.events.emit('tab-closed', id))
        } else {
          tabBar.events.emit('tab-closed', data.id)
        }
      }
    })

    // double-clicking a preview tab pins it (like in VSCode)
    tabEl.addEventListener('dblclick', function (e) {
      if (!editorView.isEditorTab(data.id)) {
        return
      }
      editorView.pinTab(data.id)
      e.preventDefault()
    })

    tabBar.updateTab(data.id, tabEl)

    return tabEl
  },
  updateTab: function (tabId, tabEl = tabBar.getTab(tabId)) {
    var tabData = tabs.get(tabId)

    // update tab title
    var tabTitle

    const isNewTab = tabData.url === '' || tabData.url === urlParser.parse('min://newtab')
    if (isNewTab) {
      tabTitle = l('newTabLabel')
    } else if (tabData.title) {
      tabTitle = tabData.title
    } else if (tabData.loaded) {
      tabTitle = tabData.url
    }

    tabTitle = (tabTitle || l('newTabLabel')).substring(0, 500)

    var titleEl = tabEl.querySelector('.title')
    titleEl.textContent = tabTitle

    tabEl.title = tabTitle
    if (tabData.private) {
      tabEl.title += ' (' + l('privateTab') + ')'
    }
    // the title changed, so any cached split indicator base is stale
    tabEl.removeAttribute('data-base-title')

    // preview tabs (temporary editor tabs) are shown in italic
    tabEl.classList.toggle('preview', !!tabData.preview)

    var tabUrl = urlParser.getDomain(tabData.url)
    if (tabUrl.startsWith('www.') && tabUrl.split('.').length > 2) {
      tabUrl = tabUrl.replace('www.', '')
    }

    tabEl.querySelector('.url-element').textContent = tabUrl

    if (tabUrl && !urlParser.isInternalURL(tabData.url)) {
      tabEl.classList.add('has-url')
    } else {
      tabEl.classList.remove('has-url')
    }

    // update lead icon (audio indicator replaces the favicon while active)

    var faviconBox = tabEl.querySelector('.tab-favicon-box')
    var faviconImg = faviconBox.querySelector('.tab-favicon-img')
    var faviconFallback = faviconBox.querySelector('.tab-favicon-fallback')
    var audioButton = faviconBox.querySelector('.tab-audio-button')

    tabAudio.updateButton(tabId, audioButton)
    var audioActive = !audioButton.hidden

    if (!audioActive && !tabData.private && tabData.favicon && tabData.favicon.url) {
      if (faviconImg.getAttribute('src') !== tabData.favicon.url) {
        faviconImg.src = tabData.favicon.url
      }
      faviconImg.classList.toggle('is-dark', !!(tabData.favicon.luminance && tabData.favicon.luminance < 70))
      faviconImg.hidden = false
      faviconFallback.hidden = true
    } else if (!audioActive) {
      faviconImg.hidden = true
      faviconImg.removeAttribute('src')
      const internalIcon = getInternalPageIcon(tabData)
      faviconFallback.className = 'tab-favicon-fallback i ' + (internalIcon || 'carbon:globe')
      faviconFallback.hidden = false
    } else {
      // the audio button takes over the slot entirely
      faviconImg.hidden = true
      faviconImg.removeAttribute('src')
      faviconFallback.hidden = true
    }

    tabEl.querySelectorAll('.permission-request-icon').forEach(el => el.remove())

    permissionRequests.getButtons(tabId).reverse().forEach(function (button) {
      tabEl.insertBefore(button, tabEl.children[0])
    })

    var iconArea = tabEl.getElementsByClassName('tab-icon-area')[0]

    var insecureIcon = tabEl.getElementsByClassName('icon-tab-not-secure')[0]
    if (tabData.secure === true && insecureIcon) {
      insecureIcon.remove()
    } else if (tabData.secure === false && !insecureIcon) {
      var insecureIcon = document.createElement('i')
      insecureIcon.className = 'icon-tab-not-secure tab-icon tab-info-icon i carbon:unlocked'
      insecureIcon.title = l('connectionNotSecure')
      iconArea.appendChild(insecureIcon)
    }
  },
  updateAll: function () {
    empty(tabBar.containerInner)
    tabBar.tabElementMap = {}

    tabs.get().forEach(function (tab) {
      var el = tabBar.createTab(tab)
      tabBar.containerInner.appendChild(el)
      tabBar.tabElementMap[tab.id] = el
    })

    if (tabs.getSelected()) {
      tabBar.setActiveTab(tabs.getSelected())
    }
    tabBar.updateMultiSelected()
    updateSplitGroupIndicators()
    tabBar.handleSizeChange()
  },
  addTab: function (tabId) {
    var tab = tabs.get(tabId)
    var index = tabs.getIndex(tabId)

    var tabEl = tabBar.createTab(tab)
    tabBar.containerInner.insertBefore(tabEl, tabBar.containerInner.childNodes[index])
    tabBar.tabElementMap[tabId] = tabEl
    tabBar.handleSizeChange()
  },
  removeTab: function (tabId) {
    var tabEl = tabBar.getTab(tabId)
    if (tabEl) {
      // The tab does not have a corresponding .tab-item element.
      // This happens when destroying tabs from other task where this .tab-item is not present
      tabBar.containerInner.removeChild(tabEl)
      delete tabBar.tabElementMap[tabId]
      tabBar.handleSizeChange()
    }
  },
  handleDividerPreference: function (dividerPreference) {
    if (dividerPreference === true) {
      tabBar.navBar.classList.add('show-dividers')
    } else {
      tabBar.navBar.classList.remove('show-dividers')
    }
  },
  initializeTabDragging: function () {
    tabBar.dragulaInstance = dragula([document.getElementById('tabs-inner')], {
      direction: 'horizontal',
      slideFactorX: 25
    })

    tabBar.dragulaInstance.on('drop', function (el, target, source, sibling) {
      var tabId = el.getAttribute('data-tab')
      if (sibling) {
        var adjacentTabId = sibling.getAttribute('data-tab')
      }

      var oldTab = tabs.splice(tabs.getIndex(tabId), 1)[0]

      var newIdx
      if (adjacentTabId) {
        newIdx = tabs.getIndex(adjacentTabId)
      } else {
        // tab was inserted at end
        newIdx = tabs.count()
      }

      tabs.splice(newIdx, 0, oldTab)
      tabBar.updateMultiSelected()
      require('splitView.js').handleTabReorder()
    })
  },
  handleSizeChange: function () {
    if (window.innerWidth / tabBar.containerInner.childNodes.length < 190) {
      tabBar.container.classList.add('compact-tabs')
    } else {
      tabBar.container.classList.remove('compact-tabs')
    }
  }
}

window.addEventListener('resize', tabBar.handleSizeChange)

settings.listen('showDividerBetweenTabs', function (dividerPreference) {
  tabBar.handleDividerPreference(dividerPreference)
})

/* tab loading and progress bar status */
webviews.bindEvent('did-start-loading', function (tabId) {
  progressBar.update(tabBar.getTab(tabId).querySelector('.progress-bar'), 'start')
  tabs.update(tabId, { loaded: false })
})

webviews.bindEvent('did-stop-loading', function (tabId) {
  progressBar.update(tabBar.getTab(tabId).querySelector('.progress-bar'), 'finish')
  tabs.update(tabId, { loaded: true })
  tabBar.updateTab(tabId)
})

require('util/followTaskList.js').followTaskList(function (taskList) {
  taskList.on('tab-updated', function (id, key) {
    var updateKeys = ['title', 'secure', 'url', 'muted', 'hasAudio', 'preview', 'favicon']
    if (updateKeys.includes(key)) {
      tabBar.updateTab(id)
      updateSplitGroupIndicators()
    }
  })
})

permissionRequests.onChange(function (tabId) {
  if (tabs.get(tabId)) {
    tabBar.updateTab(tabId)
  }
})

/* split-pair selection mode UI */
splitView.onSelectionChange = function (isSelecting, anchorTabId) {
  tabBar.container.classList.toggle('is-selecting-split', isSelecting)
  tabBar.containerInner.classList.toggle('is-selecting-split', isSelecting)

  const anchorEl = tabBar.getTab(anchorTabId)
  if (isSelecting) {
    // highlight the anchor tab
    if (anchorEl) {
      anchorEl.classList.add('split-anchor')
    }
    tabBar.containerInner.title = l('splitViewSelectTab')
  } else {
    if (anchorEl) {
      anchorEl.classList.remove('split-anchor')
    }
    tabBar.containerInner.title = ''
  }
}

/* group indicators: mark tabs that are part of a split group with a colored
bottom border that connects the two group members. Each group gets its own
color so adjacent groups are distinguishable. */
function updateSplitGroupIndicators () {
  const groupColors = ['split-group-0', 'split-group-1', 'split-group-2', 'split-group-3']

  // window.tabs is undefined until the first task is selected (startup);
  // clearAll -> notifyGroupsChanged can fire before that.
  if (!window.tabs) {
    return
  }
  tabs.get().forEach(function (tab) {
    const el = tabBar.getTab(tab.id)
    if (!el) {
      return
    }
    // clear previous group classes
    groupColors.forEach(function (c) {
      el.classList.remove(c)
    })

    const groupIndex = splitView.groups.findIndex(function (group) {
      return group.paneTabIds.includes(tab.id)
    })

    if (groupIndex >= 0) {
      const group = splitView.groups[groupIndex]
      el.classList.add(groupColors[groupIndex % groupColors.length])
      // list every other pane of the group in the tooltip
      const partners = group.paneTabIds
        .filter(tabId => tabId !== tab.id)
        .map(function (tabId) {
          const partner = tabs.get(tabId)
          return (partner && partner.title) ? partner.title : l('newTabLabel')
        })
      const baseTitle = el.getAttribute('data-base-title') || el.title
      el.setAttribute('data-base-title', baseTitle)
      el.title = baseTitle + ' · ' + l('splitWithTab').replace('%t', partners.join(', '))
    } else {
      const baseTitle = el.getAttribute('data-base-title')
      if (baseTitle) {
        el.title = baseTitle
        el.removeAttribute('data-base-title')
      }
    }
  })
}
splitView.onGroupsChange = updateSplitGroupIndicators

// cancel the selection mode with the escape key
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && splitView.isSelecting()) {
    splitView.cancelSelection()
  }
})

tabBar.initializeTabDragging()

tabBar.container.addEventListener('dragover', e => e.preventDefault())

tabBar.container.addEventListener('drop', e => {
  e.preventDefault()
  var data = e.dataTransfer
  var path = data.files[0] ? 'file://' + electron.webUtils.getPathForFile(data.files[0]) : data.getData('text')
  if (!path) {
    return
  }
  if (tabEditor.isShown || tabs.isEmpty()) {
    webviews.update(tabs.getSelected(), path)
    tabEditor.hide()
  } else {
    require('browserUI.js').addTab(tabs.add({
      url: path,
      private: tabs.get(tabs.getSelected()).private
    }), { enterEditMode: false, openInBackground: !settings.get('openTabsInForeground') })
  }
})

module.exports = tabBar
