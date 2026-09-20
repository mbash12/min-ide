window.ToastUIEditor = require('@toast-ui/editor')

/* Mermaid is loaded by the editor pages as a plain script (mermaid.min.js
sets a global). These helpers keep the Toast UI + mermaid glue shared between
the documents and notes pages: a ```mermaid code block is drawn with
mermaid.render and the svg is placed in a .mermaid container - swapped in
for the block in the markdown preview, appended below the editable code
block in WYSIWYG via a widget decoration (ProseMirror owns that DOM, so
it survives view updates that would strip foreign children of nodeViews). */
window.MinMermaid = {
  available: function () {
    return !!(window.mermaid && typeof window.mermaid.render === 'function')
  },
  init: function (dark) {
    if (!this.available() || this.initialized) return
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
      /* HTML edge labels are measured through foreignObject, which does not
       * lay out correctly inside this sandboxed view - dagre then throws
       * "Could not find a suitable point for the given distance". Plain SVG
       * labels measure fine. */
      flowchart: { htmlLabels: false },
      sequence: { htmlLabels: false }
    })
    this.initialized = true
  },
  /* Toast UI rebuilds rendered DOM on each change, so this runs again after
  every update. Two surfaces are handled under `root` (the editor element):
   * - the markdown preview pane, where a `pre > code` mermaid block is
   *   swapped outright for the diagram container;
   * - the WYSIWYG surface, where each code block is a
   *   `.toastui-editor-ww-code-block` nodeView - its `code` is ProseMirror
   *   content, but the wrapper is nodeView chrome, so a sibling diagram
   *   container is safe there and survives edits to the code.
  Hidden surfaces are skipped: mermaid measures with getBBox, and rendering
  into display:none content makes dagre throw "Could not find a suitable
  point for the given distance".
  Diagrams are drawn with mermaid.render(id, text) rather than mermaid.run:
  run renders inside the target element, but mermaid locates that element
  via a document.body-wide lookup while Toast UI may rebuild (detach) it at
  any await - the lookup then comes back empty and crashes with "Cannot
  read properties of null (reading 'getAttribute')". render() without a
  container draws in temp elements on document.body instead, which Toast UI
  never touches, and hands back the finished svg to paste in. Calls are
  still serialized here so a rebuild during a draw triggers a follow-up
  pass with the latest source. */
  render: function (root) {
    if (!this.available()) return Promise.resolve('mermaid-not-loaded')
    if (!root) return Promise.resolve('no-preview')
    const self = this
    if (this._run) {
      this._queuedRoot = root
      if (!this._queuedRun) {
        this._queuedRun = this._run.then(function () {
          self._queuedRun = null
          const next = self._queuedRoot
          self._queuedRoot = null
          return self.render(next)
        })
      }
      return this._queuedRun
    }
    const run = this._renderNow(root)
    this._run = run.then(function () { self._run = null }, function () { self._run = null })
    return run
  },
  _renderNow: function (root) {
    const preview = root.querySelector('.toastui-editor-md-preview')
    if (preview && preview.getClientRects().length) {
      preview.querySelectorAll('pre > code[data-language="mermaid"], pre > code.language-mermaid').forEach(function (code) {
        const pre = code.parentNode
        const div = document.createElement('div')
        div.className = 'mermaid'
        div.dataset.minSource = code.textContent
        div.dataset.minPending = '1'
        div.textContent = code.textContent
        pre.parentNode.replaceChild(div, pre)
      })
    }

    /* Containers to draw into: preview swaps above and widget decoration
    divs on the WYSIWYG surface, both marked data-min-pending until drawn. */
    const jobs = []
    root.querySelectorAll('.mermaid[data-min-pending]').forEach(function (div) {
      if (!div.getClientRects().length || !div.isConnected) return
      jobs.push({ div: div, source: div.dataset.minSource || div.textContent })
    })
    if (!jobs.length) return Promise.resolve('none')
    const self = this
    let chain = Promise.resolve()
    jobs.forEach(function (job) {
      chain = chain.then(function () {
        if (!job.div.isConnected) return
        const id = 'min-mermaid-' + Date.now() + '-' + (self._renderSeq = (self._renderSeq || 0) + 1)
        return window.mermaid.render(id, job.source).then(function (res) {
          delete job.div.dataset.minPending
          job.div.innerHTML = res.svg
          if (res.bindFunctions) res.bindFunctions(job.div)
        }, function (err) {
          delete job.div.dataset.minPending
          job.error = describeMermaidError(err)
        })
      })
    })
    return chain.then(function () {
      const failed = jobs.filter(function (job) { return job.error })
      return failed.length ? 'error: ' + failed[0].error : 'rendered'
    })
  }
}

function hashSource (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0
  return h.toString(36)
}

/* Toast UI plugin: on the WYSIWYG surface every ```mermaid code block gets a
 * widget decoration right after it, so the rendered diagram sits below the
 * still-editable code. The widget key carries the source hash - ProseMirror
 * reuses the DOM (and the drawn svg) while the source is unchanged and
 * recreates it when the block is edited. Widgets cannot be nested inside the
 * code block nodeView: its ignoreMutation is undefined, so ProseMirror would
 * wipe foreign children on the next DOM sync. */
window.MinMermaidPlugin = function (context) {
  const Plugin = context.pmState.Plugin
  const Decoration = context.pmView.Decoration
  const DecorationSet = context.pmView.DecorationSet
  return {
    wysiwygPlugins: [function () {
      return new Plugin({
        props: {
          decorations: function (state) {
            const widgets = []
            let index = 0
            state.doc.descendants(function (node, pos) {
              if (node.type.name !== 'codeBlock') return true
              if ((node.attrs.language || '').toLowerCase() !== 'mermaid') return false
              const source = node.textContent
              if (!source.trim()) return false
              const key = 'min-mermaid-' + (index++) + '-' + hashSource(source)
              widgets.push(Decoration.widget(pos + node.nodeSize, function () {
                const div = document.createElement('div')
                div.className = 'mermaid'
                div.dataset.minSource = source
                div.dataset.minPending = '1'
                div.textContent = source
                return div
              }, { key: key }))
              return false
            })
            return DecorationSet.create(state.doc, widgets)
          }
        }
      })
    }]
  }
}

/* mermaid wraps render failures in plain {str, message, error} objects, so
the real stack lives on .error when present. */
function describeMermaidError (err) {
  const inner = (err && err.error) || err
  const message = (err && err.message) || (inner && inner.message) || String(err)
  const stack = inner && inner.stack ? String(inner.stack).split('\n').slice(0, 3).join(' | ') : ''
  return message + (stack ? ' @@ ' + stack : '')
}
