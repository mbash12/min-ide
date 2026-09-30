const path = require('path')
const fs = require('fs')

const outFile = path.resolve(__dirname, '../dist/bundle.css')

const modules = [
  'css/base.css',
  'css/windowControls.css',
  'css/modal.css',
  'css/tabBar.css',
  'css/tabEditor.css',
  'css/taskOverlay.css',
  'css/workspaceDrawer.css',
  // One ordered stylesheet group: keep existing cascade and override order.
  // See css/sidebar/README.md for ownership of these modules.
  [
    'css/sidebar/layout.css',
    'css/sidebar/contentPanels.css',
    'css/sidebar/git.css',
    'css/sidebar/playbook.css',
    'css/sidebar/gitSections.css',
    'css/sidebar/agentMessages.css',
    'css/sidebar/agentComposer.css',
    'css/sidebar/components.css',
    'css/sidebar/gitLayout.css',
    'css/sidebar/overlays.css',
    'css/sidebar/design.css',
    'css/sidebar/designBuildQueue.css',
    'css/sidebar/typography.css'
  ],
  'css/webviews.css',
  'css/newTabPage.css',
  'css/searchbar.css',
  'css/listItem.css',
  'css/bookmarkManager.css',
  'css/findinpage.css',
  'css/downloadManager.css',
  'css/passwordManager.css',
  'css/passwordCapture.css',
  'css/passwordViewer.css',
  'node_modules/dragula/dist/dragula.min.css'
]

// Keep the original empty lines at sidebar fragment boundaries while source
// modules themselves end with a single newline. This preserves the bundle.
const sidebarBlankLinesAfter = [true, false, true, true, true, true, true, true, false, true, true, true, false]

function buildBrowserStyles () {
  /* concatenate modules */
  let output = ''
  modules.forEach(function (entry) {
    const files = Array.isArray(entry) ? entry : [entry]
    if (Array.isArray(entry)) {
      output += files.map(function (file, index) {
        const css = fs.readFileSync(path.resolve(__dirname, '../', file), 'utf-8')
        return css + (sidebarBlankLinesAfter[index] ? '\n' : '')
      }).join('') + '\n'
    } else {
      output += fs.readFileSync(path.resolve(__dirname, '../', entry), 'utf-8') + '\n'
    }
  })

  fs.writeFileSync(outFile, output, 'utf-8')
}

if (module.parent) {
  module.exports = buildBrowserStyles
} else {
  buildBrowserStyles()
}
