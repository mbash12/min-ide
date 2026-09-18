/*
Drag handle in the gutter between the two split panes.
It lives in the renderer (the only visible UI layer between the panes)
and updates the split ratio while dragging.

The divider element is created lazily when split view is entered and
removed when it exits.

While dragging, mouse events over the panes (which are native
WebContentsViews on top of the renderer) are relayed back to this
module via the 'view-mouse-event' IPC channel - see
js/preload/default.js and the viewManager relay in the main process.
*/

let splitView = null // set by initialize()

let dividerElement = null
let dragState = null // { full, startX, startRatio }

function getDivider () {
  if (!dividerElement) {
    dividerElement = document.createElement('div')
    dividerElement.className = 'split-view-divider'
    dividerElement.addEventListener('mousedown', function (e) {
      e.preventDefault()
      startDragging(e)
    })
    document.getElementById('webviews').appendChild(dividerElement)
  }
  return dividerElement
}

function removeDivider () {
  if (dividerElement) {
    dividerElement.remove()
    dividerElement = null
  }
}

function updateDividerPosition () {
  if (!splitView.isSplit() || !dividerElement) {
    return
  }
  const bounds = splitView.getBounds()
  const leftPane = bounds[0]
  const full = splitView.webviews.getViewBounds(splitView.getActiveTabId(), true)

  // the divider sits exactly in the gutter between the two panes
  dividerElement.style.left = (leftPane.x + leftPane.width) + 'px'
  dividerElement.style.top = full.y + 'px'
  dividerElement.style.height = full.height + 'px'
}

function applyRatio (windowX) {
  if (!dragState) {
    return
  }
  const deltaX = windowX - dragState.startX
  const newRatio = dragState.startRatio + (deltaX / dragState.full.width)
  splitView.setSplitRatio(newRatio, true)
  updateDividerPosition()
}

function startDragging (e) {
  const full = splitView.webviews.getViewBounds(splitView.getActiveTabId(), true)
  const activeGroup = splitView.getActiveGroup()
  dragState = {
    full: full,
    startX: e.clientX,
    startRatio: activeGroup ? activeGroup.splitRatio : 0.5
  }

  function onMouseMove (e) {
    applyRatio(e.clientX)
  }

  function onMouseUp () {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.classList.remove('is-resizing-split')
    dragState = null
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.classList.add('is-resizing-split')
}

/* mouse events relayed from the panes while dragging */
ipc.on('view-mouse-event', function (e, args) {
  if (!dragState) {
    return
  }
  if (args.type === 'mousemove') {
    if (typeof args.windowX === 'number') {
      // window-relative cursor position, independent of the pane bounds that
      // the drag itself is moving
      applyRatio(args.windowX)
      return
    }
    // the event coordinates are relative to the pane that sent them,
    // so convert them to window coordinates using the pane bounds
    const paneIndex = splitView.getPaneIds().indexOf(args.viewId)
    if (paneIndex < 0) {
      return
    }
    const paneBounds = splitView.getBounds()[paneIndex]
    applyRatio(paneBounds.x + args.x)
  } else if (args.type === 'mouseup') {
    // release the mouse button as if it happened in the renderer
    document.dispatchEvent(new MouseEvent('mouseup'))
  }
})

const splitViewDivider = {
  initialize: function (splitViewModule) {
    splitView = splitViewModule
    // keep the divider in sync with split view state changes
    splitViewModule.onLayoutChange = function (isEntering) {
      if (isEntering === true) {
        splitViewDivider.show()
      } else if (isEntering === false) {
        splitViewDivider.hide()
      } else {
        splitViewDivider.update()
      }
    }
  },
  show: function () {
    getDivider()
    updateDividerPosition()
  },
  hide: function () {
    removeDivider()
  },
  update: function () {
    updateDividerPosition()
  }
}

module.exports = splitViewDivider
