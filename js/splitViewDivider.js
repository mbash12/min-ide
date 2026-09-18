/*
Drag handles in the gutters between the panes of the shown split group: one
divider per boundary, so a group of three panes has two. They live in the
renderer, which is the only visible layer between the panes because the native
views never cover the gutters - a divider that overlapped a pane would be
unreachable, since views paint above the renderer.

While dragging, mouse events over the panes (which are native
WebContentsViews on top of the renderer) are relayed back to this module via
the 'view-mouse-event' IPC channel - see js/preload/default.js and the
viewManager relay in the main process.
*/

let splitView = null // set by initialize()

let dividerElements = []
let dragState = null // { index }

/* creates or removes dividers so there is exactly one per gutter */
function getDividerElements () {
  const group = splitView.getActiveGroup()
  if (!group) {
    return []
  }
  const wanted = Math.max(0, group.paneTabIds.length - 1)

  while (dividerElements.length < wanted) {
    const index = dividerElements.length
    const el = document.createElement('div')
    el.className = 'split-view-divider'
    el.addEventListener('mousedown', function (e) {
      e.preventDefault()
      startDragging(e, index)
    })
    document.getElementById('webviews').appendChild(el)
    dividerElements.push(el)
  }
  while (dividerElements.length > wanted) {
    dividerElements.pop().remove()
  }

  return dividerElements
}

function removeDividers () {
  dividerElements.forEach(function (el) {
    el.remove()
  })
  dividerElements = []
}

function updateDividerPositions () {
  if (!splitView.isSplit()) {
    return
  }
  const group = splitView.getActiveGroup()
  const full = splitView.webviews.getViewBounds(group.paneTabIds[group.activePane], true)

  getDividerElements().forEach(function (el, index) {
    const left = splitView.getDividerLeft(index)
    if (left === null) {
      return
    }
    // the divider fills the gutter exactly, so no part of it is hidden
    el.style.left = left + 'px'
    el.style.top = full.y + 'px'
    el.style.height = full.height + 'px'
  })
}

function moveDivider (index, windowX) {
  splitView.setDividerPosition(index, windowX, true)
  updateDividerPositions()
}

function startDragging (e, index) {
  dragState = { index }
  const dragged = dividerElements[index]
  if (dragged) {
    dragged.classList.add('is-dragging')
  }

  function onMouseMove (moveEvent) {
    moveDivider(index, moveEvent.clientX)
  }

  function onMouseUp () {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.classList.remove('is-resizing-split')
    if (dragged) {
      dragged.classList.remove('is-dragging')
    }
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
      moveDivider(dragState.index, args.windowX)
      return
    }
    // fall back to the pane-relative position when the cursor position could
    // not be read in the main process
    const paneIndex = splitView.getPaneIds().indexOf(args.viewId)
    if (paneIndex < 0) {
      return
    }
    const paneBounds = splitView.getBounds()[paneIndex]
    if (paneBounds) {
      moveDivider(dragState.index, paneBounds.x + args.x)
    }
  } else if (args.type === 'mouseup') {
    // release the mouse button as if it happened in the renderer
    document.dispatchEvent(new MouseEvent('mouseup'))
  }
})

const splitViewDivider = {
  initialize: function (splitViewModule) {
    splitView = splitViewModule
    // keep the dividers in sync with split view state changes
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
    updateDividerPositions()
  },
  hide: function () {
    removeDividers()
  },
  update: function () {
    updateDividerPositions()
  }
}

module.exports = splitViewDivider
