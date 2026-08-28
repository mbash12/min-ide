/* terminal page: renders a shell in xterm.js and talks to the preload bridge
via postMessage (the page is sandboxed and has no node access) */

const container = document.getElementById('terminal-container')
const exitMessage = document.getElementById('terminal-exit-message')
const restartButton = document.getElementById('terminal-restart-button')

function getCwd () {
  try {
    return new URLSearchParams(window.location.search).get('cwd') || '~'
  } catch (e) {
    return '~'
  }
}

const term = new Terminal({
  fontFamily: '"SF Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  /* match the page background so the container padding blends in */
  theme: {
    background: '#1e1e1e',
    foreground: '#cccccc'
  }
})

const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(container)

function fitTerminal () {
  try {
    fitAddon.fit()
    window.postMessage({
      message: 'terminal-resize',
      cols: term.cols,
      rows: term.rows
    }, window.location.toString())
  } catch (e) {}
}

function startTerminal () {
  exitMessage.hidden = true
  window.postMessage({
    message: 'terminal-create',
    cwd: getCwd(),
    cols: term.cols,
    rows: term.rows
  }, window.location.toString())
}

term.onData(function (data) {
  window.postMessage({ message: 'terminal-write', data: data }, window.location.toString())
})

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data && e.data.message === 'terminal-data') {
    term.write(e.data.data)
  }

  if (e.data && e.data.message === 'terminal-exit') {
    exitMessage.hidden = false
  }
})

restartButton.addEventListener('click', function () {
  term.reset()
  startTerminal()
})

window.addEventListener('resize', function () {
  fitTerminal()
})

/* wait for layout so the first fit measures the real container size */
requestAnimationFrame(function () {
  fitTerminal()
  startTerminal()
  term.focus()
})
