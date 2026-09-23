/* global app, settings, session, ipc */

/* Use the same user agent as Chrome to improve site compatibility and increase fingerprinting resistance
see https://github.com/minbrowser/min/issues/657 for more information */

const defaultUserAgent = app.userAgentFallback
let hasCustomUserAgent = false
let newUserAgent

if (settings.get('customUserAgent')) {
  newUserAgent = settings.get('customUserAgent')
  hasCustomUserAgent = true
} else {
  newUserAgent = defaultUserAgent.replace(/Min\/\S+\s/, '').replace(/Electron\/\S+\s/, '').replace(process.versions.chrome, process.versions.chrome.split('.').map((v, idx) => (idx === 0) ? v : '0').join('.'))
}
app.userAgentFallback = newUserAgent

function getFirefoxUA () {
  const rootUAs = {
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:FXVERSION.0) Gecko/20100101 Firefox/FXVERSION.0',
    windows: 'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:FXVERSION.0) Gecko/20100101 Firefox/FXVERSION.0',
    linux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:FXVERSION.0) Gecko/20100101 Firefox/FXVERSION.0'
  }

  let rootUA
  if (process.platform === 'win32') {
    rootUA = rootUAs.windows
  } else if (process.platform === 'darwin') {
    rootUA = rootUAs.mac
  } else {
    // 'aix', 'freebsd', 'linux', 'openbsd', 'sunos'
    rootUA = rootUAs.linux
  }

  /*
  Guess at an appropriate Firefox version to use in the UA.
  We want a recent version (ideally the latest), but not a version that hasn't been released yet.
  New releases are every ~4 weeks, with some delays for holidays. So assume 4.1 weeks, and estimate
  starting from v91 on 2021-08-10
  */

  const fxVersion = 91 + Math.floor((Date.now() - 1628553600000) / (4.1 * 7 * 24 * 60 * 60 * 1000))

  return rootUA.replace(/FXVERSION/g, fxVersion)
}

function isGoogleAccountURL (urlStr) {
  if (!urlStr) return false
  try {
    const url = new URL(urlStr)
    return (url.protocol === 'https:' || url.protocol === 'http:') && (
      url.hostname === 'accounts.google.com' ||
      url.hostname.endsWith('.accounts.google.com') ||
      url.hostname === 'accounts.youtube.com'
    )
  } catch (e) {
    return false
  }
}

// Keep the same identity for the lifetime of the browser, even during a long
// running sign-in or 2FA challenge.
const googleAccountUserAgent = getFirefoxUA()
const pageUserAgents = new WeakMap()

function getPageUserAgent (contents, frameURL) {
  if (hasCustomUserAgent) return null
  if (isGoogleAccountURL(frameURL)) return googleAccountUserAgent
  return pageUserAgents.get(contents) || contents.getUserAgent()
}

// A redirect cannot safely call setUserAgent: Chromium can reload the pending
// navigation. The preload applies the selected identity before page scripts run
// instead, including Google sign-in frames embedded in a third-party page.
ipc.on('getPageUserAgent', function (event) {
  event.returnValue = getPageUserAgent(event.sender, event.senderFrame?.url)
})

/*
Google blocks signin in some cases unless a custom UA is used
see https://github.com/minbrowser/min/issues/868
*/
function enableGoogleUASwitcher (ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const isGoogle = !hasCustomUserAgent && isGoogleAccountURL(details.url)
    const uaHeader = Object.keys(details.requestHeaders).find(key => key.toLowerCase() === 'user-agent') || 'User-Agent'
    let currentUA = details.requestHeaders[uaHeader] || ''

    if (isGoogle) {
      currentUA = googleAccountUserAgent
    } else if (!hasCustomUserAgent && details.webContents && !details.webContents.isDestroyed()) {
      currentUA = getPageUserAgent(details.webContents, details.frame?.url)
    }
    details.requestHeaders[uaHeader] = currentUA

    const isFirefox = /Firefox\/\S+/i.test(currentUA)

    // Header names are case insensitive; remove existing variants before
    // setting replacements so Chromium hints cannot coexist with Firefox.
    for (const key of Object.keys(details.requestHeaders)) {
      const name = key.toLowerCase()
      if ((isFirefox && name.startsWith('sec-ch-')) || name === 'sec-ch-ua' || name === 'sec-ch-ua-mobile') {
        delete details.requestHeaders[key]
      }
    }
    if (!isFirefox) {
      const chromiumVersion = process.versions.chrome.split('.')[0]
      details.requestHeaders['SEC-CH-UA'] = `"Chromium";v="${chromiumVersion}", " Not A;Brand";v="99"`
      details.requestHeaders['SEC-CH-UA-MOBILE'] = '?0'
    }

    callback({ cancel: false, requestHeaders: details.requestHeaders })
  })
}

function applyUAForURL (webContents, urlStr, isRedirect = false) {
  if (hasCustomUserAgent || !webContents || webContents.isDestroyed()) return
  if (!urlStr || (!urlStr.startsWith('http://') && !urlStr.startsWith('https://'))) return

  const currentUA = getPageUserAgent(webContents)
  // Do not switch back midway through Google's cookie checks or OAuth
  // redirects. Restore the default on the next navigation away from the flow.
  const keepGoogleUA = currentUA === googleAccountUserAgent &&
    (isRedirect || isGoogleAccountURL(webContents.getURL()))
  const userAgent = (isGoogleAccountURL(urlStr) || keepGoogleUA) ? googleAccountUserAgent : newUserAgent
  pageUserAgents.set(webContents, userAgent)
  if (!isRedirect && webContents.getUserAgent() !== userAgent) {
    webContents.setUserAgent(userAgent)
  }
}

app.on('web-contents-created', function (event, contents) {
  contents.on('will-redirect', function (e, url, isInPlace, isMainFrame) {
    // Redirects from iframes must never change the main document's UA. Google
    // uses these frames while a 2FA challenge is still waiting for approval.
    if ((e.isMainFrame ?? isMainFrame) && !(e.isSameDocument ?? isInPlace)) {
      applyUAForURL(contents, e.url || url, true)
    }
  })
  contents.on('did-start-navigation', function (e, url, isInPlace, isMainFrame) {
    if ((e.isMainFrame ?? isMainFrame) && !(e.isSameDocument ?? isInPlace)) {
      applyUAForURL(contents, e.url || url)
    }
  })
})

app.once('ready', function () {
  enableGoogleUASwitcher(session.defaultSession)
})

app.on('session-created', enableGoogleUASwitcher)
