const ProcessSpawner = require('util/process.js')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const papaparse = require('papaparse')

const browserUI = require('browserUI.js')

// Proton Pass password manager, backed by the official pass-cli tool.
// Unlike Bitwarden/1Password, pass-cli keeps its authenticated session in the
// OS keyring, so there is no session key to pass around - "unlocking" means
// verifying the session (and supplying the session lock code if the user
// configured one).
class ProtonPass {
  constructor () {
    this.authenticated = false
    this.lastCallList = {}
    this.defaultShareId = null
    this.name = 'Proton Pass'
    /* _getLoginItems decrypts every item in every vault, so results are
    cached briefly and in-flight calls are shared between consumers. */
    this.itemsCache = null
    this.itemsCacheTime = 0
    this.itemsInFlight = null
  }

  getDownloadLink () {
    switch (window.platformType) {
      case 'mac':
        return 'https://github.com/protonpass/pass-cli/releases/latest'
      case 'windows':
        return 'https://github.com/protonpass/pass-cli/releases/latest'
      case 'linux':
        return 'https://github.com/protonpass/pass-cli/releases/latest'
    }
  }

  getLocalPath () {
    return path.join(window.globalArgs['user-data-path'], 'tools', (platformType === 'windows' ? 'pass-cli.exe' : 'pass-cli'))
  }

  getSetupMode () {
    return 'dragdrop'
  }

  // Returns a pass-cli tool path by checking possible locations.
  // First it checks if the tool was installed for Min specifically
  // by checking the settings value. If that is not set or doesn't point
  // to a valid executable, it checks if 'pass-cli' is available globally.
  async _getToolPath () {
    const localPath = this.getLocalPath()
    if (localPath) {
      let local = false
      try {
        await fs.promises.access(localPath, fs.constants.X_OK)
        local = true
      } catch (e) { }
      if (local) {
        return localPath
      }
    }

    const global = await new ProcessSpawner('pass-cli').checkCommandExists()

    if (global) {
      return 'pass-cli'
    }

    return null
  }

  // Checks if the CLI has a valid authenticated session.
  async _checkSession () {
    try {
      const process = new ProcessSpawner(this.path, ['info'], {}, 10000)
      await process.execute()
      return true
    } catch (e) {
      return false
    }
  }

  // Checks if Proton Pass integration is configured properly by trying to
  // obtain a valid pass-cli tool path. Also refreshes the session state so
  // isUnlocked() stays accurate and users with a valid session aren't
  // prompted for a password they don't need.
  async checkIfConfigured () {
    this.path = await this._getToolPath()
    if (!this.path) {
      return false
    }
    this.authenticated = await this._checkSession()
    return true
  }

  isUnlocked () {
    return this.authenticated
  }

  // Tries to get a list of credential suggestions for a given domain name.
  async getSuggestions (domain) {
    if (this.lastCallList[domain] != null) {
      return this.lastCallList[domain]
    }

    const command = this.path
    if (!command) {
      return Promise.resolve([])
    }

    if (!this.isUnlocked()) {
      throw new Error()
    }

    this.lastCallList[domain] = this.loadSuggestions(domain).then(suggestions => {
      this.lastCallList[domain] = null
      return suggestions
    }).catch(ex => {
      this.lastCallList[domain] = null
    })

    return this.lastCallList[domain]
  }

  async _listVaults () {
    const process = new ProcessSpawner(this.path, ['vault', 'list', '--output', 'json'])
    const data = await process.execute()

    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : (parsed.vaults || [])
  }

  // Returns all login items (with decrypted content) across every vault.
  static get ITEMS_CACHE_TTL () { return 60000 }

  _invalidateItemsCache () {
    this.itemsCache = null
    this.itemsCacheTime = 0
  }

  async _getLoginItemsUncached () {
    const vaults = await this._listVaults()
    const items = []

    for (const vault of vaults) {
      try {
        const process = new ProcessSpawner(this.path, ['item', 'list', '--share-id', vault.share_id, '--filter-type', 'login', '--filter-state', 'active', '--show-secrets', '--output', 'json'])
        const data = await process.execute()

        const parsed = JSON.parse(data)
        const list = Array.isArray(parsed) ? parsed : (parsed.items || [])
        items.push(...list)
      } catch (ex) {
        const { error, data } = ex
        console.error('Error accessing Proton Pass CLI. STDOUT: ' + data + '. STDERR: ' + error)
      }
    }

    return items
  }

  async _getLoginItems () {
    if (this.itemsCache && (Date.now() - this.itemsCacheTime) < ProtonPass.ITEMS_CACHE_TTL) {
      return this.itemsCache
    }
    if (this.itemsInFlight) {
      return this.itemsInFlight
    }
    this.itemsInFlight = this._getLoginItemsUncached().then(items => {
      this.itemsCache = items
      this.itemsCacheTime = Date.now()
      this.itemsInFlight = null
      return items
    }).catch(err => {
      this.itemsInFlight = null
      throw err
    })
    return this.itemsInFlight
  }

  // Converts a serialized pass-cli item into a credential, or returns null
  // if the item isn't a login. Handles the externally-tagged ItemContent
  // shape: item.content.content.Login.
  _credentialFromItem (item) {
    const content = item.content || {}
    const inner = content.content || {}
    const login = inner.Login || inner.login
    if (!login) {
      return null
    }

    const urls = Array.isArray(login.urls) ? login.urls : []
    let domain = ''
    for (const url of urls) {
      try {
        let host = new URL(url).hostname
        if (host.startsWith('www.')) {
          host = host.slice(4)
        }
        domain = host
        break
      } catch (e) { }
    }

    return {
      domain: domain || content.title || '',
      username: login.username || login.email || '',
      password: login.password || '',
      manager: 'Proton Pass',
      shareId: item.share_id,
      itemId: item.id
    }
  }

  _credentialMatchesDomain (credential, domain) {
    return credential.domain === domain
  }

  // Loads credential suggestions for given domain name.
  async loadSuggestions (domain) {
    try {
      const items = await this._getLoginItems()
      return items
        .map(item => this._credentialFromItem(item))
        .filter(credential => credential !== null && this._credentialMatchesDomain(credential, domain))
    } catch (ex) {
      const { error, data } = ex
      console.error('Error accessing Proton Pass CLI. STDOUT: ' + data + '. STDERR: ' + error)
      return []
    }
  }

  async getAllCredentials () {
    const items = await this._getLoginItems()
    return items
      .map(item => this._credentialFromItem(item))
      .filter(credential => credential !== null)
  }

  // The "master password" prompt doubles as the session lock code when the
  // user configured one; when the CLI session is already authenticated the
  // entered value is unused.
  async unlockStore (password) {
    if (await this._checkSession()) {
      this.authenticated = true
      return true
    }

    // session exists but is locked - unlock it with the lock code
    try {
      const unlockProcess = new ProcessSpawner(this.path, ['session', 'unlock'], {}, 10000)
      await unlockProcess.executeSyncInAsyncContext(password + '\n')
      if (await this._checkSession()) {
        this.authenticated = true
        return true
      }
    } catch (e) { }

    // no valid session - run the web-based login flow
    try {
      await this.signInAndSave()
    } catch (e) {
      return false
    }

    this.authenticated = await this._checkSession()
    return this.authenticated
  }

  // Runs `pass-cli login`, which prints a web authentication URL. The URL is
  // opened in a Min tab so the user can complete the flow inside the browser.
  signInAndSave (path = this.path) {
    return new Promise((resolve, reject) => {
      const loginProcess = spawn(path, ['login'])
      /* The flow needs the user to complete a web sign-in, so it gets a
      generous window - but not forever: an abandoned login used to leave a
      pending promise (and a running CLI process) indefinitely. */
      const timeout = setTimeout(() => {
        try { loginProcess.kill() } catch (e) {}
        reject(new Error('Proton Pass sign-in timed out'))
      }, 5 * 60 * 1000)

      let output = ''
      let urlOpened = false
      const onData = (data) => {
        output += data
        if (!urlOpened) {
          const match = output.match(/https:\/\/[^\s"'<>]+/)
          if (match) {
            urlOpened = true
            browserUI.addTab(tabs.add({ url: match[0] }), { openInBackground: true })
          }
        }
      }

      loginProcess.stdout.on('data', onData)
      loginProcess.stderr.on('data', onData)

      loginProcess.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(true)
        } else {
          reject(new Error(output))
        }
      })

      loginProcess.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  // Returns the share ID of the vault new credentials are saved to. Uses the
  // first vault; creates a "Min" vault if the account has none.
  async _defaultShareId () {
    if (this.defaultShareId) {
      return this.defaultShareId
    }

    let vaults = await this._listVaults()
    if (vaults.length === 0) {
      const createProcess = new ProcessSpawner(this.path, ['vault', 'create', '--name', 'Min'])
      await createProcess.execute()
      vaults = await this._listVaults()
    }

    this.defaultShareId = vaults.length > 0 ? vaults[0].share_id : null
    return this.defaultShareId
  }

  async saveCredential (domain, username, password) {
    const shareId = await this._defaultShareId()
    if (!shareId) {
      throw new Error('No Proton Pass vault available')
    }

    /* The credential goes in via a stdin JSON template rather than a
    --password flag, which would expose it in the process list. */
    const template = JSON.stringify({
      title: domain,
      username: username,
      password: password,
      urls: ['https://' + domain]
    })
    const process = new ProcessSpawner(this.path, ['item', 'create', 'login', '--share-id', shareId, '--from-template', '-'])
    await process.executeSyncInAsyncContext(template)
    this._invalidateItemsCache()
  }

  async deleteCredential (domain, username) {
    const items = await this._getLoginItems()

    for (const item of items) {
      const credential = this._credentialFromItem(item)
      if (credential && credential.domain === domain && credential.username === username) {
        const process = new ProcessSpawner(this.path, ['item', 'delete', '--share-id', credential.shareId, '--item-id', credential.itemId])
        await process.execute()
      }
    }
    this._invalidateItemsCache()
  }

  async importCredentials (fileContents) {
    try {
      const csvData = papaparse.parse(fileContents, {
        header: true,
        skipEmptyLines: true,
        transformHeader (header) {
          return header.toLowerCase().trim().replace(/["']/g, '')
        }
      })
      const credentialsToImport = csvData.data.map((credential) => {
        try {
          const includesProtocol = credential.url.match(/^https?:\/\//g)
          const domainWithProtocol = includesProtocol ? credential.url : `https://${credential.url}`

          return {
            domain: new URL(domainWithProtocol).hostname.replace(/^www\./g, ''),
            username: credential.username,
            password: credential.password
          }
        } catch {
          return null
        }
      }).filter(credential => credential !== null)

      if (credentialsToImport.length === 0) return []

      for (const credential of credentialsToImport) {
        await this.saveCredential(credential.domain, credential.username, credential.password)
      }

      return this.getAllCredentials()
    } catch (error) {
      console.error('Error importing credentials:', error)
      return []
    }
  }
}

module.exports = ProtonPass
