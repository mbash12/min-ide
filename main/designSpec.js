/* Design spec store: the list of Figma objects (pages / components) the user
plans to build in this workspace. Each entry carries named variants (desktop,
mobile, or any custom state) pinned to a Figma node id and a target viewport.

Persisted in the KV store scoped by workspace path — nothing extra shows up
in the file tree. Consumed by the Design sidebar and the figma agent tool. */
/* global ipc, kvGet, kvSet */

var DESIGN_SPEC_SCOPE = 'design_spec'

var DESIGN_VIEWPORT_PRESETS = {
  desktop: { w: 1440, h: 900, mobile: false, dpr: 1 },
  mobile: { w: 414, h: 896, mobile: true, dpr: 2 }
}

function designSpecKey (workspacePath) {
  return workspacePath || 'default'
}

function designSpecId (prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function designSpecDoc (workspacePath) {
  var doc = kvGet(DESIGN_SPEC_SCOPE, designSpecKey(workspacePath))
  if (doc && Array.isArray(doc.entries)) return doc
  return { entries: [] }
}

function designSpecSave (workspacePath, doc) {
  doc.updatedAt = Date.now()
  kvSet(DESIGN_SPEC_SCOPE, designSpecKey(workspacePath), doc)
  return doc
}

function designSpecViewport (input) {
  // Accepts a preset name, a "WxH" string, or { w, h, mobile, dpr }.
  if (typeof input === 'string') {
    var preset = DESIGN_VIEWPORT_PRESETS[input.toLowerCase()]
    if (preset) return { preset: input.toLowerCase(), w: preset.w, h: preset.h, mobile: preset.mobile, dpr: preset.dpr }
    var match = input.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i)
    if (match) {
      return { w: parseInt(match[1], 10), h: parseInt(match[2], 10), mobile: false, dpr: 1 }
    }
    return null
  }
  if (input && typeof input === 'object') {
    var w = parseInt(input.w || input.width, 10)
    var h = parseInt(input.h || input.height, 10)
    if (w > 0 && h > 0) {
      return {
        w: Math.min(w, 10000),
        h: Math.min(h, 10000),
        mobile: !!input.mobile,
        dpr: Math.min(Math.max(parseFloat(input.dpr) || 1, 1), 4)
      }
    }
  }
  return null
}

function designSpecFindEntry (doc, entryId) {
  return doc.entries.find(function (entry) { return entry.id === entryId }) || null
}

function designSpecFindVariant (entry, variantId) {
  return (entry.variants || []).find(function (variant) { return variant.id === variantId }) || null
}

function designSpecDefaultVariants (nodeId) {
  return [
    { id: designSpecId('v'), label: 'Desktop', nodeId: nodeId || null, viewport: designSpecViewport('desktop'), image: null },
    { id: designSpecId('v'), label: 'Mobile', nodeId: nodeId || null, viewport: designSpecViewport('mobile'), image: null }
  ]
}

function designSpecList (workspacePath) {
  return { ok: true, doc: designSpecDoc(workspacePath) }
}

function designSpecAdd (workspacePath, input) {
  var doc = designSpecDoc(workspacePath)
  var entry = {
    id: designSpecId('e'),
    name: String((input && input.name) || '').trim() || 'Untitled',
    kind: input && input.kind === 'component' ? 'component' : input && input.kind === 'element' ? 'element' : 'page',
    figmaUrl: input && input.figmaUrl ? String(input.figmaUrl) : null,
    fileKey: input && input.fileKey ? String(input.fileKey) : null,
    nodeId: input && input.nodeId ? String(input.nodeId) : null,
    status: 'todo',
    createdAt: Date.now(),
    variants: designSpecDefaultVariants(input && input.nodeId)
  }
  doc.entries.push(entry)
  designSpecSave(workspacePath, doc)
  return { ok: true, entry: entry }
}

function designSpecUpdate (workspacePath, entryId, patch) {
  var doc = designSpecDoc(workspacePath)
  var entry = designSpecFindEntry(doc, entryId)
  if (!entry) return { ok: false, error: 'Entry not found' }
  patch = patch || {}
  if (typeof patch.name === 'string' && patch.name.trim()) entry.name = patch.name.trim()
  if (patch.kind === 'page' || patch.kind === 'component' || patch.kind === 'element') entry.kind = patch.kind
  if (patch.status === 'todo' || patch.status === 'doing' || patch.status === 'done') entry.status = patch.status
  if (typeof patch.nodeId === 'string') entry.nodeId = patch.nodeId
  if (typeof patch.figmaUrl === 'string') entry.figmaUrl = patch.figmaUrl
  designSpecSave(workspacePath, doc)
  return { ok: true, entry: entry }
}

function designSpecRemove (workspacePath, entryId) {
  var doc = designSpecDoc(workspacePath)
  var before = doc.entries.length
  doc.entries = doc.entries.filter(function (entry) { return entry.id !== entryId })
  if (doc.entries.length === before) return { ok: false, error: 'Entry not found' }
  designSpecSave(workspacePath, doc)
  return { ok: true }
}

function designSpecVariantAdd (workspacePath, entryId, input) {
  var doc = designSpecDoc(workspacePath)
  var entry = designSpecFindEntry(doc, entryId)
  if (!entry) return { ok: false, error: 'Entry not found' }
  var viewport = designSpecViewport(input && input.viewport)
  if (!viewport) viewport = designSpecViewport('desktop')
  var variant = {
    id: designSpecId('v'),
    label: String((input && input.label) || '').trim() || 'Variant',
    nodeId: input && input.nodeId ? String(input.nodeId) : entry.nodeId,
    viewport: viewport,
    image: null
  }
  entry.variants.push(variant)
  designSpecSave(workspacePath, doc)
  if (variant.nodeId) designSpecFetchVariantDims(workspacePath, entryId, variant.id)
  return { ok: true, variant: variant }
}

function designSpecVariantUpdate (workspacePath, entryId, variantId, patch) {
  var doc = designSpecDoc(workspacePath)
  var entry = designSpecFindEntry(doc, entryId)
  var variant = entry && designSpecFindVariant(entry, variantId)
  if (!variant) return { ok: false, error: 'Variant not found' }
  patch = patch || {}
  var nodeChanged = false
  if (typeof patch.label === 'string' && patch.label.trim()) variant.label = patch.label.trim()
  if (typeof patch.nodeId === 'string' && patch.nodeId !== variant.nodeId) {
    variant.nodeId = patch.nodeId
    nodeChanged = true
    // A different node renders differently — the cached export is stale.
    variant.image = null
    variant.imageUpdatedAt = null
    variant.cssWidth = null
  }
  if (patch.viewport != null) {
    var viewport = designSpecViewport(patch.viewport)
    if (viewport) variant.viewport = viewport
  }
  if (patch.image !== undefined) variant.image = patch.image
  if (patch.image !== undefined) variant.imageUpdatedAt = patch.image ? Date.now() : null
  if (typeof patch.cssWidth === 'number' && patch.cssWidth > 0) variant.cssWidth = Math.round(patch.cssWidth)
  designSpecSave(workspacePath, doc)
  if (nodeChanged) designSpecFetchVariantDims(workspacePath, entryId, variantId)
  return { ok: true, variant: variant }
}

/* When a variant gets a node id, pin its viewport to the frame's real size —
frame heights differ per node and presets are only guesses. Runs in the
background; failures are ignored (dims sync again on export). */
function designSpecFetchVariantDims (workspacePath, entryId, variantId) {
  try {
    var bridge = global.minFigmaBridge
    var engineApi = global.minFigmaEngine
    if (!bridge || !bridge.command || !engineApi || !engineApi.status) return
    var engine = engineApi.status()
    if (!engine || !engine.bridge || !engine.bridge.pluginConnected) return
    var doc = designSpecDoc(workspacePath)
    var entry = designSpecFindEntry(doc, entryId)
    var variant = entry && designSpecFindVariant(entry, variantId)
    if (!variant || !variant.nodeId) return
    var fileKey = entry.fileKey || (engine.context && engine.context.fileKey)
    bridge.command('node-info', { nodeId: variant.nodeId, fileKey: fileKey }).then(function (result) {
      var payload = result && result.payload
      if (!result || result.ok === false || !payload || !payload.width || !payload.height) return
      var latest = designSpecDoc(workspacePath)
      var e2 = designSpecFindEntry(latest, entryId)
      var v2 = e2 && designSpecFindVariant(e2, variantId)
      if (!v2 || v2.nodeId !== variant.nodeId) return
      var w = Math.round(payload.width)
      var h = Math.round(payload.height)
      var vp = v2.viewport || {}
      if (vp.w === w && vp.h === h) return
      v2.viewport = { w: w, h: h, mobile: !!vp.mobile, dpr: vp.dpr }
      designSpecSave(workspacePath, latest)
    }).catch(function () {})
  } catch (e) { /* dims fetch is best-effort */ }
}

function designSpecVariantRemove (workspacePath, entryId, variantId) {
  var doc = designSpecDoc(workspacePath)
  var entry = designSpecFindEntry(doc, entryId)
  if (!entry) return { ok: false, error: 'Entry not found' }
  var before = entry.variants.length
  entry.variants = entry.variants.filter(function (variant) { return variant.id !== variantId })
  if (entry.variants.length === before) return { ok: false, error: 'Variant not found' }
  designSpecSave(workspacePath, doc)
  return { ok: true }
}

ipc.handle('designSpec:list', function (e, opts) {
  return designSpecList(opts && opts.workspacePath)
})
ipc.handle('designSpec:add', function (e, opts) {
  return designSpecAdd(opts && opts.workspacePath, opts || {})
})
ipc.handle('designSpec:update', function (e, opts) {
  return designSpecUpdate(opts && opts.workspacePath, opts && opts.entryId, opts && opts.patch)
})
ipc.handle('designSpec:remove', function (e, opts) {
  return designSpecRemove(opts && opts.workspacePath, opts && opts.entryId)
})
ipc.handle('designSpec:variantAdd', function (e, opts) {
  return designSpecVariantAdd(opts && opts.workspacePath, opts && opts.entryId, opts || {})
})
ipc.handle('designSpec:variantUpdate', function (e, opts) {
  return designSpecVariantUpdate(opts && opts.workspacePath, opts && opts.entryId, opts && opts.variantId, opts && opts.patch)
})
ipc.handle('designSpec:variantRemove', function (e, opts) {
  return designSpecVariantRemove(opts && opts.workspacePath, opts && opts.entryId, opts && opts.variantId)
})

var minDesignSpec = {
  list: designSpecList,
  add: designSpecAdd,
  update: designSpecUpdate,
  remove: designSpecRemove,
  variantAdd: designSpecVariantAdd,
  variantUpdate: designSpecVariantUpdate,
  variantRemove: designSpecVariantRemove,
  doc: designSpecDoc,
  viewport: designSpecViewport
}
global.minDesignSpec = minDesignSpec
