/* Custom pi-agent tools that control Min's own tabs and playbooks.
createMinCustomTools() is called from agent.js after the ESM SDK loads.

Browser control is one tool with an `action` subcommand so the catalog stays
small as more gestures are added. Playbooks use the same action names. */
/* global minBrowser, listPlaybooks, getPlaybook, savePlaybook, runPlaybook, deletePlaybook, minFigmaEngine, minFigmaBridge, minDocumentStore, minDesignSpec, minDesignOverlay, browserControlTargetView, playbookReports, cancelPlaybook, browserCommandFields, browserCommandHelp, minToolTextResult, minToolJsonResult, minToolVisualResult, minToolBrowserPayload, minToolReportPayload, path */

function minOptional (Type, schema) {
  if (Type && typeof Type.Optional === 'function') return Type.Optional(schema)
  return schema
}

function minEnum (Type, values, description) {
  if (Type && typeof Type.Union === 'function' && typeof Type.Literal === 'function') {
    return Type.Union(values.map(function (v) {
      return Type.Literal(v)
    }), { description: description })
  }
  return Type.String({ description: description + ' One of: ' + values.join(', ') })
}

var BROWSER_ACTIONS = ['help', 'batch'].concat(Object.keys(browserCommandFields))
var FIGMA_ACTIONS = [
  'help', 'status', 'node-data', 'extract-text', 'find-text', 'inspect-region', 'export', 'list-frames',
  'spec-list', 'spec-add', 'spec-update', 'spec-remove',
  'variant-add', 'variant-remove', 'overlay', 'capture'
]
/* operation names mirror the blueprint's document tools verbatim */
var DOCS_OPERATIONS = ['listDocuments', 'readDocument', 'editDocument']
var PLAYBOOK_OPERATIONS = ['help', 'list', 'get', 'save', 'run', 'reports', 'report', 'cancel', 'delete']
/* sub-actions per custom tool, surfaced in the Pro Settings tools directory */
var MIN_TOOL_ACTIONS = {
  browser: BROWSER_ACTIONS,
  playbook: PLAYBOOK_OPERATIONS,
  docs: DOCS_OPERATIONS,
  figma: FIGMA_ACTIONS
}

function minDocsAvailable (workspaceId) {
  if (!workspaceId || workspaceId === 'default') {
    return 'Docs tools need an open workspace'
  }
  if (typeof minDocumentStore === 'undefined' || !minDocumentStore) {
    return 'Docs tools are unavailable'
  }
  return null
}

/* Ensures a spec variant has a rendered export, then activates the overlay on
the target tab. Shared by the figma tool's `overlay` action. */
async function minDesignOverlayExportAndSet (tabId, entry, variant, workspacePath) {
  if (!variant.nodeId) {
    return { ok: false, error: 'Variant has no nodeId — set one first' }
  }
  let imagePath = variant.image
  let cssWidth = variant.cssWidth || null
  const engine = minFigmaEngine.status()
  const ctx = engine.context
  if (!imagePath) {
    if (!ctx || !ctx.fileKey) {
      return { ok: false, error: 'No Figma file connected — connect from the Design sidebar to export the design' }
    }
    if (!engine.bridge || !engine.bridge.pluginConnected) {
      return { ok: false, error: 'Figma plugin is not connected yet — wait a few seconds after Connect' }
    }
    const scale = 2
    const exported = await minFigmaBridge.command('export', {
      nodeId: variant.nodeId,
      fileKey: ctx.fileKey,
      format: 'PNG',
      scale: scale,
      exportDir: workspacePath ? path.join(workspacePath, '.min', 'design', 'exports') : undefined,
      fileName: entry.name + '-' + variant.label
    })
    const payload = exported && exported.payload
    if (!payload || !payload.path) {
      return { ok: false, error: (exported && exported.error) || 'Design export failed' }
    }
    imagePath = payload.path
    const patch = { image: imagePath }
    if (payload.node && payload.node.width) {
      // The plugin may clamp scale for over-limit rasters — trust its report.
      const effScale = payload.scale || scale
      cssWidth = Math.round(payload.node.width / effScale)
      patch.cssWidth = cssWidth
      // Viewport follows the real frame size — heights differ per frame.
      const cssHeight = payload.node.height ? Math.round(payload.node.height / effScale) : null
      const vp = variant.viewport || {}
      if (cssHeight && (vp.w !== cssWidth || vp.h !== cssHeight)) {
        patch.viewport = { w: cssWidth, h: cssHeight, mobile: !!vp.mobile, dpr: vp.dpr }
        variant.viewport = patch.viewport
      }
    }
    minDesignSpec.variantUpdate(workspacePath, entry.id, variant.id, patch)
    variant.image = imagePath
    variant.cssWidth = cssWidth
  }
  const result = await minDesignOverlay.set(tabId, {
    image: imagePath,
    label: entry.name + ' / ' + variant.label,
    cssWidth: cssWidth,
    viewport: variant.viewport,
    entryId: entry.id,
    variantId: variant.id
  })
  return result
}

function createMinCustomTools (defineTool, Type, cwd, taskId, workspaceId) {
  const optStr = function (description) {
    return minOptional(Type, Type.String({ description: description }))
  }
  const optNum = function (description) {
    return minOptional(Type, Type.Number({ description: description }))
  }
  const optBool = function (description) {
    return minOptional(Type, Type.Boolean({ description: description }))
  }

  function jsonResult (value, isError, params) {
    return minToolJsonResult(value, isError, Object.assign({}, params, { cwd: cwd, workspaceId: workspaceId }))
  }
  function visualResult (value, isError, params) {
    return minToolVisualResult(value, isError, Object.assign({}, params, { cwd: cwd, workspaceId: workspaceId }))
  }
  const stepArray = function () {
    return minOptional(Type, Type.Array(Type.Object({ action: minEnum(Type, Object.keys(browserCommandFields), 'browser action') }, {
      additionalProperties: true,
      description: 'Same fields as browser; stepName optional. Validated before execution. Playbook steps allow {{variables}} and continueOnError.'
    })))
  }

  function withTask (params) {
    return Object.assign({}, params, { taskId: taskId, workspaceId: workspaceId, outputDir: cwd ? path.join(cwd, '.min', 'design', 'shots') : undefined })
  }

  const rectSchema = Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() })
  const visualFields = {
    width: optNum('For viewport set: width in CSS pixels'),
    height: optNum('For viewport set: height in CSS pixels'),
    dpr: optNum('For viewport: device pixel ratio, default 1'),
    mobile: optBool('For viewport: mobile emulation, default false; does not change user-agent'),
    clip: minOptional(Type, Object.assign({}, rectSchema, { description: 'For screenshot/compare: area in viewport CSS pixels. Use either clip or an element locator. The area must be inside the viewport.' })),
    referencePath: optStr('For compare: absolute local PNG/JPEG reference path (or min://app/...)'),
    referenceScale: optNum('For compare: reference image pixels per CSS pixel, e.g. 2 for a 2x Figma export. Default 1. Never guess by stretching the image.'),
    referenceClip: minOptional(Type, Object.assign({}, rectSchema, { description: 'For compare: reference area in CSS pixels, with the same CSS width/height as the capture. Default capture document coordinates; use this for a cropped reference.' })),
    maxMismatchRatio: optNum('For compare: optional pass/fail limit 0–1. Playbook fails if exceeded or capture readiness times out. Does not update the reference.'),
    threshold: optNum('For compare: per-channel pixel difference tolerance 0–1, default 0.1. Includes antialiasing; not a semantic score.'),
    includeOverlay: optBool('For screenshot/inspect: include Min design overlay. Default false. compare always hides it.'),
    hideScrollbars: optBool('For visual tools: temporarily hide scrollbars. Default true.'),
    freezeAnimations: optBool('For visual tools: temporarily pause CSS animations and hide caret. Default true. JS/video animations can still change.')
  }

  const testFields = {
    condition: optStr('For assert/wait: visible (default), hidden, attached, detached, text, value, checked, enabled, disabled, count, attribute, css, url, title, no-errors'),
    expected: minOptional(Type, Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()], { description: 'Expected assertion value. Required for text/value/count/attribute/css/url/title. checked defaults true.' })),
    contains: optBool('For string assertions: substring comparison, default false'),
    not: optBool('Negate an assertion. Missing elements never pass a singular assertion; use hidden/detached.'),
    attribute: optStr('Attribute name for condition=attribute'),
    property: optStr('CSS property for condition=css'),
    checked: optBool('For check: desired checkbox/radio state. Default true; does not toggle repeatedly.'),
    includeHidden: optBool('For find: include hidden elements, default false')
  }
  const locatorFields = {
    testId: optStr('Exact data-testid value; stable across rerenders'),
    label: optStr('Associated label or ARIA label'),
    placeholder: optStr('Input placeholder'),
    name: optStr('Accessible name, usually paired with role'),
    exact: optBool('Locator names match exactly by default (case-insensitive). false allows substring.'),
    strict: optBool('Default true: fail ambiguous action/assert locators. Refine the locator or choose nth.'),
    ref: optStr('Ref from the latest snapshot, e.g. e12. Re-resolved if the node was rerendered.'),
    selector: optStr('CSS selector. Prefer data-testid / aria-label / name in playbooks.'),
    text: optStr('Visible accessible name. For type, this is the value to type; locate the field with selector/ref/role.'),
    role: optStr('Accessible role to pair with text, e.g. button, textbox, link'),
    nth: optNum('0-based match when several elements share the same role+name'),
    tabId: optStr('Tab id from action=tabs in this workspace. Defaults to this workspace\'s selected tab.'),
    timeout: optNum('How long to wait for a live (attached + stable) element, ms. Default 4000.')
  }

  const browserParameters = Object.assign({
    action: minEnum(Type, BROWSER_ACTIONS, 'Browser sub-action'),
    url: optStr('For navigate, or tabs new'),
    operation: optStr('For tabs: list, new, close, select. viewport: get, set, reset. diagnostics: get, clear.'),
    value: optStr('For fill: field value (empty clears). For select: option value or visible label'),
    key: optStr('For press: Enter, Tab, Escape, Control+a'),
    submit: optBool('For type: submit the form after typing'),
    direction: optStr('For scroll: up, down, left, right, top, bottom'),
    amount: optNum('For scroll: pixels. Default 600.'),
    ms: optNum('For wait: sleep milliseconds (max 60000)'),
    load: optBool('For wait: wait until the tab finishes loading'),
    x: optNum('Click/drag/inspect X in viewport CSS pixels'),
    y: optNum('Click/drag/inspect Y in viewport CSS pixels'),
    targetRef: optStr('For drag: target ref'),
    targetSelector: optStr('For drag: target CSS selector'),
    targetText: optStr('For drag: target visible name'),
    targetRole: optStr('For drag: target role'),
    targetNth: optNum('For drag: target nth match'),
    targetX: optNum('For drag: target X in CSS pixels'),
    targetY: optNum('For drag: target Y in CSS pixels'),
    moves: optNum('For drag: intermediate pointer moves. Default 12.'),
    button: optStr('For click: left, right, or middle. Default left.'),
    clickCount: optNum('For click: 1 for single, 2 for double.'),
    holdMs: optNum('For click: hold the button down this many ms'),
    modifiers: optStr('For click: e.g. Control, Shift, Control+Shift'),
    path: optStr('For upload: file path (absolute or min://app/...). For screenshot: PNG destination.'),
    files: optStr('For upload: extra comma-separated paths'),
    acceptDialog: optBool('For click: accept the next alert/confirm/prompt'),
    accept: optBool('For dialog: true to accept, false to dismiss. Default true.'),
    promptText: optStr('For dialog / acceptDialog: text to type into prompt()'),
    limit: optNum('Page size: read characters (6000), snapshot elements (80), find matches (10), diagnostics entries (20).'),
    offset: optNum('Resume at nextOffset returned by read/snapshot/find/diagnostics; default 0'),
    detail: optStr('compact (default) or full. Full adds related styles/geometry.'),
    images: optStr('auto (default): screenshot image; compare diff only when changed. all: reference+actual+diff. none: paths/metrics only.'),
    properties: optStr('inspect: comma-separated CSS properties, e.g. gap,font-size,color'),
    level: optStr('diagnostics: all, error, warning, info, debug'),
    topic: optStr('help: action to explain; omit for workflow/examples'),
    steps: stepArray()
  }, locatorFields, testFields, visualFields)

  const browserTool = defineTool({
    name: 'browser',
    label: 'Browser',
    description: 'Control this workspace\'s browser: tabs (list, open, close, select), URL, and the web page. Cannot change Min settings or other chrome.',
    promptSnippet: 'browser: find / fill / click / press / assert / diagnostics / viewport / screenshot / compare (internal browser)',
    promptGuidelines: [
      'Use Min’s internal browser for UI work/testing. Tools stay in the calling task/workspace; do not drive browser settings or use an external browser.',
      'Find targets with testId, label, or role+name; snapshot for overview. Known locators can act directly. Ambiguous actions fail; refine or choose nth. Save stable locators in playbooks.',
      'Use fill(value), check(checked), click, press(key), then assert(condition,expected). Assertions wait; mutations never auto-retry. batch runs 1–12 known steps sequentially and stops on failure. Earlier steps have already run.',
      'Results are compact. Use selector/limit/offset to narrow reads, properties for inspect, detail=full for related geometry/styles. Follow nextOffset or _output.fullResultPath when truncated; never infer omitted data.',
      'Use the screenshot/export as design truth. Set viewport and compare(referencePath,known referenceScale); Figma supplies targeted styles/fonts/text. Inspect mismatches before changing CSS.',
      'Image previewToCSS maps pixels to CSS coordinates. Compare never fits/stretches or updates references; check readiness and assertion.passed. images=all shows reference/actual/diff; unchanged comparisons return metrics only.',
      'diagnostics clear starts an error window; assert no-errors checks observed logs. Open shadows/same-origin frames are supported. help with topic explains any action.'
    ],
    parameters: Type.Object(browserParameters),
    execute: async function (_id, params) {
      if (params.action === 'help') {
        const help = browserCommandHelp(params.topic)
        if (help.fields) help.parameters = Object.fromEntries(help.fields.filter(function (key) { return browserParameters[key] }).map(function (key) { return [key, browserParameters[key].description || browserParameters[key].type || 'value'] }))
        delete help.fields
        return jsonResult(help)
      }
      if (!taskId || taskId === 'default') return minToolTextResult('Browser tools need an open task', true)
      const result = await minBrowser.runStep(withTask(params))
      if (params.action === 'screenshot' || params.action === 'compare') return visualResult(result, false, params)
      return jsonResult(minToolBrowserPayload(result, params), result && result.ok === false, params)
    }
  })

  const playbookTool = defineTool({
    name: 'playbook',
    label: 'Playbook',
    description: 'Save and repeat browser automation or testing scenarios in this workspace using Min tabs. Reports include pass/fail, assertion details, durations, diagnostics, and failure screenshots.',
    promptSnippet: 'playbook: save / run / reports / report / cancel repeatable browser tests',
    promptGuidelines: [
      'Save reusable tests with browser fields and stable locators. setup/steps/teardown run per case and repetition; teardown also runs after failures/cancellation. Sessions share cookies/storage: make setup deterministic.',
      'vars defaults → case vars → run overrides. Whole {{variable}} fields preserve types; all resolved steps validate before mutations. repeat=1–20; continueOnError never turns failures green.',
      'run returns status/counts/reportPath; report pages through results (status=failed filters failures). cancel finishes the current step then cleans up. Users can repeat/stop/open reports in the sidebar.'
    ],
    parameters: Type.Object({
      operation: minEnum(Type, PLAYBOOK_OPERATIONS, 'Playbook operation'),
      name: optStr('Playbook name, required except for list'),
      description: optStr('Short description for save'),
      steps: stepArray(),
      setup: stepArray(),
      teardown: stepArray(),
      repeat: optNum('Save default repetitions or override on run, 1–20; default 1'),
      tabId: optStr('Initial tab on run, defaults to this task’s selected web tab'),
      vars: minOptional(Type, Type.Object({}, { additionalProperties: true, description: 'Default variables on save; overrides on run' })),
      cases: minOptional(Type, Type.Array(Type.Object({ name: Type.String(), vars: Type.Object({}, { additionalProperties: true }) }), { description: 'save: up to 20 named data cases' })),
      status: optStr('report: all (default), failed, passed, skipped'),
      offset: optNum('report: nextOffset from previous page; default 0'),
      limit: optNum('report: results per page, default 20, max 100'),
      detail: optStr('report: compact (default) or full'),
      runId: optStr('For report: runId returned by run or reports')
    }),
    execute: async function (_id, params) {
      if (params.operation === 'help') return jsonResult({ ok: true, operations: PLAYBOOK_OPERATIONS, example: { operation: 'save', name: 'smoke', vars: { baseUrl: 'http://localhost:3000' }, setup: [{ action: 'navigate', url: '{{baseUrl}}' }], steps: [{ action: 'assert', role: 'heading', name: 'Home' }], teardown: [{ action: 'viewport', operation: 'reset' }] }, run: { operation: 'run', name: 'smoke', repeat: 3 }, reports: 'report accepts runId, status=failed, offset/limit. Browser help describes step fields.' })

      if (!workspaceId || workspaceId === 'default') {
        return minToolTextResult('Playbooks need an open workspace', true)
      }
      const operation = params.operation
      if (operation === 'list') {
        const result = listPlaybooks(cwd, workspaceId)
        if (result.playbooks) result.playbooks = result.playbooks.map(function (book) { const compact = Object.assign({}, book); delete compact.stepItems; return compact })
        return jsonResult(result)
      }
      if (operation === 'get') {
        if (!params.name) return minToolTextResult('name is required', true)
        const got = getPlaybook(cwd, params.name, workspaceId)
        return jsonResult(got, !got.ok)
      }
      if (operation === 'save') {
        const saved = savePlaybook(cwd, {
          name: params.name,
          description: params.description,
          steps: params.steps,
          setup: params.setup,
          teardown: params.teardown,
          repeat: params.repeat,
          vars: params.vars || (params.varsJson ? JSON.parse(params.varsJson) : {}),
          cases: params.cases || (params.casesJson ? JSON.parse(params.casesJson) : undefined)
        }, workspaceId)
        if (!saved.ok) return jsonResult(saved, true)
        return jsonResult({
          ok: true,
          name: saved.playbook.name,
          path: saved.path,
          steps: saved.playbook.steps.length,
          hint: 'Run from the Playbook sidebar tab, or call playbook with operation=run.'
        })
      }
      if (operation === 'run') {
        if (!params.name) return minToolTextResult('name is required', true)
        let vars = params.vars || {}
        if (!params.vars && params.varsJson) {
          try {
            vars = JSON.parse(params.varsJson)
          } catch (e) {
            return minToolTextResult('varsJson is not valid JSON', true)
          }
        }
        const ran = await runPlaybook(cwd, params.name, vars, { workspaceId: workspaceId, taskId: taskId, tabId: params.tabId, repeat: params.repeat })
        const summary = Object.assign({}, ran)
        delete summary.scenarios
        summary.results = (ran.results || []).filter(function (result) { return result.status === 'failed' }).slice(0, 10)
        summary.hint = 'Use report with runId for all step results.'
        summary.results = summary.results.map(function (step) { const result = Object.assign({}, step); if (result.diagnostics) result.diagnostics = minToolBrowserPayload(result.diagnostics, { action: 'diagnostics', level: 'error', limit: 5 }); return result })
        return jsonResult(summary, !ran.ok, params)
      }
      if (operation === 'reports' || operation === 'report') {
        if (!params.name) return minToolTextResult('name is required', true)
        if (operation === 'report' && !params.runId) return minToolTextResult('runId is required', true)
        if (params.status && !['all', 'failed', 'passed', 'skipped'].includes(params.status)) return minToolTextResult('status must be all, failed, passed, or skipped', true)
        if ((params.offset != null && (!Number.isInteger(params.offset) || params.offset < 0)) || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) return minToolTextResult('Invalid offset/limit', true)
        return jsonResult(minToolReportPayload(playbookReports(cwd, params.name, workspaceId, operation === 'report' ? params.runId : undefined), params), false, params)
      }
      if (operation === 'cancel') return jsonResult(cancelPlaybook(workspaceId, params.name))
      if (operation === 'delete') {
        if (!params.name) return minToolTextResult('name is required', true)
        const removed = deletePlaybook(cwd, params.name, workspaceId)
        return jsonResult(removed, !removed.ok)
      }
      return minToolTextResult('Unknown playbook operation', true)
    }
  })

  /* Documents stay one grouped tool (like browser/playbook/figma) so the
  agent catalog does not grow, but the operation names match the blueprint's
  three tools verbatim: listDocuments, readDocument, editDocument. Nothing is
  ever injected into context. */

  const docsTool = defineTool({
    name: 'docs',
    label: 'Docs',
    description: 'On-demand access to this workspace\'s non-private Markdown documents. Docs are never injected into chat context; call an operation when the user asks you to inspect or persist documentation.',
    promptSnippet: 'docs: listDocuments / readDocument / editDocument on request',
    promptGuidelines: [
      'Docs are scoped to this workspace. The workspace is fixed by the session; never ask for or invent a workspaceId parameter.',
      'List/search documents before reading unless id is known. readDocument pages Markdown with offset/limit; follow nextOffset only when needed.',
      'editDocument creates a document without id and updates it with id; use it only when the user explicitly asks for a persistent documentation change.',
      'Private or not-found documents are unavailable. Never infer, expose, or bypass a private document.'
    ],
    parameters: Type.Object({
      operation: minEnum(Type, DOCS_OPERATIONS, 'Docs operation'),
      id: optStr('Document id. Required for readDocument; for editDocument, omit to create.'),
      query: optStr('Search text for listDocuments. When omitted, it lists documents.'),
      title: optStr('Document title. Used by editDocument.'),
      markdown: optStr('Markdown content. Used by editDocument.'),
      private: optBool('Restrict the document from AI access. Used by editDocument.'),
      limit: optNum('listDocuments: max results. readDocument: max characters, default 6000.'),
      offset: optNum('readDocument: resume from nextOffset; default 0')
    }),
    execute: async function (_id, params) {
      params = params || {}
      const unavailable = minDocsAvailable(workspaceId)
      if (unavailable) return minToolTextResult(unavailable, true)
      const operation = params.operation
      if (operation === 'listDocuments') {
        if (params.query != null && String(params.query).trim()) {
          const result = minDocumentStore.searchForAI(workspaceId, params.query, { limit: params.limit })
          return jsonResult(result, result && result.ok === false)
        }
        return jsonResult(minDocumentStore.listForAI(workspaceId, { limit: params.limit }))
      }
      if (operation === 'readDocument') {
        if (params.id == null || !String(params.id).trim()) return minToolTextResult('id is required', true)
        const result = minDocumentStore.getForAI(workspaceId, params.id)
        if (result && result.ok && result.document && typeof result.document.markdown === 'string') {
          const offset = params.offset == null ? 0 : params.offset
          const limit = params.limit == null ? 6000 : params.limit
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30000) return minToolTextResult('readDocument needs offset >= 0 and limit 1–30000', true)
          const markdown = result.document.markdown
          return jsonResult(Object.assign({}, result, { document: Object.assign({}, result.document, { markdown: markdown.slice(offset, offset + limit) }), length: markdown.length, offset: offset, nextOffset: offset + limit < markdown.length ? offset + limit : null }))
        }
        return jsonResult(result, result && result.ok === false)
      }
      if (operation === 'editDocument') {
        const fields = {}
        if (Object.prototype.hasOwnProperty.call(params, 'title')) fields.title = params.title
        if (Object.prototype.hasOwnProperty.call(params, 'markdown')) fields.markdown = params.markdown
        /* Keep an unexpected privacy field visible to the main-only helper so
         * malformed callers fail closed instead of silently changing policy. */
        if (Object.prototype.hasOwnProperty.call(params, 'private')) fields.private = params.private
        const result = (params.id != null && String(params.id).trim())
          ? minDocumentStore.updateForAI(workspaceId, params.id, fields)
          : minDocumentStore.createForAI(workspaceId, fields)
        return jsonResult(result, result && result.ok === false)
      }
      return minToolTextResult('Unknown docs operation', true)
    }
  })

  const figmaTool = defineTool({
    name: 'figma',
    label: 'Figma',
    description: 'Inspect/export the connected Figma file, manage design variants and overlays. Connect in Design sidebar.',
    promptSnippet: 'figma: status / node-data / extract-text / find-text / inspect-region / export / list-frames / spec-* / overlay / capture',
    promptGuidelines: [
      'Use export as visual truth; inspect-region or find-text to target layers despite messy grouping. Fetch only needed fields from node-data (css,fonts,text). nodeId defaults to the connected tab.',
      'Regions use original export pixels with the reported referenceScale. Browser comparison uses the same scale. Overlapping layers are candidates; exports return image previews and artifact paths.',
      'Only change spec entries/overlays when authorized. If disconnected, Connect in Design sidebar. help provides examples; images=none suppresses image previews.'
    ],
    parameters: Type.Object({
      action: minEnum(Type, FIGMA_ACTIONS, 'Figma sub-action'),
      nodeId: optStr('Figma node id such as 12:34. Defaults to the connected tab node-id.'),
      fields: optStr('node-data: comma-separated css,fonts,text; default css,fonts. full detail includes all.'),
      detail: optStr('compact (default) or full'),
      images: optStr('auto (default), all, or none'),
      query: optStr('For find-text: case-insensitive text or layer name'),
      limit: optNum('For find-text/inspect-region: max matches, 1-50'),
      region: minOptional(Type, Object.assign({}, rectSchema, { description: 'For inspect-region: x/y/width/height in original export pixels, relative to exported nodeId. Use a small rectangle to probe a point.' })),
      referenceScale: optNum('For inspect-region: original export pixels per Figma unit, default 1. Use export payload scale.'),
      format: optStr('For export: PNG, JPG, or SVG. Default PNG.'),
      scale: optNum('For export: scale. Default 2.'),
      entryId: optStr('For spec-update/spec-remove/variant-add/variant-remove/overlay: spec entry id'),
      variantId: optStr('For variant-remove/overlay: variant id'),
      name: optStr('For spec-add: entry name'),
      label: optStr('For variant-add: variant label'),
      kind: optStr('For spec-add: page, component, or element. Default page.'),
      figmaUrl: optStr('For spec-add: source Figma URL'),
      status: optStr('For spec-update: todo, doing, or done'),
      viewport: optStr('For variant-add: desktop, mobile, or WxH such as 768x1024'),
      tabId: optStr('For overlay/capture: target tab id. Defaults to the active tab of this task.'),
      on: optBool('For overlay: true to show, false to clear. Default true.')
    }),
    execute: async function (_id, params) {
      if (params.action === 'help') return jsonResult({ ok: true, actions: FIGMA_ACTIONS, examples: [{ action: 'export', nodeId: '12:34', scale: 2 }, { action: 'inspect-region', nodeId: '12:34', referenceScale: 2, region: { x: 100, y: 80, width: 40, height: 40 } }, { action: 'node-data', nodeId: '12:35', fields: 'css,fonts' }], workflow: 'Export → inspect-region/find-text → node-data for a specific layer. Compare the export in Min browser.' })

      if (!workspaceId || workspaceId === 'default') {
        return minToolTextResult('Figma tools need an open workspace', true)
      }
      const engine = minFigmaEngine.status()
      const specWorkspace = cwd || null

      // Spec actions only need the workspace store — no Figma connection.
      if (params.action === 'spec-list') {
        return jsonResult(minDesignSpec.list(specWorkspace).doc)
      }
      if (params.action === 'spec-add') {
        if (!params.name) return minToolTextResult('name is required for spec-add', true)
        return jsonResult(minDesignSpec.add(specWorkspace, {
          name: params.name,
          kind: params.kind,
          figmaUrl: params.figmaUrl,
          nodeId: params.nodeId,
          fileKey: engine.context && engine.context.fileKey
        }))
      }
      if (params.action === 'spec-update') {
        if (!params.entryId) return minToolTextResult('entryId is required for spec-update', true)
        return jsonResult(minDesignSpec.update(specWorkspace, params.entryId, {
          name: params.name, kind: params.kind, status: params.status, nodeId: params.nodeId
        }))
      }
      if (params.action === 'spec-remove') {
        if (!params.entryId) return minToolTextResult('entryId is required for spec-remove', true)
        return jsonResult(minDesignSpec.remove(specWorkspace, params.entryId))
      }
      if (params.action === 'variant-add') {
        if (!params.entryId) return minToolTextResult('entryId is required for variant-add', true)
        return jsonResult(minDesignSpec.variantAdd(specWorkspace, params.entryId, {
          label: params.label, nodeId: params.nodeId, viewport: params.viewport
        }))
      }
      if (params.action === 'variant-remove') {
        if (!params.entryId || !params.variantId) {
          return minToolTextResult('entryId and variantId are required for variant-remove', true)
        }
        return jsonResult(minDesignSpec.variantRemove(specWorkspace, params.entryId, params.variantId))
      }
      if (params.action === 'capture') {
        const target = await browserControlTargetView(params.tabId, taskId, workspaceId)
        if (target.error) return minToolTextResult(target.error, true)
        const dir = specWorkspace ? path.join(specWorkspace, '.min', 'design', 'shots') : null
        return visualResult(await minBrowser.runStep(withTask({ action: 'screenshot', tabId: target.id, outputDir: dir })), false, params)
      }
      if (params.action === 'overlay') {
        const target = await browserControlTargetView(params.tabId, taskId, workspaceId)
        if (target.error) return minToolTextResult(target.error, true)
        if (params.on === false) {
          return jsonResult(await minDesignOverlay.clear(target.id))
        }
        if (!params.entryId || !params.variantId) {
          return minToolTextResult('entryId and variantId are required for overlay', true)
        }
        const doc = minDesignSpec.doc(specWorkspace)
        const entry = doc.entries.find(function (e) { return e.id === params.entryId })
        const variant = entry && entry.variants.find(function (v) { return v.id === params.variantId })
        if (!variant) return minToolTextResult('Variant not found in the design spec', true)
        return jsonResult(await minDesignOverlayExportAndSet(target.id, entry, variant, specWorkspace))
      }
      const ctx = engine.context
      if (params.action === 'status') {
        return jsonResult({
          ok: true,
          running: engine.running,
          connected: !!(ctx && ctx.fileKey),
          pluginConnected: !!(engine.bridge && engine.bridge.pluginConnected),
          fileKey: ctx && ctx.fileKey,
          nodeId: ctx && ctx.nodeId,
          needsLogin: !!(ctx && ctx.needsLogin),
          launchError: engine.engineLaunch
        })
      }
      if (!ctx || !ctx.fileKey) {
        return minToolTextResult('No Figma file connected. Open a Figma tab and click Connect in the Design sidebar.', true)
      }
      if (!engine.bridge || !engine.bridge.pluginConnected) {
        return minToolTextResult('Figma plugin is not connected yet. Wait a few seconds after Connect, or click Connect again.', true)
      }
      const nodeId = params.nodeId || ctx.nodeId || undefined
      if (params.action === 'extract-text' || params.action === 'node-data') {
        const wanted = (params.action === 'extract-text' ? 'text' : params.fields || (params.detail === 'full' ? 'css,fonts,text' : 'css,fonts')).split(',').map(function (field) { return field.trim() })
        if (wanted.some(function (field) { return !['css', 'fonts', 'text'].includes(field) })) return minToolTextResult('fields must be css,fonts,text', true)
        const result = await minFigmaBridge.command('node-data', {
          nodeId: nodeId,
          fileKey: ctx.fileKey,
          fields: wanted
        })
        if (!result || result.ok === false) return jsonResult(result, true)
        if (params.action === 'extract-text') {
          const payload = result.payload || {}
          return jsonResult({ id: payload.id, text: payload.textExtract || '' }, false, params)
        }
        const payload = result.payload || result
        const out = { id: payload.id, name: payload.name, type: payload.type, width: payload.width, height: payload.height }
        if (wanted.includes('css')) out.css = payload.css
        if (wanted.includes('fonts')) { try { out.fonts = JSON.parse(payload.fontJson || '[]') } catch (err) { out.fonts = payload.fontJson } }
        if (wanted.includes('text')) out.text = payload.textExtract
        return jsonResult(out, false, params)
      }
      if (params.action === 'list-frames') {
        const result = await minFigmaBridge.command('list-frames', {
          fileKey: ctx.fileKey
        })
        return jsonResult(result && result.payload ? result.payload : result, result && result.ok === false)
      }
      if (params.action === 'find-text') {
        if (!params.query) return minToolTextResult('query is required for find-text', true)
        const result = await minFigmaBridge.command('find-text', {
          nodeId: nodeId,
          fileKey: ctx.fileKey,
          query: params.query,
          limit: params.limit == null ? 5 : params.limit
        })
        return jsonResult(result && result.payload ? result.payload : result, result && result.ok === false)
      }
      if (params.action === 'inspect-region') {
        if (!params.region) return minToolTextResult('region is required for inspect-region', true)
        const result = await minFigmaBridge.command('inspect-region', {
          nodeId: nodeId, fileKey: ctx.fileKey, region: params.region, referenceScale: params.referenceScale, limit: params.limit == null ? 5 : params.limit
        })
        return jsonResult(result && result.payload ? result.payload : result, result && result.ok === false)
      }
      if (params.action === 'export') {
        const result = await minFigmaBridge.command('export', {
          nodeId: nodeId,
          fileKey: ctx.fileKey,
          format: params.format || 'PNG',
          scale: params.scale == null ? 2 : params.scale,
          exportDir: specWorkspace ? path.join(specWorkspace, '.min', 'design', 'exports') : undefined,
          target: 'asset'
        })
        return visualResult(result && result.payload ? result.payload : result, result && result.ok === false, params)
      }
      return minToolTextResult('Unknown figma action', true)
    }
  })

  return [browserTool, playbookTool, docsTool, figmaTool]
}

function minCustomToolNames (tools) {
  return tools.map(function (tool) { return tool.name })
}

/* used by agent.js in the concatenated main bundle */
var minAgentTools = {
  create: createMinCustomTools,
  names: minCustomToolNames,
  actions: MIN_TOOL_ACTIONS
}
global.minAgentTools = minAgentTools
