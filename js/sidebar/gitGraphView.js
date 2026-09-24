/* global requestAnimationFrame, confirm, prompt, alert */
/* Graph rendering and splitter behavior for the Source Control panel. */

module.exports = function createGitGraphView (options) {
  const document = options.document
  const ipc = options.ipc
  const l = options.l
  const fileIcons = options.fileIcons
  const electron = options.electron
  const empty = options.empty
  const panel = options.panel
  const collapsedSections = options.collapsedSections
  const graphState = options.graphState
  const persistStateSoon = options.persistStateSoon
  const statusLetterColor = options.statusLetterColor
  const getGitRoot = options.getGitRoot
  const getWorkspacePath = options.getWorkspacePath
  const getRenderToken = options.getRenderToken
  const refresh = options.refresh

  function compactDate (timestamp) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp))
    if (seconds < 60) return 'now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + 'm'
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + 'h'
    const days = Math.floor(hours / 24)
    if (days < 7) return days + 'd'
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return weeks + 'w'
    const months = Math.floor(days / 30)
    if (months < 12) return months + 'mo'
    return Math.floor(days / 365) + 'y'
  }

  /* Graph lane colors, cycled per active lane (like VSCode's graph) */
  const graphLaneColors = ['#0e639c', '#cca700', '#73c991', '#f85149', '#9b59b6', '#e67e22', '#1abc9c', '#c0392b']

  /* SVG symbols used to draw the graph: commit dot, straight vertical line,
   branch corner, and the merge "T" shape */
  const graphSvgNs = 'http://www.w3.org/2000/svg'

  function laneSymbol (color, kind) {
    const svg = document.createElementNS(graphSvgNs, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.classList.add('git-graph-lane-svg')
    const path = document.createElementNS(graphSvgNs, 'path')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    if (kind === 'dot') {
      path.setAttribute('d', 'M8 8 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0')
      path.setAttribute('fill', color)
    } else if (kind === 'vline') {
      path.setAttribute('d', 'M8 0 L8 16')
    } else if (kind === 'corner') {
    // branch turns right: enter from the left, then continue down
      path.setAttribute('d', 'M2 8 L8 8 L8 16')
    } else if (kind === 'merge') {
    // merge from the right: come down, then turn left
      path.setAttribute('d', 'M8 0 L8 8 L2 8')
    } else if (kind === 'elbow') {
    // horizontal connector
      path.setAttribute('d', 'M2 8 L14 8')
    } else if (kind === 'diag-r') {
    // '\' connector: from the left column down to the right column
      path.setAttribute('d', 'M4 2 L12 14')
    } else if (kind === 'diag-l') {
    // '/' connector: from the right column down to the left column
      path.setAttribute('d', 'M12 2 L4 14')
    }
    svg.appendChild(path)
    return svg
  }

  /* The graph is drawn from git's --graph ASCII output, which is a sequence of
   "lane columns". Each column is 2 chars wide (a lane char + a space). A
   state machine walks the columns row by row: '|' keeps the lane open,
   '*' places the commit dot, '\' opens a new lane to the right, '/' closes a
   lane from the right, '-' draws a horizontal connector (branch/merge). Each
   lane gets a stable color that follows it down the graph. */
  function buildGraphRows (graphLines) {
    const rows = []
    // laneStates[idx] = color of the lane currently passing through column idx
    let laneStates = []
    let nextColorIndex = 0

    const newLaneColor = function () {
      const color = graphLaneColors[nextColorIndex % graphLaneColors.length]
      nextColorIndex++
      return color
    }

    graphLines.forEach(function (line) {
      const laneMatch = line.match(/^([*|\\/\-\s]+)/)
      const prefix = laneMatch ? laneMatch[1] : ''
      const rest = line.slice(prefix.length).trim()

      // git writes one 2-char column per lane: position 2i holds the lane char,
      // position 2i+1 holds a connector ('\', '/' or ' ')
      const cols = []
      for (let i = 0; i < prefix.length; i += 2) {
        cols.push({ lane: prefix[i] || ' ', conn: prefix[i + 1] || ' ' })
      }

      const symbols = []
      const nextLaneStates = []
      let hasCommit = false

      cols.forEach(function (col, idx) {
        const ch = col.lane
        const conn = col.conn
        const prev = laneStates[idx] || null

        if (ch === '*') {
          hasCommit = true
          const color = prev || newLaneColor()
          symbols.push({ kind: 'dot', color: color, col: idx })
          if (conn === '\\') {
          // branch splits off to the right
            const branchColor = newLaneColor()
            symbols.push({ kind: 'diag-r', color: branchColor, col: idx })
            nextLaneStates[idx + 1] = branchColor
            nextLaneStates[idx] = color
          } else if (conn === '/') {
          // a lane merges in from the right
            const mergedColor = laneStates[idx + 1] || newLaneColor()
            symbols.push({ kind: 'diag-l', color: mergedColor, col: idx })
            nextLaneStates[idx] = color
          } else {
          // the lane continues straight down
            nextLaneStates[idx] = color
          }
        } else if (ch === '|') {
          const color = prev || newLaneColor()
          symbols.push({ kind: 'vline', color: color, col: idx })
          nextLaneStates[idx] = color
          if (conn === '\\') {
          // a new branch lane starts here
            const branchColor = newLaneColor()
            symbols.push({ kind: 'diag-r', color: branchColor, col: idx })
            nextLaneStates[idx + 1] = branchColor
          } else if (conn === '/') {
          // the lane from the right merges into this one
            const mergedColor = laneStates[idx + 1] || newLaneColor()
            symbols.push({ kind: 'diag-l', color: mergedColor, col: idx })
          }
        } else if (ch === '-') {
        // horizontal connector
          const color = prev || laneStates[idx - 1] || newLaneColor()
          symbols.push({ kind: 'elbow', color: color, col: idx })
          nextLaneStates[idx] = color
        } else if (ch === '\\') {
        // rare: backslash as the lane char itself
          const color = prev || newLaneColor()
          symbols.push({ kind: 'corner', color: color, col: idx })
          nextLaneStates[idx + 1] = color
        } else if (ch === '/') {
          const color = prev || laneStates[idx + 1] || newLaneColor()
          symbols.push({ kind: 'merge', color: color, col: idx })
          nextLaneStates[idx - 1] = color
        }
      // ' ' closes any lane at this column
      })

      laneStates = nextLaneStates
      rows.push({ symbols: symbols, rest: rest, hasCommit: hasCommit })
    })

    return rows
  }

  function buildGraphDetail (commit) {
    const detail = document.createElement('div')
    detail.className = 'git-graph-detail'

    // hash/author/date/refs are already on the row itself; the detail keeps
    // the full message (the row truncates it) plus the commit's file list
    const message = document.createElement('div')
    message.className = 'git-graph-detail-message'
    message.textContent = commit.message
    detail.appendChild(message)

    const files = document.createElement('div')
    files.className = 'git-commit-files'
    detail.appendChild(files)
    loadCommitFiles(commit, files)

    return detail
  }

  /* the list of files a commit touched, shown in the graph's detail view;
clicking one opens it as a diff tab against the commit's parent */
  async function loadCommitFiles (commit, container) {
    const loading = document.createElement('div')
    loading.className = 'git-commit-files-empty'
    loading.textContent = l('gitLoadingFiles') || 'Loading files…'
    container.appendChild(loading)

    const token = getRenderToken()
    const cwd = getGitRoot() || getWorkspacePath()
    try {
      const result = await ipc.invoke('gitCommitFiles', cwd, commit.hash)
      // the panel may have been re-rendered while the list was loading
      if (token !== getRenderToken() || !container.isConnected) return
      empty(container)
      if (!result || result.error || !result.files || result.files.length === 0) {
        const emptyEl = document.createElement('div')
        emptyEl.className = 'git-commit-files-empty'
        emptyEl.textContent = (result && result.error) || l('gitNoFiles') || 'No files'
        container.appendChild(emptyEl)
        return
      }
      result.files.forEach(function (file) {
        container.appendChild(buildCommitFileRow(commit, file, cwd))
      })
    } catch (e) {
      if (token !== getRenderToken() || !container.isConnected) return
      empty(container)
      const errEl = document.createElement('div')
      errEl.className = 'git-commit-files-empty'
      errEl.textContent = e.message || 'Failed to load files'
      container.appendChild(errEl)
    }
  }

  function buildCommitFileRow (commit, file, cwd) {
    const row = document.createElement('div')
    row.className = 'git-file-row git-commit-file-row'

    const name = file.path.split(/[\\/]/).pop()
    const icon = document.createElement('img')
    icon.className = 'file-tree-icon'
    icon.src = fileIcons.pathPrefix + fileIcons.getIcon(name)
    icon.alt = ''
    icon.draggable = false
    row.appendChild(icon)

    const label = document.createElement('span')
    label.className = 'git-file-label'
    label.title = file.oldPath ? file.oldPath + ' → ' + file.path : file.path
    const fileName = document.createElement('span')
    fileName.className = 'git-file-name'
    fileName.textContent = name
    label.appendChild(fileName)
    const dirPart = file.path.split(/[\\/]/)
    dirPart.pop()
    if (dirPart.length) {
      const parentPath = document.createElement('span')
      parentPath.className = 'git-file-path'
      parentPath.textContent = dirPart.join('/')
      label.appendChild(parentPath)
    }
    row.appendChild(label)

    const statusBadge = document.createElement('span')
    statusBadge.className = 'git-status-badge'
    statusBadge.textContent = file.status
    statusBadge.style.color = statusLetterColor(file.status)
    row.appendChild(statusBadge)

    row.addEventListener('click', function () {
      openCommitFileDiff(commit, file, cwd)
    })

    return row
  }

  /* a file inside a commit opens as a diff against the commit's parent; for
root commits or files added/deleted by it, the missing side renders empty */
  function openCommitFileDiff (commit, file, cwd) {
    const editorView = require('editorView.js')
    const name = file.path.split(/[\\/]/).pop()
    editorView.openDiff({
      cwd: cwd,
      resource: cwd + '/' + file.path,
      title: name + ' (' + commit.shortHash + ')',
      left: { type: 'ref', ref: commit.hash + '^', path: file.oldPath || file.path, label: commit.shortHash + '^' },
      right: { type: 'ref', ref: commit.hash, path: file.path, label: commit.shortHash }
    })
  }

  function buildGraphSection () {
    const graphData = options.getGraphData()
    const sectionKey = 'graph'
    const section = document.createElement('div')
    section.className = 'git-section git-graph-section'
    section.dataset.section = sectionKey
    // re-apply the splitter-dragged height; renders rebuild this element, so
    // without this the view snaps back to the CSS default on every refresh
    if (graphState.viewHeight > 0 && !collapsedSections.has(sectionKey)) {
      section.style.flexBasis = graphState.viewHeight + 'px'
    }

    const header = document.createElement('div')
    header.className = 'git-section-header'
    header.addEventListener('click', function () {
      if (collapsedSections.has(sectionKey)) collapsedSections.delete(sectionKey)
      else collapsedSections.add(sectionKey)
      const collapsed = collapsedSections.has(sectionKey)
      section.classList.toggle('collapsed', collapsed)
      // a splitter-dragged flexBasis would keep the collapsed view tall;
      // drop it so the section shrinks to just its header
      if (collapsed) {
        section.style.flexBasis = ''
      } else if (graphState.viewHeight > 0) {
        section.style.flexBasis = graphState.viewHeight + 'px'
      }
      persistStateSoon()
    })
    const chevron = document.createElement('span')
    chevron.className = 'codicon codicon-chevron-down git-section-chevron'
    if (collapsedSections.has(sectionKey)) section.classList.add('collapsed')
    header.appendChild(chevron)
    const titleEl = document.createElement('span')
    titleEl.className = 'git-section-title'
    const count = graphData.commits ? graphData.commits.length : 0
    titleEl.textContent = (l('gitGraph') || 'Graph') + (count ? ' (' + count + ')' : '')
    header.appendChild(titleEl)
    section.appendChild(header)

    const body = document.createElement('div')
    body.className = 'git-section-body git-graph'

    if (graphData.commits && graphData.commits.length > 0) {
      const container = document.createElement('div')
      container.className = 'git-graph-container'

      // build the full lane layout once, then pair commit rows with commits by
      // index (connector-only rows like "|\" are skipped)
      const rawLines = (graphData.graph && typeof graphData.graph === 'string')
        ? graphData.graph.split('\n').filter(Boolean)
        : []
      const graphRows = buildGraphRows(rawLines).filter(function (r) { return r.hasCommit })

      graphData.commits.forEach(function (commit, index) {
        const row = document.createElement('div')
        row.className = 'git-graph-row'
        row.dataset.hash = commit.hash
        row.title = commit.hash + ' ' + commit.message

        const lane = document.createElement('span')
        lane.className = 'git-graph-lane'
        const parsed = graphRows[index] || { symbols: [], rest: '' }
        if (parsed.symbols.length) {
          parsed.symbols.forEach(function (sym) {
            const icon = laneSymbol(sym.color, sym.kind)
            icon.style.marginLeft = (sym.col * 14) + 'px'
            lane.appendChild(icon)
          })
        } else {
          lane.appendChild(laneSymbol(graphLaneColors[0], 'dot'))
        }
        row.appendChild(lane)

        const hashEl = document.createElement('span')
        hashEl.className = 'git-graph-hash'
        hashEl.textContent = commit.shortHash
        row.appendChild(hashEl)

        const msgEl = document.createElement('span')
        msgEl.className = 'git-graph-message'
        msgEl.textContent = commit.message
        if (commit.refs) {
          const refsEl = document.createElement('span')
          refsEl.className = 'git-graph-refs'
          refsEl.textContent = commit.refs
          msgEl.appendChild(refsEl)
        }
        row.appendChild(msgEl)

        const authorEl = document.createElement('span')
        authorEl.className = 'git-graph-author'
        authorEl.textContent = commit.author
        row.appendChild(authorEl)

        const dateEl = document.createElement('span')
        dateEl.className = 'git-graph-date'
        dateEl.textContent = compactDate(commit.date)
        row.appendChild(dateEl)

        // clicking a commit toggles its detail + diff view
        row.addEventListener('click', function () {
          graphState.expandedCommit = (graphState.expandedCommit === commit.hash) ? null : commit.hash
          persistStateSoon()
          const detailEl = row.nextElementSibling
          if (detailEl && detailEl.classList.contains('git-graph-detail')) {
            detailEl.remove()
          }
          if (graphState.expandedCommit === commit.hash) {
            row.classList.add('expanded')
            row.after(buildGraphDetail(commit))
          } else {
            row.classList.remove('expanded')
          }
        })

        // right-click: undo (HEAD only) / create branch / checkout / copy hash
        row.addEventListener('contextmenu', function (e) {
          e.preventDefault()
          const remoteMenu = require('remoteMenuRenderer.js')
          const cwd = getGitRoot() || getWorkspacePath()
          const short = commit.shortHash
          const menu = []
          // undo only makes sense for the tip commit: it deletes HEAD and
          // moves the commit's changes back to the index
          if (commit.refs && commit.refs.indexOf('HEAD') !== -1) {
            menu.push({
              label: l('gitUndoCommit') || 'Undo Commit',
              click: function () {
                if (!confirm((l('gitUndoCommitConfirm') || 'Undo commit %s? Its changes will move back to Staged Changes.').replace('%s', short))) return
                ipc.invoke('gitUndoCommit', cwd).then(function (err) {
                  if (err) alert(err)
                  refresh()
                })
              }
            })
          }
          menu.push({
            label: l('gitCreateBranchAt') || 'Create Branch from Commit…',
            click: function () {
              const name = prompt(l('gitBranchName') || 'Branch name')
              if (!name) return
              ipc.invoke('gitCreateBranchAt', cwd, name, commit.hash).then(function (err) {
                if (err) alert(err)
                refresh()
              })
            }
          },
          {
            label: l('gitCheckoutCommit') || 'Checkout Commit',
            click: function () {
              if (!confirm((l('gitCheckoutCommitConfirm') || 'Checkout commit %s?').replace('%s', short))) return
              ipc.invoke('gitCheckoutCommit', cwd, commit.hash).then(function (err) {
                if (err) alert(err)
                refresh()
              })
            }
          })
          menu.push({
            label: l('gitCopyHash') || 'Copy Commit Hash',
            click: function () {
              electron.clipboard.writeText(commit.hash)
            }
          })
          remoteMenu.open([menu], e.clientX, e.clientY)
        })

        container.appendChild(row)

        if (graphState.expandedCommit === commit.hash) {
          row.classList.add('expanded')
          row.after(buildGraphDetail(commit))
        }
      })

      body.appendChild(container)
    } else if (graphData.graph && typeof graphData.graph === 'string' && graphData.graph.trim()) {
      const container = document.createElement('div')
      container.className = 'git-graph-container'
      const graphRows = buildGraphRows(graphData.graph.split('\n').filter(Boolean))
      graphRows.forEach(function (parsed) {
        const row = document.createElement('div')
        row.className = 'git-graph-row'
        const lane = document.createElement('span')
        lane.className = 'git-graph-lane'
        parsed.symbols.forEach(function (sym) {
          const icon = laneSymbol(sym.color, sym.kind)
          icon.style.marginLeft = (sym.col * 14) + 'px'
          lane.appendChild(icon)
        })
        row.appendChild(lane)
        const msg = document.createElement('span')
        msg.className = 'git-graph-message'
        msg.textContent = parsed.rest
        row.appendChild(msg)
        container.appendChild(row)
      })
      body.appendChild(container)
    } else {
      const empty = document.createElement('div')
      empty.className = 'git-graph-empty'
      empty.textContent = l('gitNoCommits') || 'No commits'
      body.appendChild(empty)
    }
    section.appendChild(body)

    // restore the saved scroll position once the graph is in the DOM
    requestAnimationFrame(function () {
      const container = section.querySelector('.git-graph-container')
      if (!container) return
      if (graphState.scrollTop > 0) container.scrollTop = graphState.scrollTop
      // remember the scroll position while the user browses the graph
      container.addEventListener('scroll', function () {
        graphState.scrollTop = container.scrollTop
        persistStateSoon()
      }, { passive: true })
    })
    return section
  }

  function buildViewSplitter (graphView) {
    const splitter = document.createElement('div')
    splitter.className = 'git-view-splitter'
    splitter.setAttribute('role', 'separator')
    splitter.setAttribute('aria-orientation', 'horizontal')
    splitter.tabIndex = 0

    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = graphView.getBoundingClientRect().height
      document.body.classList.add('is-resizing-git-views')

      function resize (moveEvent) {
        const panelHeight = panel.getBoundingClientRect().height
        const maxHeight = Math.max(96, panelHeight - 180)
        const nextHeight = Math.max(72, Math.min(maxHeight, startHeight + startY - moveEvent.clientY))
        graphView.style.flexBasis = Math.round(nextHeight) + 'px'
      }

      function stop () {
        document.removeEventListener('mousemove', resize)
        document.removeEventListener('mouseup', stop)
        document.body.classList.remove('is-resizing-git-views')
        // remember the dragged height; render() rebuilds the graph element
        // and would otherwise lose it on the next refresh
        graphState.viewHeight = Math.round(graphView.getBoundingClientRect().height)
        persistStateSoon()
      }

      document.addEventListener('mousemove', resize)
      document.addEventListener('mouseup', stop)
    })
    return splitter
  }

  return { buildGraphSection: buildGraphSection, buildViewSplitter: buildViewSplitter }
}
