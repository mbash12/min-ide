class TabList {
  constructor (tabs, parentTaskList) {
    this.tabs = tabs || []
    this.parentTaskList = parentTaskList
  }

  //tab properties that shouldn't be saved to disk

  static temporaryProperties = ['hasAudio', 'previewImage', 'loaded', 'hasWebContents', 'multiSelected', 'preview']

  add (tab = {}, options = {}, emit=true) {
    var tabId = String(tab.id || Math.round(Math.random() * 100000000000000000)) // you can pass an id that will be used, or a random one will be generated.

    var newTab = {
      url: tab.url || '',
      title: tab.title || '',
      id: tabId,
      lastActivity: tab.lastActivity || Date.now(),
      secure: tab.secure,
      private: tab.private || false,
      readerable: tab.readerable || false,
      themeColor: tab.themeColor,
      backgroundColor: tab.backgroundColor,
      scrollPosition: tab.scrollPosition || 0,
      selected: tab.selected || false,
      multiSelected: tab.multiSelected || false,
      muted: tab.muted || false,
      loaded: tab.loaded || false,
      hasAudio: false,
      previewImage: '',
      isFileView: false,
      hasWebContents: false,
      // FORK: what this tab shows ('web', 'editor', 'terminal', 'document',
      // 'note'). Internal surfaces record the thing they point at in
      // `resource` (a file path, a shell's cwd, a document or note id) so the
      // URL does not have to carry it - see HANDOVER §13.
      kind: tab.kind || 'web',
      resource: tab.resource || null,
    }

    if (options.atEnd) {
      this.tabs.push(newTab)
    } else {
      this.tabs.splice(this.getSelectedIndex() + 1, 0, newTab)
    }

    if (emit) {
    this.parentTaskList.emit('tab-added', tabId, newTab, options, this.parentTaskList.getTaskContainingTab(tabId).id)
    }

    return tabId
  }

  update (id, data, emit=true) {
    if (!this.has(id)) {
      throw new ReferenceError('Attempted to update a tab that does not exist.')
    }
    const index = this.getIndex(id)

    for (var key in data) {
      if (data[key] === undefined) {
        throw new ReferenceError('Key ' + key + ' is undefined.')
      }
      this.tabs[index][key] = data[key]
      if (emit) {
        this.parentTaskList.emit('tab-updated', id, key, data[key], this.parentTaskList.getTaskContainingTab(id).id)
      }
      // changing URL erases scroll position
      if (key === 'url') {
        this.tabs[index].scrollPosition = 0
        if (emit) {
          this.parentTaskList.emit('tab-updated', id, 'scrollPosition', 0, this.parentTaskList.getTaskContainingTab(id).id)
        }
      }
    }
  }

  destroy (id, emit=true) {
    const index = this.getIndex(id)
    if (index < 0) return false

    // clear multi-selection if the destroyed tab was part of it
    if (this.tabs[index].multiSelected) {
      this.clearMultiSelected(false)
    }

    const containingTask = this.parentTaskList.getTaskContainingTab(id).id

    this.parentTaskList.getTaskContainingTab(id).tabHistory.push(this.toPermanentState(this.tabs[index]))
    this.tabs.splice(index, 1)

    if (emit) {
      this.parentTaskList.emit('tab-destroyed', id, containingTask)
    }

    return index
  }

  get (id) {
    if (!id) { // no id provided, return an array of all tabs
      // it is important to copy the tab objects when returning them. Otherwise, the original tab objects get modified when the returned tabs are modified (such as when processing a url).
      var tabsToReturn = []
      for (var i = 0; i < this.tabs.length; i++) {
        tabsToReturn.push(Object.assign({}, this.tabs[i]))
      }
      return tabsToReturn
    }
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) {
        return Object.assign({}, this.tabs[i])
      }
    }
    return undefined
  }

  has (id) {
    return this.getIndex(id) > -1
  }

  getIndex (id) {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) {
        return i
      }
    }
    return -1
  }

  getSelected () {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].selected) {
        return this.tabs[i].id
      }
    }
    return null
  }

  getSelectedIndex () {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].selected) {
        return i
      }
    }
    return null
  }

  getAtIndex (index) {
    return this.tabs[index] || undefined
  }

  setSelected (id, emit=true) {
    if (!this.has(id)) {
      throw new ReferenceError('Attempted to select a tab that does not exist.')
    }
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) {
        this.tabs[i].selected = true
        this.tabs[i].lastActivity = Date.now()
      } else if (this.tabs[i].selected) {
        this.tabs[i].selected = false
        this.tabs[i].lastActivity = Date.now()
      }
    }
    if (emit) {
      this.parentTaskList.emit('tab-selected', id, this.parentTaskList.getTaskContainingTab(id).id)
    }
  }

  /* marks all tabs between fromId and toId (inclusive) as multi-selected */

  setMultiSelectedRange (fromId, toId, emit=true) {
    if (!this.has(fromId) || !this.has(toId)) {
      throw new ReferenceError('Attempted to select a tab that does not exist.')
    }
    const fromIndex = this.getIndex(fromId)
    const toIndex = this.getIndex(toId)
    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]

    for (var i = 0; i < this.tabs.length; i++) {
      this.tabs[i].multiSelected = (i >= start && i <= end)
    }
    if (emit) {
      this.parentTaskList.emit('tab-multi-selected', fromId, toId, this.parentTaskList.getTaskContainingTab(fromId).id)
    }
  }

  clearMultiSelected (emit=true) {
    var changed = false
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].multiSelected) {
        this.tabs[i].multiSelected = false
        changed = true
      }
    }
    if (changed && emit) {
      this.parentTaskList.emit('tab-multi-selection-cleared', this.parentTaskList.getTaskContainingTab(this.getSelected() || this.tabs[0].id).id)
    }
  }

  getMultiSelected () {
    return this.tabs.filter(tab => tab.multiSelected).map(tab => tab.id)
  }

  getMultiSelectedCount () {
    return this.tabs.filter(tab => tab.multiSelected).length
  }

  moveBy (id, offset) {
    var currentIndex = this.getIndex(id)
    var newIndex = currentIndex + offset
    var newIndexTab = this.getAtIndex(newIndex)
    if (newIndexTab) {
      var currentTab = this.getAtIndex(currentIndex)
      this.splice(currentIndex, 1, newIndexTab)
      this.splice(newIndex, 1, currentTab)
    }
    //This doesn't need to dispatch an event because splice will dispatch already
  }

  count () {
    return this.tabs.length
  }

  isEmpty () {
    if (!this.tabs || this.tabs.length === 0) {
      return true
    }

    if (this.tabs.length === 1 && !this.tabs[0].url) {
      return true
    }

    return false
  }

  forEach (fun) {
    return this.tabs.forEach(fun)
  }

  splice (...args) {
    const containingTask = this.parentTaskList.find(t => t.tabs === this).id
    
    this.parentTaskList.emit('tab-splice', containingTask, ...args)
    return this.tabs.splice.apply(this.tabs, args)
  }

  spliceNoEmit (...args) {
    return this.tabs.splice.apply(this.tabs, args)
  }

  toPermanentState (tab) {
    //removes temporary properties of the tab that are lost on page reload

    let result = {}
      Object.keys(tab)
      .filter(key => !TabList.temporaryProperties.includes(key))
      .forEach(key => result[key] = tab[key])
      
      return result
  }

  getStringifyableState () {
    return this.tabs.map(tab => this.toPermanentState(tab))
  }
}

module.exports = TabList
