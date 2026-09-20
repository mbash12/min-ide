/* Custom pi-agent tools that control Min's own tabs and playbooks.
createMinCustomTools() is called from agent.js after the ESM SDK loads.

Browser control is one tool with an `action` subcommand so the catalog stays
small as more gestures are added. Playbooks use the same action names. */
/* global minBrowser, listPlaybooks, getPlaybook, savePlaybook, runPlaybook, deletePlaybook, minFigmaEngine, minFigmaBridge, minDocumentStore */

function minToolTextResult (text, isError) {
  const value = String(text)
  if (isError) throw new Error(value)
  return {
    content: [{ type: 'text', text: value }],
    details: {}
  }
}

function minToolJsonResult (value, isError) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch (e) {
    text = String(value)
  }
  if (isError || (value && value.ok === false)) {
    throw new Error((value && value.error) ? String(value.error) : text)
  }
  return minToolTextResult(text)
}

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

var BROWSER_ACTIONS = [
  'snapshot', 'read', 'screenshot', 'navigate', 'back', 'forward', 'reload', 'tabs',
  'click', 'dblclick', 'rightclick', 'type', 'select', 'press', 'scroll',
  'wait', 'hover', 'drag', 'assert', 'upload', 'download', 'dialog'
]
var FIGMA_ACTIONS = ['status', 'node-data', 'extract-text', 'find-text', 'export']
/* operation names mirror the blueprint's document tools verbatim */
var DOCS_OPERATIONS = ['listDocuments', 'readDocument', 'editDocument']

function minDocsAvailable (workspaceId) {
  if (!workspaceId || workspaceId === 'default') {
    return 'Docs tools need an open workspace'
  }
  if (typeof minDocumentStore === 'undefined' || !minDocumentStore) {
    return 'Docs tools are unavailable'
  }
  return null
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

  function withTask (params) {
    return Object.assign({}, params, { taskId: taskId, workspaceId: workspaceId })
  }

  const locatorFields = {
    ref: optStr('Ref from the latest snapshot, e.g. e12. Re-resolved if the node was rerendered.'),
    selector: optStr('CSS selector. Prefer data-testid / aria-label / name in playbooks.'),
    text: optStr('Visible accessible name. For type, this is the value to type; locate the field with selector/ref/role.'),
    role: optStr('Accessible role to pair with text, e.g. button, textbox, link'),
    nth: optNum('0-based match when several elements share the same role+name'),
    tabId: optStr('Tab id from action=tabs in this workspace. Defaults to this workspace\'s selected tab.'),
    timeout: optNum('How long to wait for a live (attached + stable) element, ms. Default 4000.')
  }

  const browserTool = defineTool({
    name: 'browser',
    label: 'Browser',
    description: 'Control this workspace\'s browser: tabs (list, open, close, select), URL, and the web page. Cannot change Min settings or other chrome.',
    promptSnippet: 'browser: snapshot / click / type / drag / tabs / playbook-ready locators',
    promptGuidelines: [
      'All actions apply only to this workspace\'s tabs, even if another workspace is selected in the window.',
      'Use action=tabs with operation=list|new|close|select to open, close, or switch tabs in this workspace.',
      'Call browser with action=snapshot before click/type/drag unless you already have a current ref from this turn.',
      'Use action=read to get the page text when you need prose, table data, or an error message rather than elements.',
      'Refs are re-resolved after React/Vue rerenders using stored role+name and selector. If a click fails, snapshot again.',
      'Prefer selector (data-testid, aria-label, name) or role+text in playbooks — not refs.',
      'Click variants: dblclick, rightclick, or click with button/clickCount/holdMs/modifiers. Hover then snapshot to reveal menus.',
      'Drag: set source with ref/selector/text and target with targetRef/targetSelector/targetText, or x/y + targetX/targetY.',
      'upload: set files on input[type=file] with path (absolute or min://app/...). download: click a link or pass url, then wait until it finishes.',
      'screenshot captures the visible page to a PNG (path optional). dialog accepts/dismisses alert/confirm/prompt; or set acceptDialog on click.',
      'Selectors pierce open shadow roots and same-origin iframes.',
      'Do not open or interact with Min settings, profiles, or other browser chrome. Only tabs, URLs, and page content.'
    ],
    parameters: Type.Object(Object.assign({
      action: minEnum(Type, BROWSER_ACTIONS, 'Browser sub-action'),
      url: optStr('For navigate, or tabs new'),
      operation: optStr('For tabs: list, new, close, select'),
      value: optStr('For select: option value or visible label'),
      key: optStr('For press: Enter, Tab, Escape, Control+a'),
      submit: optBool('For type: submit the form after typing'),
      direction: optStr('For scroll: up, down, left, right, top, bottom'),
      amount: optNum('For scroll: pixels. Default 600.'),
      ms: optNum('For wait: sleep milliseconds (max 60000)'),
      load: optBool('For wait: wait until the tab finishes loading'),
      x: optNum('Click/drag source X in CSS pixels'),
      y: optNum('Click/drag source Y in CSS pixels'),
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
      limit: optNum('For read: maximum characters of page text. Default 12000.')
    }, locatorFields)),
    execute: async function (_id, params) {
      if (!taskId || taskId === 'default') {
        return minToolTextResult('Browser tools need an open task', true)
      }
      const action = params.action
      if (action === 'navigate' && !params.url) {
        return minToolTextResult('url is required for navigate', true)
      }
      if ((action === 'click' || action === 'dblclick' || action === 'rightclick' || action === 'hover') && !params.ref && !params.selector && !params.text && !params.role && params.x == null) {
        return minToolTextResult(action + ' needs ref, selector, text, role, or x/y', true)
      }
      if (action === 'type') {
        if (params.text == null) return minToolTextResult('text is required for type', true)
        if (!params.ref && !params.selector && !params.role) {
          return minToolTextResult('type needs selector, ref, or role to locate the field', true)
        }
      }
      if (action === 'select' && !params.ref && !params.selector && !params.text && !params.role) {
        return minToolTextResult('select needs ref, selector, text, or role', true)
      }
      if (action === 'drag') {
        const hasFrom = params.ref || params.selector || params.text || params.role || params.x != null
        const hasTo = params.targetRef || params.targetSelector || params.targetText || params.targetRole || params.targetX != null
        if (!hasFrom || !hasTo) {
          return minToolTextResult('drag needs a source (ref/selector/text/x,y) and a target (targetRef/targetSelector/targetText/targetX,Y)', true)
        }
      }
      if (action === 'upload') {
        if (!params.path && !params.files) return minToolTextResult('upload needs path', true)
        if (!params.ref && !params.selector && !params.role) {
          return minToolTextResult('upload needs selector, ref, or role', true)
        }
      }
      if (action === 'snapshot') {
        const result = await minBrowser.snapshot(params.tabId, taskId, workspaceId)
        if (!result || result.ok === false) return minToolJsonResult(result, true)
        const header = (result.title || '') + '\n' + (result.url || '') + '\n'
        return minToolTextResult(header + (result.snapshot || ''))
      }
      if (action === 'read') {
        // the page's readable text: what the snapshot does not cover
        const result = await minBrowser.readPage({ tabId: params.tabId, taskId: taskId, workspaceId: workspaceId, limit: params.limit })
        if (!result || result.ok === false) return minToolJsonResult(result, true)
        const header = (result.title || '') + '\n' + (result.url || '') + '\n'
        const suffix = result.truncated ? '\n\n[truncated at ' + String(result.text.length) + ' of ' + String(result.length) + ' characters]' : ''
        return minToolTextResult(header + (result.text || '') + suffix)
      }
      const result = await minBrowser.runStep(withTask(params))
      return minToolJsonResult(result, result && result.ok === false)
    }
  })

  const playbookTool = defineTool({
    name: 'playbook',
    label: 'Playbook',
    description: 'Create, list, read, run, or delete browser automation playbooks for this workspace only. With a folder they live in .min/playbooks; without one they are stored in Min for this workspace. Step actions match browser.action and run against this workspace\'s tabs.',
    promptSnippet: 'playbook: save/run repeated browser automations',
    promptGuidelines: [
      'Playbooks belong to this workspace. With a folder they are saved in .min/playbooks; otherwise in Min\'s app data for this workspace.',
      'For a task the user will repeat, save a playbook whose steps use the same action names as the browser tool.',
      'Use CSS selectors or role+text in playbook steps, never snapshot refs.',
      'Support {{variable}} placeholders in string fields and pass them via playbook run varsJson.',
      'After saving, tell the user they can run it from the Playbook sidebar tab.'
    ],
    parameters: Type.Object({
      operation: minEnum(Type, ['list', 'get', 'save', 'run', 'delete'], 'Playbook operation'),
      name: optStr('Playbook name (slug). Required for get, save, run, delete.'),
      description: optStr('Short description. Used with save.'),
      steps: minOptional(Type, Type.Array(Type.Object({
        action: Type.String({ description: BROWSER_ACTIONS.join(', ') }),
        url: optStr('For navigate, or tabs new'),
        selector: optStr('CSS selector'),
        text: optStr('Visible name, or text to type, or wait/assert text'),
        role: optStr('Accessible role'),
        nth: optNum('Nth match'),
        ref: optStr('Only for one-off runs; do not save refs in playbooks'),
        value: optStr('For select'),
        key: optStr('For press'),
        ms: optNum('For wait duration'),
        timeout: optNum('For wait/assert/rerender retry'),
        direction: optStr('For scroll'),
        amount: optNum('For scroll'),
        submit: optBool('For type'),
        tabId: optStr('Optional tab id'),
        operation: optStr('For tabs steps: list, new, close, select'),
        continueOnError: optBool('If true, keep running after this step fails'),
        load: optBool('For wait: wait until load'),
        x: optNum('Click/drag source X'),
        y: optNum('Click/drag source Y'),
        targetRef: optStr('For drag'),
        targetSelector: optStr('For drag'),
        targetText: optStr('For drag'),
        targetRole: optStr('For drag'),
        targetNth: optNum('For drag'),
        targetX: optNum('For drag'),
        targetY: optNum('For drag'),
        moves: optNum('For drag pointer path'),
        button: optStr('left, right, middle'),
        clickCount: optNum('1 or 2'),
        holdMs: optNum('Press-and-hold ms'),
        modifiers: optStr('e.g. Control+Shift'),
        path: optStr('upload file path or screenshot PNG path'),
        files: optStr('extra upload paths'),
        acceptDialog: optBool('Accept the next JS dialog after this click'),
        accept: optBool('For dialog: accept vs dismiss'),
        promptText: optStr('Text for prompt() dialogs')
      }))),
      varsJson: optStr('JSON object of values for {{placeholders}} when operation is run')
    }),
    execute: async function (_id, params) {
      if (!workspaceId || workspaceId === 'default') {
        return minToolTextResult('Playbooks need an open workspace', true)
      }
      const operation = params.operation
      if (operation === 'list') {
        return minToolJsonResult(listPlaybooks(cwd, workspaceId))
      }
      if (operation === 'get') {
        if (!params.name) return minToolTextResult('name is required', true)
        const got = getPlaybook(cwd, params.name, workspaceId)
        return minToolJsonResult(got, !got.ok)
      }
      if (operation === 'save') {
        const saved = savePlaybook(cwd, {
          name: params.name,
          description: params.description,
          steps: params.steps
        }, workspaceId)
        if (!saved.ok) return minToolJsonResult(saved, true)
        return minToolJsonResult({
          ok: true,
          name: saved.playbook.name,
          path: saved.path,
          steps: saved.playbook.steps.length,
          hint: 'Run from the Playbook sidebar tab, or call playbook with operation=run.'
        })
      }
      if (operation === 'run') {
        if (!params.name) return minToolTextResult('name is required', true)
        let vars = {}
        if (params.varsJson) {
          try {
            vars = JSON.parse(params.varsJson)
          } catch (e) {
            return minToolTextResult('varsJson is not valid JSON', true)
          }
        }
        const ran = await runPlaybook(cwd, params.name, vars, { workspaceId: workspaceId })
        return minToolJsonResult(ran, ran && ran.ok === false)
      }
      if (operation === 'delete') {
        if (!params.name) return minToolTextResult('name is required', true)
        const removed = deletePlaybook(cwd, params.name, workspaceId)
        return minToolJsonResult(removed, !removed.ok)
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
      'Use listDocuments before readDocument unless the user names a specific document. Call readDocument only when its full Markdown is relevant.',
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
      limit: optNum('Maximum listDocuments results. The service caps this value.')
    }),
    execute: async function (_id, params) {
      params = params || {}
      const unavailable = minDocsAvailable(workspaceId)
      if (unavailable) return minToolTextResult(unavailable, true)
      const operation = params.operation
      if (operation === 'listDocuments') {
        if (params.query != null && String(params.query).trim()) {
          const result = minDocumentStore.searchForAI(workspaceId, params.query, { limit: params.limit })
          return minToolJsonResult(result, result && result.ok === false)
        }
        return minToolJsonResult(minDocumentStore.listForAI(workspaceId, { limit: params.limit }))
      }
      if (operation === 'readDocument') {
        if (params.id == null || !String(params.id).trim()) return minToolTextResult('id is required', true)
        const result = minDocumentStore.getForAI(workspaceId, params.id)
        return minToolJsonResult(result, result && result.ok === false)
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
        return minToolJsonResult(result, result && result.ok === false)
      }
      return minToolTextResult('Unknown docs operation', true)
    }
  })

  const figmaTool = defineTool({
    name: 'figma',
    label: 'Figma',
    description: 'Read and export the connected Figma file through the local plugin bridge (not the REST API). Connect from the Design sidebar first.',
    promptSnippet: 'figma: status / node-data / extract-text / find-text / export',
    promptGuidelines: [
      'Requires Design sidebar Connect on a Figma tab in this workspace.',
      'Default nodeId is the node-id from the Min tab URL. Pass nodeId to target a specific layer.',
      'export writes a PNG under .min/design/exports when the workspace has a folder.',
      'If the plugin is not connected, tell the user to click Connect in the Design sidebar.'
    ],
    parameters: Type.Object({
      action: minEnum(Type, FIGMA_ACTIONS, 'Figma sub-action'),
      nodeId: optStr('Figma node id such as 12:34. Defaults to the connected tab node-id.'),
      query: optStr('For find-text: case-insensitive text or layer name'),
      limit: optNum('For find-text: max matches, 1-50'),
      format: optStr('For export: PNG, JPG, or SVG. Default PNG.'),
      scale: optNum('For export: scale. Default 2.')
    }),
    execute: async function (_id, params) {
      if (!workspaceId || workspaceId === 'default') {
        return minToolTextResult('Figma tools need an open workspace', true)
      }
      const engine = minFigmaEngine.status()
      const ctx = engine.context
      if (params.action === 'status') {
        return minToolJsonResult({
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
        const result = await minFigmaBridge.command('node-data', {
          nodeId: nodeId,
          fileKey: ctx.fileKey
        })
        if (!result || result.ok === false) return minToolJsonResult(result, true)
        if (params.action === 'extract-text') {
          const payload = result.payload || {}
          return minToolTextResult(payload.textExtract || JSON.stringify(payload, null, 2))
        }
        return minToolJsonResult(result.payload || result)
      }
      if (params.action === 'find-text') {
        if (!params.query) return minToolTextResult('query is required for find-text', true)
        const result = await minFigmaBridge.command('find-text', {
          nodeId: nodeId,
          fileKey: ctx.fileKey,
          query: params.query,
          limit: params.limit
        })
        return minToolJsonResult(result && result.payload ? result.payload : result, result && result.ok === false)
      }
      if (params.action === 'export') {
        const result = await minFigmaBridge.command('export', {
          nodeId: nodeId,
          fileKey: ctx.fileKey,
          format: params.format || 'PNG',
          scale: params.scale == null ? 2 : params.scale,
          target: 'asset'
        })
        return minToolJsonResult(result && result.payload ? result.payload : result, result && result.ok === false)
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
  names: minCustomToolNames
}
global.minAgentTools = minAgentTools
