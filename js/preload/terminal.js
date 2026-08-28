/* IPC bridge for the min://terminal page: relays pty data between the page
and the main process (the page itself is sandboxed and has no node access) */

ipc.on('terminal-data', function (e, data) {
  window.postMessage({ message: 'terminal-data', data: data }, window.location.toString())
})

ipc.on('terminal-exit', function () {
  window.postMessage({ message: 'terminal-exit' }, window.location.toString())
})

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data && e.data.message === 'terminal-create') {
    ipc.send('terminal-create', { cwd: e.data.cwd, cols: e.data.cols, rows: e.data.rows })
  }

  if (e.data && e.data.message === 'terminal-write') {
    ipc.send('terminal-write', { data: e.data.data })
  }

  if (e.data && e.data.message === 'terminal-resize') {
    ipc.send('terminal-resize', { cols: e.data.cols, rows: e.data.rows })
  }

  if (e.data && e.data.message === 'terminal-destroy') {
    ipc.send('terminal-destroy')
  }
})
