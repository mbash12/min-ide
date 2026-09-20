/*
Wraps APIs that are only available in the main process in IPC messages, so that the BrowserWindow can use them
*/

ipc.handle('startFileDrag', function (e, path) {
  app.getFileIcon(path, {}).then(function (icon) {
    e.sender.startDrag({
      file: path,
      icon: icon
    })
  })
})

function showFocusModeDialog1 () {
  dialog.showMessageBox({
    type: 'info',
    buttons: [l('closeDialog')],
    message: l('isFocusMode'),
    detail: l('focusModeExplanation1') + ' ' + l('focusModeExplanation2')
  })
}

function showFocusModeDialog2 () {
  dialog.showMessageBox({
    type: 'info',
    buttons: [l('closeDialog')],
    message: l('isFocusMode'),
    detail: l('focusModeExplanation2')
  })
}

ipc.handle('showFocusModeDialog2', showFocusModeDialog2)

ipc.handle('showOpenDialog', async function (e, options) {
  const result = await dialog.showOpenDialog(windows.windowFromContents(e.sender).win, options)
  return result.filePaths
})

ipc.handle('showSaveDialog', async function (e, options) {
  const result = await dialog.showSaveDialog(windows.windowFromContents(e.sender).win, options)
  return result.filePath
})

ipc.handle('addWordToSpellCheckerDictionary', function (e, word) {
  session.fromPartition('persist:webcontent').addWordToSpellCheckerDictionary(word)
})

ipc.handle('clearStorageData', function (e, partitions = []) {
  // clear the shared session first
  return session.fromPartition('persist:webcontent').clearStorageData()
  /* It's important not to delete data from file:// from the default partition, since that would also remove internal browser data (such as bookmarks). However, HTTP data does need to be cleared, as there can be leftover data from loading external resources in the browser UI */
    .then(function () {
      return session.defaultSession.clearStorageData({ origin: 'http://' })
    })
    .then(function () {
      return session.defaultSession.clearStorageData({ origin: 'https://' })
    })
    .then(function () {
      return session.fromPartition('persist:webcontent').clearCache()
    })
    .then(function () {
      return session.fromPartition('persist:webcontent').clearHostResolverCache()
    })
    .then(function () {
      return session.fromPartition('persist:webcontent').clearAuthCache()
    })
    .then(function () {
      return session.defaultSession.clearCache()
    })
    .then(function () {
      return session.defaultSession.clearHostResolverCache()
    })
    .then(function () {
      return session.defaultSession.clearAuthCache()
    })
    // also clear any workspace profile sessions
    .then(function () {
      return Promise.all(partitions.map(function (partition) {
        if (partition === 'persist:webcontent') {
          return Promise.resolve()
        }
        return session.fromPartition(partition).clearStorageData()
      }))
    })
})

/* Per-profile data clearing (Pro Settings > Profiles > Clear Data). The
renderer picks the partition - 'persist:webcontent' for the default profile,
'persist:profile-<id>' otherwise - and which data types to wipe. Only session
partitions are accepted; internal UI storage is never a target. */
ipc.handle('clearProfileData', function (e, args) {
  const partition = args && args.partition
  const types = (args && args.types) || {}
  if (partition !== 'persist:webcontent' && !/^persist:profile-[\w-]+$/.test(String(partition))) {
    return Promise.resolve(false)
  }
  const ses = session.fromPartition(partition)
  const tasks = []
  if (types.siteData) {
    // cookies, localStorage, IndexedDB, service workers, cache storage, etc.
    tasks.push(ses.clearStorageData())
    if (partition === 'persist:webcontent') {
      /* same leftover handling as clearStorageData: http(s) data for the
      default profile also lives in the default session */
      tasks.push(session.defaultSession.clearStorageData({ origin: 'http://' }))
      tasks.push(session.defaultSession.clearStorageData({ origin: 'https://' }))
    }
  }
  if (types.cache) {
    tasks.push(ses.clearCache())
    tasks.push(ses.clearHostResolverCache())
    tasks.push(ses.clearAuthCache())
  }
  if (!tasks.length) {
    return Promise.resolve(false)
  }
  return Promise.all(tasks).then(function () { return true })
})

/* window actions */

ipc.handle('minimize', function (e) {
  windows.windowFromContents(e.sender).win.minimize()
  // workaround for https://github.com/minbrowser/min/issues/1662
  e.sender.send('minimize')
})

ipc.handle('maximize', function (e) {
  windows.windowFromContents(e.sender).win.maximize()
  // workaround for https://github.com/minbrowser/min/issues/1662
  e.sender.send('maximize')
})

ipc.handle('unmaximize', function (e) {
  windows.windowFromContents(e.sender).win.unmaximize()
  // workaround for https://github.com/minbrowser/min/issues/1662
  e.sender.send('unmaximize')
})

ipc.handle('close', function (e) {
  windows.windowFromContents(e.sender).win.close()
})

ipc.handle('setFullScreen', function (e, fullScreen) {
  windows.windowFromContents(e.sender).win.setFullScreen(e, fullScreen)
})

// workaround for https://github.com/electron/electron/issues/38540
ipc.handle('showItemInFolder', function (e, path) {
  shell.showItemInFolder(path)
})

ipc.on('newWindow', function (e, customArgs) {
  createWindow(customArgs)
})
