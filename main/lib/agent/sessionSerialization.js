/* Converts pi session events and history to the agent sidebar's plain JSON. */

function toolDetailFromInput (input) {
  if (!input) return ''
  if (typeof input === 'string') return input.slice(0, 140)
  if (input.action) {
    const extra = input.url || input.selector || input.ref || input.targetSelector || input.targetRef || input.operation || input.text || ''
    return extra ? (String(input.action) + ' ' + String(extra).slice(0, 100)) : String(input.action)
  }
  if (input.command) return String(input.command)
  if (input.path) return String(input.path)
  if (input.file_path) return String(input.file_path)
  if (input.filePath) return String(input.filePath)
  if (input.pattern) return String(input.pattern)
  if (input.url) return String(input.url)
  if (input.selector) return String(input.selector)
  if (input.ref) return String(input.ref)
  if (input.name && input.operation) return String(input.operation) + ' ' + String(input.name)
  if (input.operation) return String(input.operation)
  if (input.name) return String(input.name)
  if (input.text) return String(input.text).slice(0, 140)
  try {
    return JSON.stringify(input).slice(0, 140)
  } catch (e) {
    return ''
  }
}

function serializeToolEventDetail (event) {
  return toolDetailFromInput(event.args || event.input || event.toolInput || event.params)
}

function serializeAgentEvent (event) {
  switch (event.type) {
    case 'message_update': {
      const ev = event.assistantMessageEvent
      if (!ev) return null
      if (ev.type === 'text_delta') {
        return { type: 'delta', deltaType: 'text', delta: ev.delta }
      }
      if (ev.type === 'thinking_delta') {
        return { type: 'delta', deltaType: 'thinking', delta: ev.delta }
      }
      return null
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolName: event.toolName,
        detail: serializeToolEventDetail(event)
      }
    case 'tool_execution_end':
      return { type: 'tool_end', toolName: event.toolName, isError: !!event.isError }
    case 'agent_start':
      return { type: 'agent_start' }
    case 'agent_end':
      return { type: 'agent_end' }
    case 'auto_retry_start':
      return { type: 'status', message: 'Retrying…' }
    default:
      return null
  }
}

function serializeMessages (session) {
  const messages = []
  try {
    (session.messages || []).forEach(function (message) {
      if (message.role === 'user') {
        let text = ''
        if (typeof message.content === 'string') {
          text = message.content
        } else if (Array.isArray(message.content)) {
          text = message.content.filter(function (block) { return block.type === 'text' })
            .map(function (block) { return block.text }).join('\n')
        }
        if (text) messages.push({ role: 'user', text: text })
        return
      }
      if (message.role === 'compactionSummary') {
        messages.push({ role: 'compact', text: message.summary || '' })
        return
      }
      if (message.role !== 'assistant') return
      const tools = []
      let text = ''
      if (typeof message.content === 'string') {
        text = message.content
      } else if (Array.isArray(message.content)) {
        message.content.forEach(function (block) {
          if (block.type === 'text' && block.text) {
            text += (text ? '\n' : '') + block.text
          }
          if (block.type === 'tool_use' || block.type === 'toolCall' || block.type === 'functionCall') {
            tools.push({
              name: block.name || block.toolName || 'tool',
              status: 'done',
              detail: toolDetailFromInput(block.input || block.args)
            })
          }
        })
      }
      if (tools.length) messages.push({ role: 'tools', items: tools, expanded: false })
      if (text) messages.push({ role: 'assistant', text: text })
    })
  } catch (e) {}
  return messages
}

module.exports = {
  toolDetailFromInput: toolDetailFromInput,
  serializeToolEventDetail: serializeToolEventDetail,
  serializeAgentEvent: serializeAgentEvent,
  serializeMessages: serializeMessages
}
