/* Standalone harness for the Min Figma bridge: loads the REAL
 * main/figmaBridge.js with stubbed Min globals so the plugin can be matured
 * against the installed Figma app — no Min, no embedded engine.
 *
 *   node scripts/figmaBridgeHarness.js
 *
 * Then run "Min Figma Bridge" from Plugins → Development in Figma and watch:
 *   curl -s 'http://127.0.0.1:44178/status?token=min-figma-bridge-local'
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const pendingHandlers = {}

global.fs = fs
global.path = path
global.ipc = {
  handle: (channel, fn) => {
    pendingHandlers[channel] = fn
  }
}
global.app = {
  getPath: () => path.join(os.tmpdir(), 'min-figma-harness'),
  on: () => {}
}
global.windows = { getCurrent: () => null }
global.sendIPCToWindow = () => {}

require('../main/figmaBridge.js')

const bridge = global.minFigmaBridge

async function main () {
  await bridge.start()
  console.log(`[harness] bridge listening on 127.0.0.1:${bridge.port}`)
  console.log('[harness] status: curl -s "http://127.0.0.1:44178/status?token=min-figma-bridge-local"')

  let wasConnected = false
  setInterval(() => {
    const s = bridge.status()
    if (s.pluginConnected !== wasConnected) {
      wasConnected = s.pluginConnected
      console.log(
        `[harness] plugin ${wasConnected ? 'CONNECTED' : 'lost'}` +
          (s.fileKey ? ` file=${s.fileKey}` : '') +
          (s.bootId ? ` boot=${s.bootId}` : '')
      )
    }
    if (s.selection && s.selection.nodes && s.selection.nodes.length && !s.selection._logged) {
      s.selection._logged = true
      console.log(
        `[harness] selection: ${s.selection.nodes.length} node(s) from "${s.selection.fileName}" — ` +
          s.selection.nodes.map((n) => `${n.name} (${n.type})`).join(', ')
      )
    }
  }, 500)

  // Optional manual command: node scripts/figmaBridgeHarness.js rescan
  const action = process.argv[2]
  if (action) {
    try {
      const result = await bridge.command(action, {})
      console.log('[harness] command result:', JSON.stringify(result).slice(0, 400))
    } catch (err) {
      console.error('[harness] command failed:', err.message)
    }
  }
}

main().catch((err) => {
  console.error('[harness]', err)
  process.exit(1)
})
