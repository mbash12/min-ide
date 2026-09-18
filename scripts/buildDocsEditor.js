const browserify = require('browserify')
const fs = require('fs')
const path = require('path')

const entryFile = path.resolve(__dirname, '../pages/docs/editorBundle.js')
const outFile = path.resolve(__dirname, '../dist/docs-editor.js')
const output = fs.createWriteStream(outFile)

browserify(entryFile)
  .bundle()
  .on('error', function (err) {
    console.error(err)
    process.exitCode = 1
  })
  .pipe(output)
