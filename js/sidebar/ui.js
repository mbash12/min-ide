/* Small DOM helpers shared by sidebar panels. Keeping these helpers focused on
 * structure makes panel-specific behavior stay in each panel module. */

function createIconButton (options) {
  options = options || {}
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'sidebar-icon-button codicon ' + (options.icon || '')
  if (options.small) button.classList.add('small')
  if (options.label) {
    button.title = options.label
    button.setAttribute('aria-label', options.label)
  }
  button.disabled = !!options.disabled
  if (options.onClick) button.addEventListener('click', options.onClick)
  return button
}

function createPanelHeader (options) {
  options = options || {}
  const header = document.createElement('div')
  header.className = 'sidebar-panel-header' + (options.className ? ' ' + options.className : '')

  const title = document.createElement('div')
  title.className = 'sidebar-panel-title'
  title.textContent = options.title || ''
  header.appendChild(title)

  const actions = document.createElement('div')
  actions.className = 'sidebar-panel-header-actions'
  ;(options.actions || []).forEach(function (action) {
    actions.appendChild(createIconButton(action))
  })
  header.appendChild(actions)
  return header
}

function createEmptyState (options) {
  options = options || {}
  const state = document.createElement('div')
  state.className = 'sidebar-empty-state' + (options.className ? ' ' + options.className : '')

  if (options.icon) {
    const icon = document.createElement('i')
    icon.className = 'sidebar-empty-icon codicon ' + options.icon
    icon.setAttribute('aria-hidden', 'true')
    state.appendChild(icon)
  }

  const message = document.createElement('div')
  message.className = 'sidebar-empty-message'
  message.textContent = options.message || ''
  state.appendChild(message)

  if (options.actionLabel && options.onAction) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sidebar-button primary'
    button.textContent = options.actionLabel
    button.disabled = !!options.actionDisabled
    button.addEventListener('click', options.onAction)
    state.appendChild(button)
  }
  return state
}

module.exports = {
  createEmptyState,
  createIconButton,
  createPanelHeader
}
