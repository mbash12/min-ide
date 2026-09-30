/* Versioned atomic writer for the legacy JSON session backup. Async writes
   stage to unique files, then promote only if no newer save has superseded
   them. A synchronous unload save advances the version before writing, so a
   completed older async stage can never replace it afterward. */

module.exports = function createSessionBackup (options) {
  var fs = options.fs
  var path = options.path
  var userDataPath = options.userDataPath
  var writeFileAtomic = options.writeFileAtomic
  var process = options.process || global.process
  var now = options.now || Date.now
  var random = options.random || Math.random
  var logger = options.logger || console
  var backupPath = path.join(userDataPath, 'sessionRestore.json')
  var writerId = String(process.pid) + '-' + String(now()) + '-' + String(Math.floor(random() * 1000000))
  var generation = 0

  function removeStage (stagePath) {
    try { fs.unlinkSync(stagePath) } catch (error) {
      if (error && error.code !== 'ENOENT') logger.warn('[dbService] could not remove stale session backup:', error)
    }
  }

  function serialize (data) {
    return JSON.stringify(data)
  }

  function writeOptions () {
    try {
      var stats = fs.statSync(backupPath)
      var options = { mode: stats.mode }
      if (process.getuid) options.chown = { uid: stats.uid, gid: stats.gid }
      return options
    } catch (error) {
      return {}
    }
  }

  function saveSync (data) {
    generation++
    writeFileAtomic.sync(backupPath, serialize(data), {})
    return true
  }

  function save (data) {
    var version = ++generation
    var stagePath = backupPath + '.pending-' + writerId + '-' + version
    var content = serialize(data)
    var options = writeOptions()
    return new Promise(function (resolve) {
      writeFileAtomic(stagePath, content, options, function (error) {
        if (error) {
          removeStage(stagePath)
          logger.warn('[dbService] failed to write session backup:', error)
          resolve({ ok: false, error: error.message || String(error) })
          return
        }
        if (version !== generation) {
          removeStage(stagePath)
          resolve({ ok: true, superseded: true })
          return
        }
        try {
          try {
            fs.renameSync(stagePath, backupPath)
          } catch (renameError) {
            // Some Windows filesystems do not replace an existing destination
            // with rename. The package's sync path performs its own atomic swap.
            writeFileAtomic.sync(backupPath, content, {})
            removeStage(stagePath)
          }
          resolve({ ok: true })
        } catch (promoteError) {
          removeStage(stagePath)
          logger.warn('[dbService] failed to promote session backup:', promoteError)
          resolve({ ok: false, error: promoteError.message || String(promoteError) })
        }
      })
    })
  }

  return { path: backupPath, save: save, saveSync: saveSync }
}
