const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

// Delete the profile after Electron exits: Chromium can write during shutdown,
// and Windows keeps its profile files locked while the process is alive.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'min-visual-test-'))
const child = spawn(require('electron'), [path.join(__dirname, 'browserVisual.test.js'), '--min-visual-test-dir=' + scratch].concat(process.argv.slice(2)), { stdio: 'inherit' })
function cleanup () {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
child.once('error', function (err) {
  console.error(err)
  cleanup()
  process.exitCode = 1
})
child.once('exit', function (code) {
  cleanup()
  process.exitCode = code == null ? 1 : code
})
