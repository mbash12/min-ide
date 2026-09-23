/* Model-facing results are compact; complete evidence stays in files. */
/* global fs, path, app, browserVisualPreview */
/* exported minToolTextResult, minToolJsonResult, minToolVisualResult, minToolBrowserPayload, minToolReportPayload */
function minToolTextResult (text, isError) {
  const value = String(text)
  if (isError) throw new Error(value)
  return { content: [{ type: 'text', text: value }], details: {} }
}

function minToolPick (value, keys) {
  const out = {}
  keys.forEach(function (key) { if (value && value[key] !== undefined) out[key] = value[key] })
  return out
}

function minToolPack (value, options) {
  options = options || {}
  const raw = JSON.stringify(value)
  const budget = options.detail === 'full' ? 30000 : 12000
  if (raw.length <= budget) return { value: value, text: raw }
  let trimmed
  let fields
  function bound (input, location, depth, limit) {
    if (typeof input === 'string' && input.length > limit * 100) {
      fields.push(location)
      return input.slice(0, limit * 100) + '…'
    }
    if (!input || typeof input !== 'object') return input
    if (depth > 6) { fields.push(location); return { omitted: true } }
    if (Array.isArray(input)) {
      if (input.length > limit) fields.push(location)
      return input.slice(0, limit).map(function (item, i) { return bound(item, location + '[' + i + ']', depth + 1, limit) })
    }
    const out = Object.create(null)
    const keys = Object.keys(input)
    if (keys.length > 40) fields.push(location)
    keys.slice(0, 40).forEach(function (key) { out[key] = bound(input[key], location ? location + '.' + key : key, depth + 1, limit) })
    return out
  }
  for (const limit of [20, 8, 3, 1]) {
    fields = []
    trimmed = bound(value, '', 0, limit)
    if (JSON.stringify(trimmed).length <= budget - 1500) break
  }
  if (JSON.stringify(trimmed).length > budget - 1500) {
    trimmed = bound(minToolPick(value, ['ok', 'error', 'condition', 'actual', 'expected', 'matched', 'count', 'runId', 'reportPath', 'summary', 'stoppedAt', 'validationIndex', 'completed', 'tabId']), '', 0, 3)
    fields.push('result')
  }
  if (!trimmed || typeof trimmed !== 'object' || Array.isArray(trimmed)) trimmed = { result: trimmed }
  const output = { truncated: true, omittedFields: fields.slice(0, 20) }
  try {
    const dir = options.cwd ? path.join(options.cwd, '.min', 'agent-results') : path.join(app.getPath('userData'), 'agent-results', String(options.workspaceId || 'default').replace(/[^\w.-]/g, '_'))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, Date.now() + '-' + require('crypto').randomBytes(6).toString('hex') + '.json')
    fs.writeFileSync(file, raw + '\n')
    output.fullResultPath = file
    output.hint = 'Read fullResultPath for exact omitted data, or narrow/paginate the query. Do not infer missing values.'
  } catch (err) {
    output.saveError = err.message
    output.hint = 'Narrow the query or use offset/limit; omitted values are unavailable in this response.'
  }
  trimmed._output = output
  return { value: trimmed, text: JSON.stringify(trimmed) }
}

function minToolJsonResult (value, isError, options) {
  const packed = minToolPack(value == null ? { ok: false, error: 'No tool result' } : value, options)
  if (isError || value == null || value.ok === false) throw new Error(packed.text)
  return { content: [{ type: 'text', text: packed.text }], details: packed.value._output ? { output: packed.value._output } : {} }
}

function minToolVisualResult (value, isError, options) {
  options = options || {}
  if (!value || value.ok === false || isError) return minToolJsonResult(value, true, options)
  let descriptors = value.images || []
  if (!descriptors.length && value.path && /\.(png|jpe?g)$/i.test(value.path)) {
    const rect = value.node && value.scale ? { x: 0, y: 0, width: value.node.width / value.scale, height: value.node.height / value.scale } : null
    descriptors = [{ label: 'image', path: value.path, cssRect: rect }]
  }
  const mode = options.images || 'auto'
  if (!['auto', 'all', 'none'].includes(mode)) throw new Error('images must be auto, all, or none')
  const compared = !!value.diff
  const content = []
  const images = descriptors.map(function (descriptor) {
    const include = mode === 'all' || (mode === 'auto' && (!compared || (value.diff.changedPixels > 0 && descriptor.label === 'diff')))
    if (!include) return Object.assign({}, descriptor, { included: false })
    try {
      const preview = browserVisualPreview(descriptor)
      content.push({ type: 'text', text: descriptor.label }, preview.content)
      return Object.assign({}, preview.info, { included: true })
    } catch (err) { return Object.assign({}, descriptor, { included: false, previewError: err.message }) }
  })
  const payload = Object.assign({}, value, { images: images })
  const packed = minToolPack(payload, options)
  content.unshift({ type: 'text', text: packed.text })
  return { content: content, details: { images: images, output: packed.value._output } }
}

function minToolBrowserPayload (value, params) {
  if (!value) return value
  const full = params.detail === 'full'
  const out = Object.assign({}, value)
  if (params.action === 'batch') {
    out.results = (value.results || []).map(function (result) {
      return minToolBrowserPayload(result, Object.assign({}, params.steps[result.index], { detail: params.detail }))
    })
    if (!full) {
      out.results = out.results.map(function (result) {
        return result.ok && !['find', 'read', 'snapshot', 'inspect', 'compare', 'screenshot', 'diagnostics', 'tabs'].includes(result.action)
          ? minToolPick(result, ['index', 'action', 'ok', 'tabId', 'condition', 'actual', 'expected', 'checked', 'changed', 'assertion']) : result
      })
    }
  }
  if (params.action === 'inspect' && !full) {
    const keys = ['tag', 'id', 'role', 'name', 'selector', 'rect', 'geometryApproximate']
    out.ancestors = (value.ancestors || []).map(function (el) {
      return Object.assign(minToolPick(el, keys), { styles: minToolPick(el.styles, ['display', 'position', 'gap', 'padding-top', 'padding-left', 'flex-direction', 'align-items', 'justify-content', 'grid-template-columns', 'overflow-x', 'overflow-y']) })
    })
    out.children = (value.children || []).map(function (el) { return minToolPick(el, keys) })
    out.detailHint = 'detail=full includes all related styles and text rectangles'
    delete out.textRects
  }
  if (params.action === 'inspect' && params.properties) {
    const keys = params.properties.split(',').map(function (key) { return key.trim() }).filter(Boolean)
    out.styles = minToolPick(value.styles, keys)
  }
  if (params.action === 'find' && !full && value.matches) {
    out.matches = value.matches.map(function (match) {
      return minToolPick(match, ['ref', 'testId', 'role', 'name', 'visible', 'enabled', 'checked', 'value'])
    })
  }
  if (value.diagnostics) out.diagnostics = minToolDiagnosticsPayload(value.diagnostics, params)
  if (params.action === 'diagnostics') return Object.assign({}, out, minToolDiagnosticsPayload(value, params))
  if (params.action === 'assert' && out.ok && params.condition === 'no-errors' && !full) delete out.diagnostics
  return out
}

global.minToolResults = { text: minToolTextResult, json: minToolJsonResult, visual: minToolVisualResult, browser: minToolBrowserPayload, report: minToolReportPayload }

function minToolDiagnosticsPayload (value, params) {
  const entries = value.entries || []
  const selected = params.level && params.level !== 'all' ? entries.filter(function (entry) { return entry.level === params.level }) : entries
  const ordered = params.detail === 'full' || params.level ? selected : selected.filter(function (entry) { return entry.level === 'error' }).concat(selected.filter(function (entry) { return entry.level !== 'error' }))
  const offset = params.offset || 0
  const limit = Math.max(1, Math.min(200, params.limit || 20))
  return Object.assign({}, value, { entries: ordered.slice(offset, offset + limit), count: selected.length, offset: offset, nextOffset: offset + limit < selected.length ? offset + limit : null, order: params.detail === 'full' || params.level ? 'chronological' : 'errors-first', truncated: offset + limit < selected.length })
}

function minToolReportPayload (result, params) {
  if (!result || !result.ok || !result.report) return result
  const report = result.report
  const all = (report.results || []).filter(function (step) { return !params.status || params.status === 'all' || step.status === params.status })
  const offset = params.offset || 0
  const limit = Math.max(1, Math.min(100, params.limit || 20))
  const selected = all.slice(offset, offset + limit)
  const compact = minToolPick(report, ['ok', 'name', 'status', 'error', 'runId', 'reportPath', 'startedAt', 'durationMs', 'summary', 'cancelled'])
  compact.results = selected.map(function (step) {
    if (params.detail === 'full') return step
    const out = minToolPick(step, ['index', 'phase', 'stepIndex', 'action', 'stepName', 'iteration', 'case', 'status', 'ok', 'error', 'condition', 'expected', 'actual', 'attempts', 'durationMs', 'assertion', 'images', 'evidence'])
    if (step.diagnostics) out.diagnostics = minToolDiagnosticsPayload(step.diagnostics, { limit: 5, level: 'error' })
    return out
  })
  return { ok: true, report: compact, count: all.length, offset: offset, nextOffset: offset + limit < all.length ? offset + limit : null }
}
