/* Slash-command helpers for the agent composer. Commands that match the
whole input are handled in the UI instead of being sent to the model. */

const COMMANDS = [
  { name: 'new', hint: 'Start a new chat', icon: 'codicon-add' },
  { name: 'compact', hint: 'Summarize older messages to free context', icon: 'codicon-fold' },
  { name: 'history', hint: 'Browse previous chats', icon: 'codicon-history' },
  { name: 'resume', hint: 'Browse previous chats', icon: 'codicon-history', action: 'history' },
  { name: 'model', hint: 'Switch model', icon: 'codicon-symbol-color' },
  { name: 'thinking', hint: 'Set thinking level', icon: 'codicon-lightbulb' },
  { name: 'name', hint: 'Name this chat', icon: 'codicon-tag', insert: true },
  { name: 'copy', hint: 'Copy last assistant reply', icon: 'codicon-copy' },
  { name: 'settings', hint: 'Open agent settings', icon: 'codicon-settings-gear' },
  { name: 'help', hint: 'List slash commands', icon: 'codicon-question' }
]

function findCommand (name) {
  const key = String(name || '').toLowerCase()
  for (let i = 0; i < COMMANDS.length; i++) {
    if (COMMANDS[i].name === key) return COMMANDS[i]
  }
  return null
}

function filterCommands (query) {
  const q = String(query || '').toLowerCase()
  const list = COMMANDS.slice()
  if (!q) return list
  return list.filter(function (cmd) {
    return cmd.name.indexOf(q) !== -1 ||
      (cmd.hint && cmd.hint.toLowerCase().indexOf(q) !== -1)
  }).sort(function (a, b) {
    const ap = a.name.indexOf(q) === 0 ? 0 : 1
    const bp = b.name.indexOf(q) === 0 ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.name.localeCompare(b.name)
  })
}

/* `/` plus an optional token at the start of the current line, with the
cursor still inside that token (no trailing space yet). */
function detect (text, cursor) {
  const value = String(text || '')
  const pos = Math.max(0, Math.min(value.length, cursor == null ? value.length : cursor))
  const lineStart = value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1
  const prefix = value.slice(lineStart, pos)
  const match = /^\/([a-zA-Z][\w-]*)?$/.exec(prefix)
  if (!match) return null
  return {
    query: match[1] || '',
    rangeStart: lineStart,
    rangeEnd: pos
  }
}

function parseSubmit (text) {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]+))?$/.exec(String(text || '').trim())
  if (!match) return null
  const command = findCommand(match[1])
  if (!command) return null
  return {
    command: command,
    arg: match[2] ? String(match[2]).trim() : ''
  }
}

function helpText () {
  return COMMANDS.map(function (cmd) {
    return '/' + cmd.name + ' — ' + cmd.hint
  }).join('\n')
}

module.exports = {
  COMMANDS: COMMANDS,
  detect: detect,
  filterCommands: filterCommands,
  findCommand: findCommand,
  helpText: helpText,
  parseSubmit: parseSubmit
}
