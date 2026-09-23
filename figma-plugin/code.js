/* Min Figma Bridge. Runs headless inside figma-linux-next (embedded engine or
 * the installed app — same runtime) — Min drives export / text / style over
 * localhost, never the rate-limited REST API.
 *
 * figma-linux-next can provide only partial UI support depending on how it
 * is launched, so the console (Plugins → Development → Show/Hide console) is
 * also a supported status surface. Every UI call below is guarded: a runtime
 * without UI support must never be able to kill the link. */

const PLUGIN_VERSION = '5'
// NOTE: raw IP (127.0.0.1) makes the wasm sandbox's URL parser throw
// "must be valid url" — keep the hostname form.
const BRIDGE_HTTP = 'http://localhost:44178'
const BRIDGE_TOKEN = 'min-figma-bridge-local'
const MAX_SELECTION = 5
const MAX_TEXT_NODES = 50
const MAX_TEXT_SEARCH_NODES = 5000

// Identifies this plugin incarnation; the bridge uses it to drop commands
// left over from a previous (reloaded) instance instead of letting them hang.
const BOOT_ID =
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

function bridgeHeaders(extra) {
  return Object.assign({
    'X-Min-Figma-Bridge': BRIDGE_TOKEN,
    'X-Min-Figma-Boot': BOOT_ID,
  }, extra || {})
}

function log() {
  const args = ['[min-bridge]']
  for (let i = 0; i < arguments.length; i++) args.push(arguments[i])
  console.log.apply(console, args)
}

let pluginUi = null
try {
  if (typeof figma.showUI === 'function') {
    // Tiny visible status window — the only reliable status surface when the
    // console is closed. Guarded so UI-less runtimes can never kill the link.
    figma.showUI(__html__, { width: 240, height: 84, themeColors: true })
    pluginUi = figma.ui || null
  }
} catch (e) {
  log('no plugin UI on this runtime — console only (' + (e && e.message) + ')')
}

function transport() {
  return wsOpen ? 'ws' : pollAlive ? 'poll' : 'none'
}

function postStatus(state, detail) {
  if (detail) log(state + ': ' + detail)
  else log(state)
  if (!pluginUi) return
  try {
    pluginUi.postMessage({ type: 'status', state, detail })
  } catch (e) {
    /* UI vanished mid-run — link does not care */
  }
}

// --- serialization ---------------------------------------------------------

function hex2(n) {
  return n.toString(16).padStart(2, '0')
}

function rgba(paintColor, opacity) {
  const r = Math.round(paintColor.r * 255)
  const g = Math.round(paintColor.g * 255)
  const b = Math.round(paintColor.b * 255)
  const a = opacity != null ? opacity : paintColor.a != null ? paintColor.a : 1
  if (a >= 0.999) return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}

function paintToCss(paint) {
  if (!paint || paint.visible === false) return null
  if (paint.type === 'SOLID') return rgba(paint.color, paint.opacity)
  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    const stops = (paint.gradientStops || [])
      .map((s) => `${rgba(s.color)} ${Math.round(s.position * 100)}%`)
      .join(', ')
    const kind = paint.type === 'GRADIENT_LINEAR' ? 'linear-gradient' : 'radial-gradient'
    return `${kind}(${stops})`
  }
  if (paint.type === 'IMAGE') return 'image-fill'
  return null
}

function firstPaint(fills) {
  if (!Array.isArray(fills)) return null
  for (const f of fills) {
    const css = paintToCss(f)
    if (css) return css
  }
  return null
}

function lineHeightCss(lh) {
  if (!lh || lh === figma.mixed || lh.unit === 'AUTO') return 'normal'
  if (lh.unit === 'PIXELS') return `${Math.round(lh.value * 100) / 100}px`
  if (typeof lh.value !== 'number') return 'normal'
  return `${Math.round(lh.value) / 100}`
}

function letterSpacingCss(ls) {
  if (!ls || ls === figma.mixed || typeof ls.value !== 'number' || !ls.value) {
    return null
  }
  if (ls.unit === 'PIXELS') return `${Math.round(ls.value * 100) / 100}px`
  return `${Math.round(ls.value * 10) / 1000}em`
}

function weightFromStyle(style) {
  const s = (style || '').toLowerCase()
  if (s.includes('thin')) return 100
  if (s.includes('extra light') || s.includes('ultra light')) return 200
  if (s.includes('light')) return 300
  if (s.includes('medium')) return 500
  if (s.includes('semi')) return 600
  if (s.includes('extra bold') || s.includes('ultra bold')) return 800
  if (s.includes('bold')) return 700
  if (s.includes('black') || s.includes('heavy')) return 900
  return 400
}

function cssForNode(node) {
  const lines = []
  const box = node.absoluteBoundingBox
  const w = box ? box.width : node.width
  const h = box ? box.height : node.height
  if (typeof w === 'number') lines.push(`width: ${Math.round(w * 100) / 100}px;`)
  if (typeof h === 'number') lines.push(`height: ${Math.round(h * 100) / 100}px;`)

  if (node.type === 'TEXT') {
    const font = node.fontName
    if (font && font !== figma.mixed) {
      lines.push(`font-family: '${font.family}';`)
      lines.push(`font-weight: ${weightFromStyle(font.style)};`)
      lines.push(`font-style: ${/italic/i.test(font.style) ? 'italic' : 'normal'};`)
    }
    if (typeof node.fontSize === 'number') lines.push(`font-size: ${node.fontSize}px;`)
    lines.push(`line-height: ${lineHeightCss(node.lineHeight)};`)
    const ls = letterSpacingCss(node.letterSpacing)
    if (ls) lines.push(`letter-spacing: ${ls};`)
    if (node.textAlignHorizontal)
      lines.push(`text-align: ${String(node.textAlignHorizontal).toLowerCase()};`)
    const color = 'fills' in node ? firstPaint(node.fills) : null
    if (color) lines.push(`color: ${color};`)
  } else if ('fills' in node) {
    const bg = firstPaint(node.fills)
    if (bg) lines.push(`background: ${bg};`)
  }

  // Several mixins don't exist on every node type — reading them throws
  // ("no such property"), so gate each on presence before touching it.
  if ('strokes' in node && node.strokes && node.strokes.length) {
    const stroke = firstPaint(node.strokes)
    const weight = node.strokeWeight
    if (stroke && typeof weight === 'number' && weight > 0) {
      lines.push(`border: ${weight}px solid ${stroke};`)
    }
  }
  if ('cornerRadius' in node) {
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      lines.push(`border-radius: ${node.cornerRadius}px;`)
    } else if (node.cornerRadius === figma.mixed && 'rectangleCornerRadii' in node) {
      lines.push(`border-radius: ${node.rectangleCornerRadii.join('px ')}px;`)
    }
  }
  if (
    'layoutMode' in node &&
    (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL')
  ) {
    lines.push('display: flex;')
    lines.push(
      `flex-direction: ${node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'};`,
    )
    if (typeof node.itemSpacing === 'number' && node.itemSpacing > 0) {
      lines.push(`gap: ${node.itemSpacing}px;`)
    }
    const p = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    if (p.every((v) => typeof v === 'number') && p.some((v) => v > 0)) {
      lines.push(`padding: ${p.join('px ')}px;`)
    }
  }
  if (typeof node.opacity === 'number' && node.opacity < 1) {
    lines.push(`opacity: ${Math.round(node.opacity * 1000) / 1000};`)
  }
  return `/* ${node.name} · ${node.type} */\n${lines.join('\n')}`
}

function walkText(node, out, depth) {
  if (out.length >= MAX_TEXT_NODES) return
  if (node.type === 'TEXT') {
    out.push({ node, depth })
    return
  }
  // Leaf nodes (RECTANGLE, ELLIPSE, …) throw on .children — gate on presence.
  if ('children' in node) {
    for (const child of node.children) walkText(child, out, depth + 1)
  }
}

function fontsForNode(node) {
  const texts = []
  walkText(node, texts, 0)
  return {
    nodeId: node.id,
    name: node.name,
    texts: texts.map(({ node: t }) => {
      const font = t.fontName && t.fontName !== figma.mixed ? t.fontName : null
      return {
        id: t.id,
        name: t.name,
        characters: t.characters,
        style: {
          fontFamily: font ? font.family : null,
          fontStyle: font ? font.style : null,
          fontWeight: weightFromStyle(font ? font.style : ''),
          fontSize: typeof t.fontSize === 'number' ? t.fontSize : null,
          lineHeight: lineHeightCss(t.lineHeight),
          letterSpacing: letterSpacingCss(t.letterSpacing),
          textAlign: t.textAlignHorizontal
            ? String(t.textAlignHorizontal).toLowerCase()
            : null,
          color: firstPaint(t.fills),
        },
      }
    }),
  }
}

function textStyleForNode(t) {
  const font = t.fontName && t.fontName !== figma.mixed ? t.fontName : null
  return {
    fontFamily: font ? font.family : null,
    fontStyle: font ? font.style : null,
    fontWeight: weightFromStyle(font ? font.style : ''),
    fontSize: typeof t.fontSize === 'number' ? t.fontSize : null,
    lineHeight: lineHeightCss(t.lineHeight),
    letterSpacing: letterSpacingCss(t.letterSpacing),
    textAlign: t.textAlignHorizontal
      ? String(t.textAlignHorizontal).toLowerCase()
      : null,
    color: firstPaint(t.fills),
  }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** Search text descendants while retaining their original Figma node data. */
function findTextInNode(root, rawQuery, rawLimit) {
  const query = String(rawQuery || '').trim()
  if (!query) throw new Error('Text search query is required')
  const needle = query.toLocaleLowerCase()
  const limit = Math.max(1, Math.min(50, Number.isInteger(rawLimit) ? rawLimit : 20))
  const rootBox = root.absoluteBoundingBox
  const candidates = []
  let visited = 0
  let scanTruncated = false

  function walk(node, hierarchy) {
    if (visited >= MAX_TEXT_SEARCH_NODES) {
      scanTruncated = true
      return
    }
    visited += 1
    const path = hierarchy.concat(String(node.name || node.type))
    if (node.type === 'TEXT') {
      const characters = String(node.characters || '')
      const content = characters.toLocaleLowerCase()
      const layerName = String(node.name || '').toLocaleLowerCase()
      const contentIndex = content.indexOf(needle)
      const nameIndex = layerName.indexOf(needle)
      if (contentIndex >= 0 || nameIndex >= 0) {
        const box = node.absoluteBoundingBox
        const width = box ? box.width : node.width || 0
        const height = box ? box.height : node.height || 0
        const x = box && rootBox ? box.x - rootBox.x : node.x || 0
        const y = box && rootBox ? box.y - rootBox.y : node.y || 0
        const rank = content === needle ? 0 : contentIndex === 0 ? 1 : contentIndex >= 0 ? 2 : 3
        candidates.push({
          rank,
          id: node.id,
          name: node.name,
          characters,
          path,
          x: round2(x),
          y: round2(y),
          width: round2(width),
          height: round2(height),
          css: cssForNode(node),
          style: textStyleForNode(node),
        })
      }
      return
    }
    if ('children' in node) {
      for (const child of node.children) {
        walk(child, path)
        if (scanTruncated) break
      }
    }
  }

  walk(root, [])
  candidates.sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x)
  return {
    frameId: root.id,
    frameName: root.name,
    query,
    total: candidates.length,
    truncated: scanTruncated || candidates.length > limit,
    matches: candidates.slice(0, limit).map(({ rank, ...match }) => match),
  }
}

function textForNode(node) {
  const texts = []
  walkText(node, texts, 0)
  if (!texts.length) return `(no text under ${node.name})`
  return texts
    .map(({ node: t, depth }) => {
      const indent = '  '.repeat(Math.min(depth, 6))
      // Figma names text layers after their content — "name: characters"
      // would print the same string twice.
      const same = String(t.name).trim() === String(t.characters).trim()
      return `${indent}${same ? t.characters : `${t.name}: ${t.characters}`}`
    })
    .join('\n')
}

function nodeSize(node) {
  const box = node.absoluteBoundingBox
  return {
    width: Math.round((box ? box.width : node.width) || 0),
    height: Math.round((box ? box.height : node.height) || 0),
  }
}

function buildNodeData(node) {
  const { width, height } = nodeSize(node)
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width,
    height,
    css: cssForNode(node),
    fontJson: JSON.stringify(fontsForNode(node), null, 2),
    textExtract: textForNode(node),
  }
}

function pageOf(node) {
  let p = node
  while (p && p.type && p.type !== 'PAGE') p = p.parent
  return p && p.type === 'PAGE' ? p : null
}

async function switchToPage(page) {
  if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page)
  else figma.currentPage = page
}

function stage(label, promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`export ${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      ),
    ),
  ])
}

async function getNode(nodeId) {
  try {
    await figma.currentPage.loadAsync()
  } catch (e) {
    /* page already loaded */
  }
  if (!nodeId) {
    const selected = figma.currentPage.selection[0]
    if (selected) return selected
    throw new Error('No node id and nothing selected in Figma')
  }
  let node = await figma.getNodeByIdAsync(nodeId)
  if (!node) {
    // Desktop and mobile frames may live on different pages. In dynamic-page
    // mode only loaded pages resolve, so walk the file's pages explicitly.
    for (const page of figma.root.children) {
      if (page.id === figma.currentPage.id) continue
      try {
        await page.loadAsync()
      } catch (e) {
        continue
      }
      node = await figma.getNodeByIdAsync(nodeId)
      if (node) break
    }
  }
  if (!node) {
    throw new Error(`Node ${nodeId} was not found in this file`)
  }
  return node
}

// --- bridge push: selection -------------------------------------------------

function currentState() {
  return wsOpen || pollAlive ? 'connected' : 'reconnecting'
}

async function sendSelection() {
  let selection
  let truncated = false
  try {
    await figma.currentPage.loadAsync()
    truncated = figma.currentPage.selection.length > MAX_SELECTION
    selection = figma.currentPage.selection.slice(0, MAX_SELECTION)
  } catch (e) {
    return false
  }
  let nodes
  try {
    nodes = selection.map(buildNodeData)
  } catch (e) {
    // Serialize bugs are not network issues — surface them in the status UI.
    postStatus(currentState(), `✗ serialize: ${e && e.message ? e.message : e}`)
    return false
  }
  try {
    const response = await fetchBridgeWithTimeout(`${BRIDGE_HTTP}/selection`, {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        fileName: figma.root.name,
        fileKey: pluginFileKey(),
        transport: transport(),
        nodes,
      }),
    })
    // A non-success response means UIX was unavailable or rejected malformed
    // data. Keep the next selection change eligible for a retry.
    if (!response.ok) return false
    if (truncated) {
      postStatus(currentState(), `selection capped at ${MAX_SELECTION} nodes`)
    }
    return true
  } catch (e) {
    /* UIX not running — selection is re-pushed on the next change */
    return false
  }
}

let selectionTimer = null
figma.on('selectionchange', () => {
  // Drag-lassoing or shift-clicking fires many events — collapse them.
  if (selectionTimer) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    selectionTimer = null
    void sendSelection()
  }, 200)
})

// --- commands from UIX ------------------------------------------------------

async function runBridgeCommand(cmd, viaWs) {
  const commandIdentity = () => ({
    protocolVersion: cmd.protocolVersion,
    jobId: cmd.jobId,
    runId: cmd.runId,
    projectId: cmd.projectId,
    pageId: cmd.pageId,
    fileKey: cmd.fileKey,
    nodeId: cmd.nodeId,
    sourceRevision: cmd.sourceRevision,
    slot: cmd.slot,
    exportTarget: cmd.exportTarget,
  })
  const reply = (ok, payload, error) => {
    const msg = { type: 'result', ...commandIdentity(), id: cmd.id, ok, payload, error, transport: transport() }
    let sent = false
    if (viaWs && wsOpen && pluginUi) {
      try {
        // WebSocket lives in the plugin UI iframe, where the browser socket
        // API is reliable across Figma desktop runtimes (including Linux).
        pluginUi.postMessage({ type: 'ws-send', payload: msg })
        sent = true
      } catch (e) {
        /* socket dropped mid-command — fall through to HTTP */
      }
    }
    if (!sent) {
      void fetchBridgeWithTimeout(`${BRIDGE_HTTP}/command/result`, {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(msg),
      }).catch(() => {
        postStatus(currentState(), '✗ result not delivered to Min')
      })
    }
    postStatus(
      currentState(),
      ok ? `✓ ${typeof payload === 'string' ? payload : cmd.action}` : `✗ ${error}`,
    )
  }
  postStatus(currentState(), `→ ${cmd.action}${cmd.nodeId ? ` ${cmd.nodeId}` : ''}…`)
  // Exports legitimately take longer (page switch + render + upload) — give
  // them room while keeping a hard cap so the chain always advances.
  const limitMs = cmd.action === 'export' ? 115000 : 50000
  try {
    // A hung Figma API call (exportAsync on a huge node, a wedged page load)
    // would otherwise stall the serialized command chain forever — every
    // later command then dies on the bridge's 60s timeout. Race the dispatch
    // so the chain always advances and the caller gets a real error.
    await Promise.race([
      dispatchBridgeCommand(cmd, reply),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`"${cmd.action}" exceeded ${Math.round(limitMs / 1000)}s inside the plugin — the node may be too large or the file is busy`)),
          limitMs,
        ),
      ),
    ])
  } catch (e) {
    reply(false, null, e && e.message ? e.message : String(e))
  }
}

async function dispatchBridgeCommand(cmd, reply) {
  try {
    if (cmd.action === 'rescan') {
      const pushed = await sendSelection()
      if (pushed) reply(true, { rescanned: true })
      else reply(false, null, 'Selection push failed — is Min running?')
      return
    }
    if (cmd.action === 'node-data') {
      const node = await getNode(cmd.nodeId)
      reply(true, buildNodeData(node))
      return
    }
    if (cmd.action === 'node-info') {
      // Lightweight identity + size — used to pin variant dims on assign,
      // without pulling full css/fonts/text like node-data does.
      const node = await getNode(cmd.nodeId)
      const { width, height } = nodeSize(node)
      reply(true, { id: node.id, name: node.name, type: node.type, width, height })
      return
    }
    if (cmd.action === 'find-text') {
      const node = await getNode(cmd.nodeId)
      reply(true, findTextInNode(node, cmd.query, cmd.limit))
      return
    }
    if (cmd.action === 'list-frames') {
      // Top-level objects on the current page — the candidates the Design
      // sidebar offers when building a spec entry.
      await figma.currentPage.loadAsync()
      const frames = figma.currentPage.children
        .filter((n) => ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'].includes(n.type))
        .map((n) => ({ id: n.id, name: n.name, type: n.type, ...nodeSize(n) }))
      reply(true, {
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        frames,
      })
      return
    }
    if (cmd.action === 'export') {
      const node = await stage('node lookup', getNode(cmd.nodeId), 20000)
      if (typeof node.exportAsync !== 'function') {
        throw new Error(`${node.type} nodes cannot be exported`)
      }
      if (node.visible === false) {
        throw new Error(`"${node.name}" is hidden — make it visible to export`)
      }
      // exportAsync wedges on nodes living on a non-current page in some
      // dynamic-page runtimes — switch the view to the node's page first.
      const nodePage = pageOf(node)
      if (nodePage && figma.currentPage && nodePage.id !== figma.currentPage.id) {
        postStatus(currentState(), `→ export: switching to page "${nodePage.name}"…`)
        await stage('page switch', switchToPage(nodePage), 15000)
      }
      const format =
        cmd.format === 'JPG' || cmd.format === 'SVG' || cmd.format === 'PNG'
          ? cmd.format
          : 'PNG'
      const { width, height } = nodeSize(node)
      // Over-limit rasters hang exportAsync instead of erroring on some
      // engines — clamp the scale and report the effective value back.
      const MAX_EXPORT_PX = 16000
      let scale = cmd.scale ?? 2
      if (format !== 'SVG') {
        const maxSide = Math.max(width, height)
        if (maxSide > 0 && maxSide * scale > MAX_EXPORT_PX) {
          scale = Math.max(0.5, Math.floor((MAX_EXPORT_PX / maxSide) * 100) / 100)
          postStatus(currentState(), `→ export: scale clamped to ${scale}× (${width}×${height})`)
        }
      }
      postStatus(currentState(), `→ export: rendering ${Math.round(width * scale)}×${Math.round(height * scale)}…`)
      const bytes = await stage(
        'render',
        node.exportAsync(
          format === 'SVG'
            ? { format: 'SVG' }
            : { format, constraint: { type: 'SCALE', value: scale } },
        ),
        90000,
      )
      if (bytes.byteLength > 40 * 1024 * 1024) {
        throw new Error('Export exceeds 40MB — lower the scale or split the frame')
      }
      postStatus(currentState(), '→ export: uploading…')
      const res = await stage(
        'upload',
        fetchBridgeWithTimeout(`${BRIDGE_HTTP}/export`, {
          method: 'POST',
          headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            id: cmd.id,
            ...commandIdentity(),
            target: cmd.target,
            exportTarget: cmd.exportTarget,
            exportDir: typeof cmd.exportDir === 'string' ? cmd.exportDir : undefined,
            nodeId: cmd.nodeId,
            transport: transport(),
            scale: format === 'SVG' ? 1 : scale,
            format,
            fileName: typeof cmd.fileName === 'string' ? cmd.fileName : undefined,
            node: {
              id: node.id,
              name: node.name,
              type: node.type,
              width: Math.round(width * (format === 'SVG' ? 1 : scale)),
              height: Math.round(height * (format === 'SVG' ? 1 : scale)),
            },
            pngBase64: format === 'PNG' ? figma.base64Encode(bytes) : undefined,
            dataBase64: figma.base64Encode(bytes),
          }),
        }),
        30000,
      )
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok !== false) reply(true, body.message || 'Saved')
      else reply(false, null, body.message || `Export failed (HTTP ${res.status})`)
      return
    }
    reply(false, null, `Unknown action: ${cmd.action}`)
  } catch (e) {
    reply(false, null, e && e.message ? e.message : String(e))
  }
}

// --- link: WebSocket preferred, HTTP polling fallback ------------------------
// The socket is owned by ui.html instead of this Plugin API sandbox. Figma
// Linux exposes a normal browser WebSocket in the UI iframe, while the main
// plugin sandbox may omit or proxy it inconsistently.

let wsOpen = false
let wsFailures = 0
let pollingStarted = false
let pollAlive = false
let commandChain = Promise.resolve()
let lastStatusKey = ''

// figma.fileKey is unavailable in some sandboxes — report null and let Min
// pin the file from the engine's own current-URL status instead.
function pluginFileKey() {
  return typeof figma.fileKey === 'string' && figma.fileKey ? figma.fileKey : null
}

function showTransport() {
  const state = wsOpen || pollAlive ? 'connected' : 'reconnecting'
  const detail = wsOpen
    ? 'WebSocket'
    : pollAlive
      ? 'HTTP poll'
      : pollError || 'waiting for Min…'
  const key = `${state}|${detail}`
  if (key === lastStatusKey) return
  lastStatusKey = key
  postStatus(state, detail)
}

function enqueueCommand(cmd, viaWs) {
  // Serialize commands — exports can be slow and must not overlap.
  commandChain = commandChain
    .then(() => runBridgeCommand(cmd, viaWs))
    .catch(() => {})
}

if (pluginUi) pluginUi.onmessage = (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ws-identify-query') {
    try {
      pluginUi.postMessage({
        type: 'ws-identify',
        fileKey: pluginFileKey(),
      })
    } catch (e) {}
    return
  }
  if (message.type === 'ws-state' && message.state === 'open') {
    wsOpen = true
    wsFailures = 0
    showTransport()
    void sendSelection()
    return
  }
  if (message.type === 'ws-state' && message.state === 'closed') {
    const wasOpen = wsOpen
    wsOpen = false
    wsFailures += 1
    if (wsFailures >= 3) startPolling()
    if (wasOpen || wsFailures >= 3) showTransport()
    return
  }
  if (message.type === 'ws-command' && message.command) {
    enqueueCommand(message.command, true)
  }
}

const POLL_MIN_MS = 500
const POLL_MAX_MS = 5000
const POLL_TIMEOUT_MS = 8000
let pollDelay = POLL_MIN_MS
let pollError = null
let lastPollError = null

function fetchBridgeWithTimeout(url, options) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error('bridge request timed out after ' + POLL_TIMEOUT_MS + 'ms'))
    }, POLL_TIMEOUT_MS)
    let request
    try {
      // Do not pass AbortController.signal here. The Figma Plugin API
      // sandbox has shipped partial AbortController implementations that
      // throw before a request is sent. A guarded race is sufficient.
      request = fetch(url, options)
    } catch (e) {
      clearTimeout(timer)
      reject(e)
      return
    }
    request.then((response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }).catch((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

function startPolling() {
  if (pollingStarted) return
  pollingStarted = true
  const tick = async () => {
    // While the WebSocket is open it carries everything — pause polling
    // (the loop keeps running so we resume seamlessly if the socket dies).
    if (!wsOpen) {
      const wasAlive = pollAlive
      try {
        // A hung fetch must never freeze the loop.
        const res = await fetchBridgeWithTimeout(
          `${BRIDGE_HTTP}/command/poll?fileKey=${encodeURIComponent(pluginFileKey() || '')}&transport=${transport()}`,
          { headers: bridgeHeaders() },
        )
        const body = await res.json().catch(() => ({}))
        pollAlive = res.ok
        if (pollAlive) {
          pollDelay = POLL_MIN_MS
          if (body && body.command) enqueueCommand(body.command, false)
          if (!wasAlive) {
            // Bridge (re)appeared — its in-memory selection is gone, resend.
            log('bridge reachable — resending selection')
            void sendSelection()
          }
        }
      } catch (e) {
        pollAlive = false
        pollError = e && e.message ? e.message : String(e)
      }
      if (!pollAlive) {
        pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS)
        if (wasAlive) log('bridge unreachable — retrying with backoff')
        else if (pollError !== lastPollError) log('poll failed:', pollError)
        lastPollError = pollError
      }
      showTransport()
    }
    setTimeout(tick, pollDelay)
  }
  void tick()
}

// Recover the state if the iframe connected before the main sandbox installed
// its message handler.
if (pluginUi) {
  try {
    pluginUi.postMessage({ type: 'ws-identify', fileKey: pluginFileKey() })
    pluginUi.postMessage({ type: 'ws-query' })
  } catch (e) {}
}
log(
  'boot v' + PLUGIN_VERSION,
  'id=' + BOOT_ID,
  'bridge=' + BRIDGE_HTTP,
  'fileKey=' + (pluginFileKey() || '(sandbox does not expose it)'),
)
startPolling()
postStatus('connecting')
void sendSelection()
