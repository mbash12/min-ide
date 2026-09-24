const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'min-custom-smoke-'))
const child = spawn(require('electron'), [path.join(__dirname, 'customModsSmoke.test.js'), '--min-smoke-dir=' + scratch].concat(process.argv.slice(2)), { stdio: 'inherit' })
function cleanup () {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1 })
child.once('exit', code => { cleanup(); process.exitCode = code == null ? 1 : code })
