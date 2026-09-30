/* Opens the app database without mistaking a transient access error for
   corruption. The SQLite, filesystem, and logging dependencies are injected
   so lifecycle behavior can be exercised against temporary databases. */

module.exports = function createDatabaseLifecycle (deps) {
  var DatabaseSync = deps.DatabaseSync
  var fs = deps.fs
  var logger = deps.logger || console
  var now = deps.now || Date.now
  var random = deps.random || Math.random
  var snapshotCounter = 0

  function baseSqliteCode (error) {
    var errcode = Number(error && error.errcode)
    return Number.isFinite(errcode) ? (errcode & 0xff) : null
  }

  function isCorruptionError (error) {
    var code = baseSqliteCode(error)
    if (code === 11 || code === 26) return true // SQLITE_CORRUPT / SQLITE_NOTADB
    return /database disk image is malformed|file is not a database/i.test(String((error && (error.errstr || error.message)) || ''))
  }

  function closeHandle (handle) {
    if (!handle) return
    try { handle.close() } catch (error) {
      logger.warn('[dbService] could not close failed database handle:', error)
    }
  }

  function configure (handle) {
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA synchronous = NORMAL')
    return handle
  }

  function existingFiles (dbPath) {
    var files = [dbPath, dbPath + '-wal', dbPath + '-shm']
    return files.filter(function (file) {
      try {
        fs.statSync(file)
        return true
      } catch (error) {
        if (error && error.code === 'ENOENT') return false
        throw error
      }
    })
  }

  function snapshotCompanions (dbPath) {
    var snapshots = []
    ;['-wal', '-shm'].forEach(function (suffix) {
      var source = dbPath + suffix
      var temporary = source + '.opening-' + now() + '-' + Math.floor(random() * 1000000) + '-' + (++snapshotCounter)
      try {
        fs.copyFileSync(source, temporary)
        snapshots.push({ source: source, temporary: temporary })
      } catch (error) {
        if (error && error.code === 'ENOENT') return
        snapshots.forEach(function (snapshot) {
          try { fs.unlinkSync(snapshot.temporary) } catch (cleanupError) {}
        })
        throw error
      }
    })
    return snapshots
  }

  function discardSnapshots (snapshots) {
    snapshots.forEach(function (snapshot) {
      try { fs.unlinkSync(snapshot.temporary) } catch (error) {
        if (error && error.code !== 'ENOENT') logger.warn('[dbService] could not remove database sidecar snapshot:', error)
      }
    })
  }

  function restoreSnapshots (snapshots) {
    var restored = true
    snapshots.forEach(function (snapshot) {
      try {
        try { fs.unlinkSync(snapshot.source) } catch (error) {
          if (error && error.code !== 'ENOENT') throw error
        }
        fs.renameSync(snapshot.temporary, snapshot.source)
      } catch (error) {
        restored = false
        logger.error('[dbService] could not restore database sidecar before quarantine:', error)
      }
    })
    return restored
  }

  function quarantineDatabaseFiles (dbPath) {
    var files = existingFiles(dbPath)
    if (files.indexOf(dbPath) === -1) return null
    var suffix = '.corrupt-' + now() + '-' + Math.floor(random() * 1000000)
    var moves = files.map(function (source) {
      return { source: source, destination: source + suffix }
    })
    for (var i = 0; moves.some(function (move) { return fs.existsSync(move.destination) }); i++) {
      suffix = '.corrupt-' + now() + '-' + Math.floor(random() * 1000000) + '-' + i
      moves = files.map(function (source) {
        return { source: source, destination: source + suffix }
      })
    }

    var moved = []
    try {
      moves.forEach(function (move) {
        fs.renameSync(move.source, move.destination)
        moved.push(move)
      })
    } catch (error) {
      moved.reverse().forEach(function (move) {
        try { fs.renameSync(move.destination, move.source) } catch (rollbackError) {
          logger.error('[dbService] could not restore database companion file:', rollbackError)
        }
      })
      throw error
    }
    return moves.map(function (move) { return move.destination })
  }

  function inMemoryFallback (cause) {
    try {
      var handle = new DatabaseSync(':memory:')
      logger.warn('[dbService] using in-memory database; changes will not persist')
      return handle
    } catch (error) {
      logger.error('[dbService] failed to open in-memory database:', error, cause || '')
      return null
    }
  }

  function openDatabase (dbPath) {
    var handle
    var snapshots = []
    try {
      snapshots = snapshotCompanions(dbPath)
      handle = new DatabaseSync(dbPath)
      configure(handle)
      discardSnapshots(snapshots)
      return handle
    } catch (error) {
      closeHandle(handle)
      logger.error('[dbService] failed to open database:', error)
      if (!isCorruptionError(error)) {
        discardSnapshots(snapshots)
        return inMemoryFallback(error)
      }
    }

    if (!restoreSnapshots(snapshots)) return inMemoryFallback()
    try {
      var quarantined = quarantineDatabaseFiles(dbPath)
      if (!quarantined) return inMemoryFallback()
      logger.warn('[dbService] quarantined corrupt database files to', quarantined)
      handle = new DatabaseSync(dbPath)
      configure(handle)
      return handle
    } catch (retryError) {
      closeHandle(handle)
      logger.error('[dbService] retry after corruption quarantine failed:', retryError)
      return inMemoryFallback(retryError)
    }
  }

  return {
    openDatabase: openDatabase,
    isCorruptionError: isCorruptionError,
    quarantineDatabaseFiles: quarantineDatabaseFiles
  }
}
