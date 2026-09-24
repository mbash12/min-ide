/* Loopback OAuth callback listener extracted from the provider orchestrator
   so its lifetime and cleanup rules stay in one small module. */

module.exports = function createLoopbackCallbackServer (http) {
  const OAUTH_SUCCESS_HTML = '<!doctype html><html><body style="font-family:system-ui;text-align:center;padding-top:4em"><h2>Sign-in complete</h2><p>You can close this tab and return to Min.</p></body></html>'
  const OAUTH_ERROR_HTML = '<!doctype html><html><body style="font-family:system-ui;text-align:center;padding-top:4em"><h2>Sign-in failed</h2><p>Return to Min and try again.</p></body></html>'

  /* Listens on the spec'd loopback port until the provider redirects the user's
  browser back with ?code&state. Resolves {code,state}; rejects on timeout,
  abort, or bind failure. `server` is exposed so callers can stop it early. */
  return function oauthStartCallbackServer (spec, signal) {
    return new Promise(function (resolve, reject) {
      let settled = false
      const server = http.createServer(function (req, res) {
        let url
        try {
          url = new URL(req.url, 'http://' + (spec.hostname || '127.0.0.1'))
        } catch (e) {
          res.statusCode = 400
          res.end(OAUTH_ERROR_HTML)
          return
        }
        if (url.pathname !== spec.path) {
          res.statusCode = 404
          res.end(OAUTH_ERROR_HTML)
          return
        }
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.setHeader('Content-Type', 'text/html')
        if (error || !code) {
          res.statusCode = 400
          res.end(OAUTH_ERROR_HTML)
          finish(new Error('OAuth callback error: ' + (error || 'missing code')))
          return
        }
        res.end(OAUTH_SUCCESS_HTML)
        finish(null, { code: code, state: url.searchParams.get('state') || undefined })
      })

      function finish (err, value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        try { server.close() } catch (e) {}
        if (err) reject(err)
        else resolve(value)
      }

      function onAbort () {
        finish(new Error('Login cancelled'))
      }

      const timer = setTimeout(function () {
        finish(new Error('OAuth callback timed out'))
      }, spec.timeoutMs || 5 * 60 * 1000)

      server.on('error', function (err) {
        finish(err)
      })
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      if (!settled) server.listen(spec.port, spec.hostname || '127.0.0.1')
    })
  }
}
