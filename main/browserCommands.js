/* One action contract for tool help, batch/playbook preflight, and live calls. */
/* exported browserCommandHelp, browserCommandValidate */
var browserCommandLocators = 'ref selector testId label placeholder name role text exact strict nth'
var browserCommandPointer = 'x y button clickCount holdMs modifiers acceptDialog accept promptText'
var browserCommandVisual = 'clip includeOverlay hideScrollbars freezeAnimations path'
var browserCommandAssertions = 'condition expected contains not attribute property'
var browserCommandFields = {
  find: browserCommandLocators + ' limit offset includeHidden',
  fill: browserCommandLocators + ' value submit',
  type: browserCommandLocators + ' submit',
  check: browserCommandLocators + ' checked',
  focus: browserCommandLocators,
  click: browserCommandLocators + ' ' + browserCommandPointer,
  dblclick: browserCommandLocators + ' ' + browserCommandPointer,
  rightclick: browserCommandLocators + ' ' + browserCommandPointer,
  hover: browserCommandLocators + ' x y modifiers',
  drag: browserCommandLocators + ' x y targetRef targetSelector targetText targetRole targetNth targetX targetY moves modifiers',
  select: browserCommandLocators + ' value',
  press: browserCommandLocators + ' key',
  scroll: browserCommandLocators + ' direction amount',
  assert: browserCommandLocators + ' ' + browserCommandAssertions,
  wait: browserCommandLocators + ' ' + browserCommandAssertions + ' ms load',
  diagnostics: 'operation limit offset level',
  navigate: 'url',
  back: '',
  forward: '',
  reload: '',
  tabs: 'operation url',
  snapshot: 'selector limit offset',
  read: 'selector limit offset',
  screenshot: browserCommandLocators + ' ' + browserCommandVisual,
  viewport: 'operation width height dpr mobile',
  inspect: browserCommandLocators + ' x y limit includeOverlay hideScrollbars freezeAnimations properties',
  compare: browserCommandLocators + ' ' + browserCommandVisual + ' referencePath referenceScale referenceClip threshold maxMismatchRatio',
  upload: browserCommandLocators + ' path files',
  download: browserCommandLocators + ' url',
  dialog: 'accept promptText'
}

var browserCommandExamples = {
  find: { action: 'find', role: 'button', name: 'Save' },
  fill: { action: 'fill', label: 'Email', value: 'test@example.test' },
  check: { action: 'check', testId: 'terms', checked: true },
  click: { action: 'click', role: 'button', name: 'Save' },
  press: { action: 'press', key: 'Tab' },
  assert: { action: 'assert', testId: 'status', condition: 'text', expected: 'Saved' },
  wait: { action: 'wait', selector: '.spinner', condition: 'hidden' },
  viewport: { action: 'viewport', width: 1280, height: 800, dpr: 1 },
  inspect: { action: 'inspect', testId: 'card', properties: 'gap,font-size,color' },
  compare: { action: 'compare', referencePath: '/design.png', referenceScale: 2, maxMismatchRatio: 0.01 },
  diagnostics: { action: 'diagnostics', operation: 'get', level: 'error' }
}

function browserCommandHelp (action) {
  if (!action) return { ok: true, actions: ['batch'].concat(Object.keys(browserCommandFields)), workflow: 'find → fill/click/press → assert. Use batch for known sequential steps; playbook for repeated scenarios.', examples: [browserCommandExamples.find, browserCommandExamples.fill, browserCommandExamples.assert] }
  if (action === 'batch') return { ok: true, action: action, fields: ['steps', 'tabId', 'detail'], example: { action: 'batch', steps: [browserCommandExamples.fill, browserCommandExamples.click, browserCommandExamples.assert] }, semantics: '1–12 steps; preflight all parameters, pin task/tab, run sequentially, stop on failure. Never replay a batch blindly.' }
  if (!Object.prototype.hasOwnProperty.call(browserCommandFields, action)) return { ok: false, error: 'Unknown browser action: ' + action }
  return { ok: true, action: action, fields: (browserCommandFields[action] + ' tabId timeout detail images').trim().split(/\s+/), example: browserCommandExamples[action] || { action: action } }
}

function browserCommandValidate (step, templates) {
  function fail (error) { return { ok: false, error: error, help: { action: 'help', topic: step && step.action } } }
  if (!step || typeof step !== 'object' || Array.isArray(step)) return fail('Step must be an object')
  const action = step.action
  if (!Object.prototype.hasOwnProperty.call(browserCommandFields, action)) return fail('Unknown browser action: ' + action)
  const allowed = new Set((browserCommandFields[action] + ' action tabId timeout detail images taskId workspaceId outputDir stepName continueOnError').split(/\s+/))
  const numeric = new Set('nth targetNth x y targetX targetY moves clickCount holdMs amount ms timeout width height dpr referenceScale threshold maxMismatchRatio limit offset'.split(' '))
  const booleans = new Set('exact strict checked submit contains not load accept acceptDialog includeHidden mobile includeOverlay hideScrollbars freezeAnimations continueOnError'.split(' '))
  function template (value) { return templates && typeof value === 'string' && /\{\{\s*[\w.-]+\s*\}\}/.test(value) }
  for (const key of Object.keys(step)) {
    const value = step[key]
    if (!allowed.has(key)) return fail('Unknown field "' + key + '" for ' + action + '; use browser help for its fields')
    if (value === undefined || template(value)) continue
    if (numeric.has(key) && !Number.isFinite(value)) return fail(key + ' must be a finite number')
    if (booleans.has(key) && typeof value !== 'boolean') return fail(key + ' must be true or false')
    if (key === 'clip' || key === 'referenceClip') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(key + ' must be {x,y,width,height}')
      for (const field of ['x', 'y', 'width', 'height']) {
        if (!template(value[field]) && (!Number.isFinite(value[field]) || value[field] < 0 || (['width', 'height'].includes(field) && value[field] === 0))) return fail(key + '.' + field + ' must be ' + (field === 'x' || field === 'y' ? 'non-negative' : 'positive'))
      }
      if (Object.keys(value).some(function (field) { return !['x', 'y', 'width', 'height'].includes(field) })) return fail('Unknown rectangle field in ' + key)
    } else if (key !== 'expected' && !numeric.has(key) && !booleans.has(key) && !(value === null && ['tabId', 'taskId', 'workspaceId', 'outputDir'].includes(key)) && typeof value !== 'string') return fail(key + ' must be a string')
    else if (key === 'expected' && value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return fail('expected must be a string, number, boolean, or null')
  }
  function oneOf (key, values) {
    return step[key] === undefined || template(step[key]) || values.includes(step[key])
  }
  if (!oneOf('detail', ['compact', 'full'])) return fail('detail must be compact or full')
  if (!oneOf('images', ['auto', 'none', 'all'])) return fail('images must be auto, none, or all')
  if (!oneOf('direction', ['up', 'down', 'left', 'right', 'top', 'bottom'])) return fail('Unknown scroll direction')
  if (!oneOf('level', ['all', 'error', 'warning', 'info', 'debug'])) return fail('Unknown diagnostics level')
  if (!oneOf('button', ['left', 'right', 'middle'])) return fail('Unknown pointer button')
  const operations = { tabs: ['list', 'new', 'close', 'select', 'switch'], viewport: ['get', 'set', 'reset'], diagnostics: ['get', 'clear'] }
  if (operations[action] && !oneOf('operation', operations[action])) return fail('operation for ' + action + ' must be ' + operations[action].join(', '))
  for (const key of ['nth', 'targetNth', 'offset']) {
    if (step[key] !== undefined && !template(step[key]) && (!Number.isInteger(step[key]) || step[key] < 0 || (key !== 'offset' && step[key] > 99))) return fail(key + ' is out of range')
  }
  const limitMax = { read: 60000, find: 100, snapshot: 250, inspect: 30, diagnostics: 200 }[action] || 250
  if (step.limit !== undefined && !template(step.limit) && (!Number.isInteger(step.limit) || step.limit < (action === 'inspect' ? 0 : 1) || step.limit > limitMax)) return fail('limit is out of range')
  if (step.timeout !== undefined && !template(step.timeout) && (step.timeout < 0 || step.timeout > (action === 'wait' && step.load ? 60000 : 15000))) return fail('timeout is out of range')
  if (step.ms !== undefined && !template(step.ms) && (step.ms < 0 || step.ms > 60000)) return fail('ms must be 0–60000')
  for (const key of ['width', 'height']) {
    if (step[key] !== undefined && !template(step[key]) && (!Number.isInteger(step[key]) || step[key] < 1 || step[key] > 8192)) return fail(key + ' must be 1–8192 CSS pixels')
  }
  if (step.dpr !== undefined && !template(step.dpr) && (step.dpr < 0.5 || step.dpr > 4)) return fail('dpr must be 0.5–4')
  if (Number.isFinite(step.width) && Number.isFinite(step.height) && step.width * step.height * Math.pow(step.dpr || 1, 2) > 16 * 1024 * 1024) return fail('viewport exceeds 16 megapixels')
  for (const key of ['threshold', 'maxMismatchRatio']) {
    if (step[key] !== undefined && !template(step[key]) && (step[key] < 0 || step[key] > 1)) return fail(key + ' must be 0–1')
  }
  if (step.referenceScale !== undefined && !template(step.referenceScale) && (step.referenceScale <= 0 || step.referenceScale > 8)) return fail('referenceScale must be > 0 and <= 8')
  if (step.clickCount !== undefined && !template(step.clickCount) && ![1, 2].includes(step.clickCount)) return fail('clickCount must be 1 or 2')
  if (step.holdMs !== undefined && !template(step.holdMs) && (step.holdMs < 0 || step.holdMs > 10000)) return fail('holdMs must be 0–10000')
  if (step.moves !== undefined && !template(step.moves) && (!Number.isInteger(step.moves) || step.moves < 2 || step.moves > 40)) return fail('moves must be 2–40')
  const hasLocator = ['ref', 'selector', 'testId', 'label', 'placeholder', 'name', 'role', 'text'].some(function (key) { return key !== 'text' || action !== 'type' ? !!step[key] : false })
  const point = step.x != null && step.y != null
  if (['find', 'fill', 'type', 'check', 'focus', 'select', 'upload'].includes(action) && !hasLocator) return fail(action + ' needs a locator such as testId, label, or role+name')
  if (['click', 'dblclick', 'rightclick', 'hover', 'drag', 'inspect'].includes(action) && !hasLocator && !point) return fail(action + ' needs a locator or x/y')
  if (action === 'drag' && !step.targetRef && !step.targetSelector && !step.targetText && !step.targetRole && (step.targetX == null || step.targetY == null)) return fail('drag needs a target locator or targetX/targetY')
  if ((action === 'fill' || action === 'select') && step.value === undefined) return fail(action + ' needs value; empty string clears a field')
  if (action === 'type' && step.text === undefined) return fail('type needs text; prefer fill with value')
  if (action === 'press' && !step.key) return fail('press needs key, e.g. Enter, Tab, Control+a')
  if (action === 'navigate' && !step.url) return fail('navigate needs url')
  if (action === 'upload' && !step.path && !step.files) return fail('upload needs path or files')
  if (action === 'compare' && !step.referencePath) return fail('compare needs referencePath and the known referenceScale')
  if (['screenshot', 'compare'].includes(action) && step.clip && hasLocator) return fail('Use a locator or clip, not both')
  if (action === 'viewport' && (step.operation === 'set' || (!step.operation && (step.width != null || step.height != null))) && (step.width == null || step.height == null)) return fail('viewport set needs width and height')
  if (action === 'assert' || (action === 'wait' && step.ms === undefined && !step.load)) {
    const legacyText = step.text && !['selector', 'ref', 'role', 'label', 'testId', 'placeholder', 'name'].some(function (key) { return !!step[key] })
    const condition = step.condition || (legacyText ? 'text' : 'visible')
    const conditions = ['visible', 'hidden', 'attached', 'detached', 'text', 'value', 'checked', 'enabled', 'disabled', 'count', 'attribute', 'css', 'url', 'title', 'no-errors']
    if (!template(condition) && !conditions.includes(condition)) return fail('Unknown assertion condition: ' + condition)
    if (!template(condition) && !['url', 'title', 'no-errors'].includes(condition) && !hasLocator) return fail(condition + ' needs an element locator')
    if (['text', 'value', 'count', 'attribute', 'css', 'url', 'title'].includes(condition) && step.expected === undefined && !(step.text && !step.condition)) return fail(condition + ' needs expected')
    if (condition === 'attribute' && !step.attribute) return fail('attribute assertion needs attribute')
    if (condition === 'css' && !step.property) return fail('css assertion needs property')
    if (condition === 'count' && !template(step.expected) && (!Number.isInteger(step.expected) || step.expected < 0)) return fail('count expects a non-negative integer')
    if (condition === 'checked' && step.expected !== undefined && !template(step.expected) && typeof step.expected !== 'boolean') return fail('checked expects true or false')
    if (['text', 'value', 'css', 'url', 'title'].includes(condition) && step.expected !== undefined && typeof step.expected !== 'string') return fail(condition + ' expects a string')
    if (condition === 'attribute' && step.expected !== undefined && step.expected !== null && typeof step.expected !== 'string') return fail('attribute expects a string or null')
    if (condition === 'no-errors' && step.not) return fail('no-errors does not support not')
  }
  return { ok: true }
}

global.minBrowserCommands = { validate: browserCommandValidate, help: browserCommandHelp, fields: browserCommandFields }
