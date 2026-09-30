const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { webContents } = require('electron')

module.exports = async function smokeSurfaces (ui, scratch) {
  async function waitFor (label, check) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out: ' + label)
  }
  function evaluate (source) { return ui.executeJavaScript(source) }
  async function pageFor (url, ready) {
    return waitFor(url, async () => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))
      if (page && await page.executeJavaScript(ready).catch(() => false)) return page
    })
  }

  // Exercise the normal sidebar open path so tab kind/resource metadata,
  // sandbox preloads, page code and persistence all participate.
  const documentResult = await evaluate("ipc.invoke('db:createDocument', {workspaceId:'stress-4',title:'Smoke document'})")
  assert.equal(documentResult.ok, true)
  const documentId = documentResult.document.id
  await evaluate("sidebar.show('docs')")
  const docSelector = '.docs-row[data-document-id="' + documentId + '"]'
  await waitFor('Docs row', () => evaluate('Boolean(document.querySelector(' + JSON.stringify(docSelector) + '))'))
  await evaluate('document.querySelector(' + JSON.stringify(docSelector) + ').click()')
  const docs = await pageFor('min://app/pages/docs/index.html', 'Boolean(document.querySelector(".toastui-editor-defaultUI"))')
  await docs.executeJavaScript('document.getElementById("docs-title").value = "Saved document"; document.getElementById("docs-title").dispatchEvent(new Event("input"))')
  await waitFor('Docs autosave', async () => {
    const result = await evaluate('ipc.invoke("db:getDocument",' + JSON.stringify({ workspaceId: 'stress-4', id: documentId }) + ')')
    return result.document && result.document.title === 'Saved document'
  })

  const noteResult = await evaluate("ipc.invoke('db:createNote', {title:'Smoke note',markdown:''})")
  assert.equal(noteResult.ok, true)
  const noteId = noteResult.note.id
  await evaluate("sidebar.show('notes')")
  const noteSelector = '.notes-row[data-note-id="' + noteId + '"]'
  await waitFor('Notes row', () => evaluate('Boolean(document.querySelector(' + JSON.stringify(noteSelector) + '))'))
  await evaluate('document.querySelector(' + JSON.stringify(noteSelector) + ').click()')
  const notes = await pageFor('min://app/pages/notes/index.html', 'Boolean(document.querySelector(".toastui-editor-defaultUI"))')
  await notes.executeJavaScript('document.getElementById("notes-title").value = "Saved note"; document.getElementById("notes-title").dispatchEvent(new Event("input"))')
  await waitFor('Notes autosave', async () => {
    const result = await evaluate('ipc.invoke("db:getNote",' + JSON.stringify({ id: noteId }) + ')')
    return result.note && result.note.title === 'Saved note'
  })

  const folder = path.join(scratch, 'workspace')
  fs.mkdirSync(folder)
  const file = path.join(folder, 'smoke.txt')
  fs.writeFileSync(file, 'original text\n')
  await evaluate('workspaces.update("stress-4", {path:' + JSON.stringify(folder) + '}); sidebar.show("files")')
  const fileSelector = '.file-tree-row.file[data-path="' + file + '"]'
  await waitFor('File row', () => evaluate('Boolean(document.querySelector(' + JSON.stringify(fileSelector) + '))'))
  await evaluate('document.querySelector(' + JSON.stringify(fileSelector) + ').click()')
  const editor = await pageFor('min://app/pages/editor/index.html', 'typeof monacoEditor !== "undefined" && Boolean(monacoEditor)')
  assert.equal(await editor.executeJavaScript('monacoEditor.getValue()'), 'original text\n')
  await editor.executeJavaScript('monacoEditor.setValue("new editor text\\n")')
  await waitFor('Editor autosave', () => fs.readFileSync(file, 'utf8') === 'new editor text\n')
  await waitFor('Editor preview pinned after edit', () => evaluate('tabs.get(tabs.getSelected()).preview === false'))

  ui.send('addTerminal')
  const terminal = await pageFor('min://app/pages/terminal/index.html', 'typeof term !== "undefined" && Boolean(term)')
  const terminalTabId = await evaluate('tabs.getSelected()')
  function terminalState () { return evaluate('ipc.invoke("terminal-get-state",' + JSON.stringify(terminalTabId) + ',true)') }
  await waitFor('PTY started', terminalState)
  await terminal.executeJavaScript('term.paste("printf \'MIN_SMOKE_TERMINAL_OK\\\\n\'\\r")')
  await waitFor('PTY output', async () => {
    const state = await terminalState()
    return state && state.tail.includes('MIN_SMOKE_TERMINAL_OK\r\n')
  })
  await terminal.executeJavaScript('term.paste("exit\\r")')
  await waitFor('PTY exit', () => terminal.executeJavaScript('document.getElementById("terminal-exit-message").hidden === false'))
  await terminal.executeJavaScript('document.getElementById("terminal-restart-button").click()')
  await waitFor('PTY restarted', async () => {
    const state = await terminalState()
    return state && !state.tail.includes('MIN_SMOKE_TERMINAL_OK')
  })
  assert.equal(await terminal.executeJavaScript('document.getElementById("terminal-exit-message").hidden'), true)

  ui.send('addTab', { url: 'min://proSettings' })
  const settings = await pageFor('min://app/pages/proSettings/index.html', 'document.readyState === "complete" && typeof openAddDialog === "function"')
  await settings.executeJavaScript('document.getElementById("provider-add-open").click()')
  await waitFor('Settings provider selector', () => settings.executeJavaScript('document.getElementById("provider-add-select").options.length > 0'))
  await settings.executeJavaScript('document.getElementById("provider-add-cancel").click()')
  return ['Docs autosave', 'Notes autosave', 'Editor autosave and pinning', 'Terminal start/exit/restart', 'Settings initialization']
}
