const browserify = require('browserify')
const renderify = require('electron-renderify')
const path = require('path')
const fs = require('fs')
const { pipeline } = require('stream/promises')
const createBuildQueue = require('./lib/buildQueue.js')

const rootDir = path.resolve(__dirname, '../')
const jsDir = path.resolve(__dirname, '../js')

const intermediateOutput = path.resolve(__dirname, '../dist/build.js')
const outFile = path.resolve(__dirname, '../dist/bundle.js')

const fileList = [
  'dist/localization.build.js',
  'js/default.js'
]

const buildBrowser = createBuildQueue(async function () {
  // build localization support first, since it is included in the browser bundle
  require('./buildLocalization.js')()

  /* concatenate legacy modules */
  let output = ''
  fileList.forEach(function (script) {
    output += fs.readFileSync(path.resolve(__dirname, '../', script)) + ';\n'
  })

  fs.writeFileSync(intermediateOutput, output, 'utf-8')

  const instance = browserify(intermediateOutput, {
    paths: [rootDir, jsDir],
    ignoreMissing: false,
    node: true,
    detectGlobals: false
  })

  instance.exclude('chokidar')
  instance.exclude('write-file-atomic')

  instance.transform(renderify)
  const temporaryOutput = outFile + '.' + process.pid + '.tmp'
  try {
    await pipeline(instance.bundle(), fs.createWriteStream(temporaryOutput, { encoding: 'utf-8' }))
    await fs.promises.rename(temporaryOutput, outFile)
  } finally {
    await fs.promises.rm(temporaryOutput, { force: true })
  }
})

if (module.parent) {
  module.exports = buildBrowser
} else {
  buildBrowser().catch(function (error) {
    console.error('Error while building browser:', error.message)
    process.exitCode = 1
  })
}
