const chokidar = require('chokidar')
const path = require('path')

const mainDir = path.resolve(__dirname, '../main')
const jsDir = path.resolve(__dirname, '../js')
const preloadDir = path.resolve(__dirname, '../js/preload')
const browserStylesDir = path.resolve(__dirname, '../css')

const buildMain = require('./buildMain.js')
const buildBrowser = require('./buildBrowser.js')
const buildPreload = require('./buildPreload.js')
const buildBrowserStyles = require('./buildBrowserStyles.js')
const createBuildQueue = require('./lib/buildQueue.js')

function watchBuild (paths, name, build, options = {}) {
  const run = createBuildQueue(async function () {
    console.log('rebuilding ' + name)
    await build()
  })
  chokidar.watch(paths, Object.assign({ ignoreInitial: true }, options)).on('all', function (event) {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return
    run().catch(error => console.error('Failed to build ' + name, error.message))
  })
}

const settingsPreload = path.join(jsDir, 'util/settings/settingsPreload.js')
watchBuild(mainDir, 'main', buildMain)
watchBuild(jsDir, 'browser', buildBrowser, { ignored: [preloadDir, settingsPreload] })
watchBuild([preloadDir, settingsPreload], 'preload script', buildPreload)
watchBuild(browserStylesDir, 'browser styles', buildBrowserStyles)
