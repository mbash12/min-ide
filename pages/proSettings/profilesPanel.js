/* Workspace profile management for the Pro Settings page. */
(function (root) {
  root.initializeProSettingsProfiles = function (options) {
    options = options || {}
    const settings = options.settings
    const l = options.l
    const STORAGE_KEY = 'workspaceProfiles'
    const profileColors = ['#5b8def', '#43a047', '#f4511e', '#8e24aa', '#00897b', '#d81b60', '#6d4c41', '#546e7a']
    var pendingProfileDeletes = {}
    var pendingProfileClears = {}

    window.addEventListener('message', function (e) {
      if (!e.origin.startsWith('min://') || !e.data) return
      if (e.data.message === 'profileDeleteResult') {
        const result = e.data.result || {}
        const onResult = pendingProfileDeletes[result.profileId]
        if (!onResult) return
        delete pendingProfileDeletes[result.profileId]
        onResult(result)
      }
      if (e.data.message === 'profileClearDataResult') {
        const result = e.data.result || {}
        const key = result.profileId || ''
        const onClear = pendingProfileClears[key]
        if (!onClear) return
        delete pendingProfileClears[key]
        onClear(result)
      }
    })

    function requestProfileDelete (profileId, onResult) {
      pendingProfileDeletes[profileId] = onResult
      window.postMessage({ message: 'profileDeleteRequested', profileId: profileId }, window.location.toString())
    }

    function requestProfileClear (profileId, types, onResult) {
      pendingProfileClears[profileId || ''] = onResult
      window.postMessage({ message: 'profileClearDataRequested', profileId: profileId, types: types }, window.location.toString())
    }

    function getProfiles () {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const data = JSON.parse(raw)
        if (Array.isArray(data)) return data.filter(function (p) { return p && p.id && p.name })
      } catch (e) {
        console.warn('profiles: failed to read', e)
      }
      return []
    }
    function saveProfiles (profiles) {
      const previous = getProfiles()
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
      try {
        const keep = {}
        profiles.forEach(function (p) {
          if (p && p.id) {
            keep[p.id] = true
            window.postMessage({ message: 'dbInvoke', action: 'db:saveProfile', payload: p }, window.location.toString())
          }
        })
        previous.forEach(function (p) {
          if (p && p.id && !keep[p.id]) {
            window.postMessage({ message: 'dbInvoke', action: 'db:deleteProfile', payload: p.id }, window.location.toString())
          }
        })
      } catch (e) {}
    }
    function getColor (profileId) {
      let hash = 0
      for (let i = 0; i < profileId.length; i++) {
        hash = ((hash << 5) - hash) + profileId.charCodeAt(i)
        hash |= 0
      }
      return profileColors[Math.abs(hash) % profileColors.length]
    }

    function getWorkspaceUsage () {
      const usage = {}
      try {
        // workspaces are persisted via sessionRestore — check both possible keys
        const keys = ['taskRestoreData', 'workspaceRestoreData']
        for (let k = 0; k < keys.length; k++) {
          const raw = localStorage.getItem(keys[k])
          if (!raw) continue
          const data = JSON.parse(raw)
          const arr = data.workspaces || data.tasks || (data.state && (data.state.workspaces || data.state.tasks)) || []
          arr.forEach(function (ws) {
            if (ws.profileId) usage[ws.profileId] = (usage[ws.profileId] || 0) + 1
          })
        }
        let totalWorkspaces = 0
        let withProfile = 0
        Object.keys(usage).forEach(function (k) { withProfile += usage[k] })
        try {
          const raw2 = localStorage.getItem('taskRestoreData') || localStorage.getItem('workspaceRestoreData')
          if (raw2) {
            const d2 = JSON.parse(raw2)
            const a2 = d2.workspaces || d2.tasks || (d2.state && (d2.state.workspaces || d2.state.tasks)) || []
            totalWorkspaces = a2.length
          }
        } catch (e2) {}
        usage.__total = totalWorkspaces
        usage.__default = Math.max(0, totalWorkspaces - withProfile)
      } catch (e) {}
      return usage
    }

    var listEl = document.getElementById('profiles-list')
    var addButton = document.getElementById('profiles-add-button')
    var noticeEl = document.getElementById('profiles-notice')

    /* which profile new workspaces start on ('' = the built-in Default partition);
    starred per profile row */
    var defaultWorkspaceProfile = ''
    settings.get('defaultWorkspaceProfile', function (value) {
      defaultWorkspaceProfile = value || ''
      renderProfiles()
    })
    function setDefaultProfile (id) {
      defaultWorkspaceProfile = id || ''
      settings.set('defaultWorkspaceProfile', id || null)
      renderProfiles()
    }
    function makeDefaultStar (id) {
      const btn = document.createElement('button')
      const isDefault = (id || '') === defaultWorkspaceProfile
      btn.className = 'pro-icon-button profile-default-star i ' + (isDefault ? 'carbon:star-filled' : 'carbon:star')
      btn.classList.toggle('active', isDefault)
      btn.title = l('profileSetDefault')
      btn.addEventListener('click', function () {
        setDefaultProfile(id)
      })
      return btn
    }

    /* add-profile modal */
    var profileAddOverlay = document.getElementById('profile-add-overlay')
    var profileAddInput = document.getElementById('profile-add-input')
    var profileAddError = document.getElementById('profile-add-error')
    var profileAddConfirm = document.getElementById('profile-add-confirm')
    profileAddInput.placeholder = l('taskProfileAddPlaceholder')

    function openProfileAddDialog () {
      profileAddInput.value = ''
      profileAddError.hidden = true
      profileAddOverlay.hidden = false
      profileAddInput.focus()
    }
    function closeProfileAddDialog () {
      profileAddOverlay.hidden = true
    }
    addButton.addEventListener('click', openProfileAddDialog)
    document.getElementById('profile-add-cancel').addEventListener('click', closeProfileAddDialog)
    profileAddConfirm.addEventListener('click', addProfile)
    profileAddInput.addEventListener('input', function () { profileAddError.hidden = true })
    profileAddInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addProfile()
    })
    profileAddOverlay.addEventListener('click', function (e) {
      if (e.target === profileAddOverlay) closeProfileAddDialog()
    })

    function showProfilesNotice (text, isError) {
      noticeEl.hidden = false
      noticeEl.textContent = text
      noticeEl.classList.toggle('error', !!isError)
    }

    function clearProfilesNotice () {
      noticeEl.hidden = true
      noticeEl.textContent = ''
    }

    /* ----- Clear Data dialog (Chrome-style data type picker) ----- */

    var clearOverlay = document.getElementById('profile-clear-overlay')
    var clearTitle = document.getElementById('profile-clear-title')
    var clearUsage = document.getElementById('profile-clear-usage')
    var clearSiteData = document.getElementById('profile-clear-site-data')
    var clearCache = document.getElementById('profile-clear-cache')
    var clearCancelBtn = document.getElementById('profile-clear-cancel')
    var clearConfirmBtn = document.getElementById('profile-clear-confirm')
    var clearTarget = null

    function openClearDialog (profileId, name) {
      clearTarget = profileId || null
      clearTitle.textContent = l('profileClearData') + ' — ' + name
      var usage = getWorkspaceUsage()
      var count = profileId ? (usage[profileId] || 0) : (usage.__default || 0)
      clearUsage.textContent = count
        ? l('profileClearUsage').replace('%s', count === 1 ? '1 workspace' : count + ' workspaces')
        : ''
      clearOverlay.hidden = false
    }

    function closeClearDialog () {
      clearOverlay.hidden = true
      clearTarget = null
      clearConfirmBtn.disabled = false
    }

    function updateClearConfirm () {
      clearConfirmBtn.disabled = !clearSiteData.checked && !clearCache.checked
    }

    clearCancelBtn.addEventListener('click', closeClearDialog)
    clearOverlay.addEventListener('click', function (e) {
      if (e.target === clearOverlay) closeClearDialog()
    })
    clearSiteData.addEventListener('change', updateClearConfirm)
    clearCache.addEventListener('change', updateClearConfirm)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (options.closeProviderAddDialog) options.closeProviderAddDialog()
        if (!profileAddOverlay.hidden) closeProfileAddDialog()
        if (!clearOverlay.hidden) closeClearDialog()
      }
    })

    clearConfirmBtn.addEventListener('click', function () {
      var types = { siteData: clearSiteData.checked, cache: clearCache.checked }
      if (!types.siteData && !types.cache) return
      clearConfirmBtn.disabled = true
      var target = clearTarget
      requestProfileClear(target, types, function (result) {
        closeClearDialog()
        if (result && result.ok) {
          showProfilesNotice(result.reloaded
            ? l('profileClearDoneReloaded').replace('%s', result.reloaded)
            : l('profileClearDone'))
        } else {
          showProfilesNotice(l('profileClearFailed'), true)
        }
      })
    })

    function makeClearButton (profileId, name) {
      const btn = document.createElement('button')
      btn.className = 'pro-icon-button i carbon:erase'
      btn.title = l('profileClearData')
      btn.addEventListener('click', function () {
        openClearDialog(profileId, name)
      })
      return btn
    }

    function renderProfiles () {
      listEl.textContent = ''
      clearProfilesNotice()

      const usage = getWorkspaceUsage()

      // always show Default row first
      const defaultRow = document.createElement('div')
      defaultRow.className = 'profiles-default-row'
      const defaultIcon = document.createElement('span')
      defaultIcon.className = 'profile-initial profile-initial-default i carbon:user-multiple'
      defaultRow.appendChild(defaultIcon)
      const defaultName = document.createElement('span')
      defaultName.className = 'profile-row-name'
      defaultName.textContent = l('taskProfileDefault')
      defaultRow.appendChild(defaultName)
      if (usage.__total > 0) {
        const u = document.createElement('span')
        u.className = 'profile-row-usage'
        const n = usage.__default
        u.textContent = n === 1 ? '1 workspace' : n + ' workspaces'
        defaultRow.appendChild(u)
      }
      // star marks which profile new workspaces start on
      defaultRow.appendChild(makeDefaultStar(null))
      // the default profile cannot be deleted, but its data can be cleared
      defaultRow.appendChild(makeClearButton(null, l('taskProfileDefault')))
      listEl.appendChild(defaultRow)

      const profiles = getProfiles()

      if (profiles.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'profiles-empty'
        empty.textContent = l('taskProfileEmpty')
        listEl.appendChild(empty)
        return
      }

      profiles.forEach(function (profile) {
        const row = document.createElement('div')
        row.className = 'profile-row'

        const initial = document.createElement('span')
        initial.className = 'profile-initial'
        initial.textContent = (profile.name.trim()[0] || '?').toUpperCase()
        initial.style.backgroundColor = getColor(profile.id)
        row.appendChild(initial)

        const nameEl = document.createElement('span')
        nameEl.className = 'profile-row-name'
        nameEl.textContent = profile.name
        row.appendChild(nameEl)

        const count = usage[profile.id] || 0
        if (count > 0) {
          const usageEl = document.createElement('span')
          usageEl.className = 'profile-row-usage'
          usageEl.textContent = count === 1 ? '1 workspace' : count + ' workspaces'
          row.appendChild(usageEl)
        }

        row.appendChild(makeDefaultStar(profile.id))

        const renameBtn = document.createElement('button')
        renameBtn.className = 'pro-icon-button i carbon:edit'
        renameBtn.title = l('taskProfileRename')
        renameBtn.addEventListener('click', function () {
          const input = document.createElement('input')
          input.type = 'text'
          input.className = 'pro-input'
          input.value = profile.name
          input.style.flex = '1'
          row.replaceChild(input, nameEl)
          input.focus()
          input.select()
          let done = false
          const save = function () {
            if (done) return
            done = true
            const v = input.value.trim()
            if (v) {
              const all = getProfiles()
              const p = all.find(function (x) { return x.id === profile.id })
              if (p) { p.name = v; saveProfiles(all) }
            }
            renderProfiles()
          }
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') { done = true; renderProfiles() }
          })
          input.addEventListener('blur', save)
        })
        row.appendChild(renameBtn)

        row.appendChild(makeClearButton(profile.id, profile.name))

        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'pro-icon-button profile-delete i carbon:trash-can'
        deleteBtn.title = l('taskProfileDelete')
        deleteBtn.addEventListener('click', function () {
          requestProfileDelete(profile.id, function (result) {
            if (!result || !result.ok) {
              if (result && result.reason === 'in-use') {
                showProfilesNotice(l('profileDeleteInUse').replace('%s', (result.workspaces || []).join(', ')), true)
              }
              return
            }
            const all = getProfiles().filter(function (p) { return p.id !== profile.id })
            saveProfiles(all)
            if (profile.id === defaultWorkspaceProfile) {
              defaultWorkspaceProfile = ''
              settings.set('defaultWorkspaceProfile', null)
            }
            try {
              const keys = ['taskRestoreData', 'workspaceRestoreData']
              keys.forEach(function (k) {
                const raw = localStorage.getItem(k)
                if (!raw) return
                const data = JSON.parse(raw)
                const arr = data.workspaces || data.tasks || (data.state && (data.state.workspaces || data.state.tasks))
                if (!arr) return
                let changed = false
                arr.forEach(function (ws) {
                  if (ws.profileId === profile.id) { ws.profileId = null; changed = true }
                })
                if (changed) localStorage.setItem(k, JSON.stringify(data))
              })
            } catch (e) {}
            renderProfiles()
            // Acknowledge only after persistent profile data has been updated.
            // The host can now safely recreate views using the default partition,
            // including this settings view if it used the deleted profile.
            window.postMessage({ message: 'profileDeleted', profileId: profile.id }, window.location.toString())
          })
        })
        row.appendChild(deleteBtn)

        listEl.appendChild(row)
      })
    }

    function addProfile () {
      const name = profileAddInput.value.trim()
      if (!name) {
        profileAddError.hidden = false
        profileAddError.textContent = l('taskProfileAddPlaceholder')
        return
      }
      const id = 'profile-' + Math.round(Math.random() * 100000000000000000)
      const profiles = getProfiles()
      profiles.push({ id: id, name: name })
      saveProfiles(profiles)
      closeProfileAddDialog()
      renderProfiles()
    }

    renderProfiles()

    return { render: renderProfiles }
  }
})(window)
