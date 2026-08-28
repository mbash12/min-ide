/* global l */
const modal = document.getElementById('app-prompt-modal')
const backdrop = document.getElementById('sidebar-prompt-backdrop')
const titleEl = document.getElementById('app-prompt-title')
const messageEl = document.getElementById('app-prompt-message')
const fieldEl = document.getElementById('app-prompt-field')
const labelEl = document.getElementById('app-prompt-label')
const inputEl = document.getElementById('app-prompt-input')
const okBtn = document.getElementById('app-prompt-ok')
const cancelBtn = document.getElementById('app-prompt-cancel')
const closeBtn = document.getElementById('app-prompt-close')

let pending = null
let ready = false

function setOpen (open) {
  modal.hidden = !open
  if (backdrop) backdrop.hidden = !open
}

function finish (value) {
  if (!pending) return
  const resolve = pending
  pending = null
  setOpen(false)
  resolve(value)
}

function cancelledValue () {
  return modal.dataset.kind === 'confirm' ? false : null
}

function bindOnce () {
  if (ready || !modal) return
  ready = true

  okBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (modal.dataset.kind === 'confirm') {
      finish(true)
      return
    }
    finish(inputEl.value)
  })
  cancelBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    finish(cancelledValue())
  })
  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    finish(cancelledValue())
  })
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(inputEl.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(null)
    }
  })
  modal.addEventListener('click', function (e) {
    e.stopPropagation()
  })
  modal.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    e.preventDefault()
    finish(cancelledValue())
  })
  if (backdrop) {
    backdrop.addEventListener('click', function (e) {
      e.stopPropagation()
      finish(cancelledValue())
    })
  }
}

function openModal (options) {
  options = options || {}
  bindOnce()
  return new Promise(function (resolve) {
    if (pending) finish(cancelledValue())
    pending = resolve

    const kind = options.kind === 'confirm' ? 'confirm' : 'prompt'
    modal.dataset.kind = kind
    titleEl.textContent = options.title || ''
    if (options.message) {
      messageEl.textContent = options.message
      messageEl.hidden = false
    } else {
      messageEl.textContent = ''
      messageEl.hidden = true
    }
    fieldEl.hidden = kind !== 'prompt'
    labelEl.textContent = options.label || ''
    inputEl.value = options.value || ''
    inputEl.placeholder = options.placeholder || ''
    okBtn.textContent = options.ok || l('dialogConfirmButton') || 'OK'
    cancelBtn.textContent = options.cancel || l('dialogSkipButton') || 'Cancel'

    setOpen(false)

    setTimeout(function () {
      if (pending !== resolve) return
      setOpen(true)
      if (kind === 'prompt') {
        inputEl.focus()
        inputEl.select()
      } else {
        okBtn.focus()
      }
    }, 0)
  })
}

const promptModal = {
  initialize: bindOnce,
  prompt: function (options) {
    return openModal(Object.assign({}, options, { kind: 'prompt' })).then(function (value) {
      if (value == null) return null
      const name = String(value).trim()
      return name || null
    })
  },
  confirm: function (options) {
    return openModal(Object.assign({}, options, { kind: 'confirm' })).then(function (value) {
      return value === true
    })
  }
}

module.exports = promptModal
