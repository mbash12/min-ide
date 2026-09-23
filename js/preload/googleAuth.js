/* global electron, ipc, Navigator */

// Keep navigator in sync with the request headers when a server redirects into
// Google sign-in. Changing WebContents' UA at that point would restart the load
// and can discard an OAuth callback or interrupt a pending 2FA challenge.
const pageUserAgent = ipc.sendSync('getPageUserAgent')
if (pageUserAgent && (pageUserAgent !== navigator.userAgent || /Firefox\//.test(pageUserAgent))) {
  electron.contextBridge.executeInMainWorld({
    func: function (userAgent) {
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: function () { return userAgent },
        configurable: true
      })
      Object.defineProperty(Navigator.prototype, 'appVersion', {
        get: function () { return userAgent.replace(/^Mozilla\//, '') },
        configurable: true
      })
      // Firefox does not expose Chromium's user-agent client hints.
      if (/Firefox\//.test(userAgent)) {
        delete Navigator.prototype.userAgentData
      }
    },
    args: [pageUserAgent]
  })
}
