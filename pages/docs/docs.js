/* global ToastUIEditor */

(function () {
  const titleInput = document.getElementById('docs-title')
  const privateInput = document.getElementById('docs-private')
  const saveStatus = document.getElementById('docs-save-status')
  const stateEl = document.getElementById('docs-state')
  const editorEl = document.getElementById('docs-editor')
  const query = new URL(window.location.href).searchParams
  const workspaceId = query.get('workspace') || ''
  const documentId = query.get('doc') || ''
  const pending = Object.create(null)
  let editor = null
  let requestSeq = 0
  let saveTimer = null
  let mermaidTimer = null
  let editRevision = 0
  let savedRevision = 0
  let saveInFlight = false
  let ready = false

  function invoke (action, payload) {
    return new Promise(function (resolve) {
      const requestId = 'docs-' + (++requestSeq) + '-' + Date.now()
      pending[requestId] = resolve
      window.postMessage({
        message: 'docs-invoke',
        requestId: requestId,
        action: action,
        payload: payload
      }, window.location.toString())
    })
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data || e.data.message !== 'docs-result') return
    const resolve = pending[e.data.requestId]
    if (!resolve) return
    delete pending[e.data.requestId]
    resolve(e.data.result)
  })

  function setStatus (text, isError) {
    saveStatus.textContent = text || ''
    saveStatus.classList.toggle('error', !!isError)
  }

  function showError (message) {
    stateEl.hidden = false
    stateEl.className = 'error'
    stateEl.textContent = message || 'Could not load this document.'
    editorEl.hidden = true
  }

  /* The editor rebuilds rendered DOM on each change, so mermaid blocks are
   * re-rendered shortly after typing settles. MinMermaid covers the markdown
   * preview pane (diagram replaces the block) and the WYSIWYG surface
   * (diagram under the editable code block), skipping whichever is hidden. */
  function renderMermaidPreview () {
    if (window.MinMermaid) {
      window.MinMermaid.render(editorEl).then(function (result) {
        if (result && result !== 'rendered' && result !== 'none' && result !== 'no-preview' && result !== 'hidden-preview') {
          setStatus('mermaid: ' + result, true)
        }
      })
    }
  }

  function scheduleMermaidRender () {
    clearTimeout(mermaidTimer)
    mermaidTimer = setTimeout(renderMermaidPreview, 500)
  }

  function scheduleSave () {
    if (!ready) return
    editRevision++
    setStatus('Unsaved')
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, 500)
    scheduleMermaidRender()
  }

  async function flushSave () {
    clearTimeout(saveTimer)
    saveTimer = null
    if (!ready || saveInFlight || savedRevision === editRevision) return
    const revision = editRevision
    saveInFlight = true
    setStatus('Saving…')
    const result = await invoke('update', {
      workspaceId: workspaceId,
      id: documentId,
      title: titleInput.value.trim() || 'Untitled',
      markdown: editor.getMarkdown()
    })
    saveInFlight = false
    if (!result || result.ok === false) {
      setStatus((result && result.error) || 'Save failed', true)
      return
    }
    savedRevision = revision
    document.title = (result.document && result.document.title) || titleInput.value.trim() || 'Untitled'
    if (editRevision === savedRevision) {
      setStatus('Saved')
    } else {
      flushSave()
    }
  }

  titleInput.addEventListener('input', scheduleSave)
  titleInput.addEventListener('blur', flushSave)

  privateInput.addEventListener('change', async function () {
    if (!ready) return
    privateInput.disabled = true
    setStatus('Saving…')
    const desired = privateInput.checked
    const result = await invoke('update', {
      workspaceId: workspaceId,
      id: documentId,
      private: desired
    })
    privateInput.disabled = false
    if (!result || result.ok === false) {
      privateInput.checked = !desired
      setStatus((result && result.error) || 'Privacy update failed', true)
      return
    }
    setStatus(savedRevision === editRevision ? 'Saved' : 'Unsaved')
  })

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave()
  })
  window.addEventListener('beforeunload', flushSave)

  async function load () {
    if (!workspaceId || !documentId) {
      showError('Invalid document link.')
      return
    }
    const result = await invoke('get', { workspaceId: workspaceId, id: documentId })
    if (!result || result.ok === false || !result.document) {
      showError((result && result.error) || 'Document not found.')
      return
    }

    const doc = result.document
    titleInput.value = doc.title || 'Untitled'
    privateInput.checked = doc.private === true
    document.title = titleInput.value
    stateEl.hidden = true
    editorEl.hidden = false

    const Editor = typeof ToastUIEditor === 'function' ? ToastUIEditor : ToastUIEditor.default
    if (typeof Editor !== 'function') throw new Error('Toast UI Editor failed to load.')

    editor = new Editor({
      el: editorEl,
      height: 'calc(100vh - 50px)',
      initialValue: doc.markdown || '',
      initialEditType: (((window.minViewResource || {}).extra || {}).defaultMode === 'markdown') ? 'markdown' : 'wysiwyg',
      previewStyle: 'vertical',
      usageStatistics: false,
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      placeholder: 'Start writing…',
      plugins: window.MinMermaidPlugin ? [window.MinMermaidPlugin] : [],
      toolbarItems: [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task'],
        ['table', 'link'],
        ['code', 'codeblock']
      ],
      events: {
        change: scheduleSave,
        blur: flushSave,
        changeMode: function () {
          setTimeout(renderMermaidPreview, 50)
        }
      }
    })

    if (window.MinMermaid) {
      window.MinMermaid.init(window.matchMedia('(prefers-color-scheme: dark)').matches)
    }

    ready = true
    setStatus('Saved')
    editor.focus()
    renderMermaidPreview()
  }

  load().catch(function (err) {
    showError(err && err.message ? err.message : 'Could not load this document.')
  })
})()
