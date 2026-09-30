/* Standalone harness for the Min Figma bridge: loads the REAL
 * main/figmaBridge.js with stubbed Min globals so the plugin can be matured
 * against the installed Figma app — no Min, no embedded engine.
 *
 *   node scripts/figmaBridgeHarness.js
 *
 * The bridge only talks to a plugin that carries its token, so the harness
 * writes a token-filled copy of figma-plugin/ and prints its path. In Figma use
 * Plugins → Development → Import plugin from manifest… on <that dir>/manifest.json,
 * run "Min Figma Bridge", and watch with the curl line it prints.
 * MIN_FIGMA_BRIDGE_TOKEN pins the token so the imported copy survives restarts.
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
  const pluginDir = bridge.preparePlugin(path.join(os.tmpdir(), 'min-figma-harness', 'plugin'))
  console.log(`[harness] plugin (token filled in): ${path.join(pluginDir, 'manifest.json')}`)
  console.log(`[harness] status: curl -s -H "x-min-figma-bridge: ${bridge.token}" http://127.0.0.1:${bridge.port}/status`)

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
