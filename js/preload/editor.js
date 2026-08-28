/* IPC bridge for the min://editor page: relays file reads/writes between
the page and the main process (the page itself is sandboxed and has no node
access). Requests carry a request id so replies can be matched. */

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  const data = e.data
  if (!data || !data.message || !data.message.startsWith('editor-')) {
    return
  }

  const requestId = data.requestId

  if (data.message === 'editor-dirty') {
    ipc.send('editorBecomeDirty', data.dirty !== false)
    return
  }

  if (data.message === 'editor-read' || data.message === 'editor-read-image') {
    const channel = data.message === 'editor-read-image' ? 'editorReadImage' : 'editorReadFile'
    ipc.invoke(channel, data.path).then(function (result) {
      window.postMessage({
        message: 'editor-result',
        requestId: requestId,
        originalMessage: data.message,
        result: result
      }, window.location.toString())
    })
  } else if (data.message === 'editor-write') {
    ipc.invoke('editorWriteFile', data.path, data.content).then(function (error) {
      window.postMessage({
        message: 'editor-result',
        requestId: requestId,
        originalMessage: data.message,
        result: error
      }, window.location.toString())
    })
  } else if (data.message === 'editor-stat') {
    ipc.invoke('editorStatFile', data.path).then(function (result) {
      window.postMessage({
        message: 'editor-result',
        requestId: requestId,
        originalMessage: data.message,
        result: result
      }, window.location.toString())
    })
  }
})
