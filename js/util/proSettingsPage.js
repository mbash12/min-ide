/* Opens the Pro Settings page (min://proSettings), keeping a single such
tab per workspace: triggering it again focuses the existing tab instead of
opening another one.

A dedicated new tab (never webviews.update on an unrelated current tab) is
required for the first open because the view's storage partition is decided
when its view is created, and this page needs the default session so its
localStorage matches the rest of the UI. */

const browserUI = require('browserUI.js')
const webviews = require('webviews.js')
const urlParser = require('util/urlParser.js')

const PRO_SETTINGS_URL = urlParser.parse('min://proSettings')

/* the tab's stored url becomes the full form once the page loads */
function isProSettingsURL (url) {
  if (!url) return false
  const source = urlParser.getSourceURL(url)
  return source === 'min://proSettings' || source.startsWith('min://proSettings?') ||
         url === PRO_SETTINGS_URL || url.startsWith(PRO_SETTINGS_URL + '?') ||
         url === 'min://proSettings' || url.startsWith('min://proSettings?')
}

function open (targetUrl) {
  const target = targetUrl || 'min://proSettings'
  const task = tasks.getSelected()
  let existingTabId = null

  if (task && task.tabs) {
    /* forEach iterates the raw tab objects (not ids) */
    task.tabs.forEach(function (tab) {
      if (!existingTabId && tab && isProSettingsURL(tab.url)) {
        existingTabId = tab.id
      }
    })
  }

  if (existingTabId) {
    /* follow deep links (e.g. ?tab=profiles) even when reusing the tab:
    the view already runs in the default session, so updating its url is
    safe here */
    if (task.tabs.get(existingTabId).url !== urlParser.parse(target)) {
      webviews.update(existingTabId, target)
    }
    task.tabs.setSelected(existingTabId)
    return existingTabId
  }

  const newTab = tabs.add({ url: target })
  browserUI.addTab(newTab, { enterEditMode: false })
  return newTab
}

module.exports = { open: open, isProSettingsURL: isProSettingsURL }
