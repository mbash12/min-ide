/* global ipc */
/*
Workspace profiles: named session partitions that can be assigned to tasks.
A profile isolates cookies / site storage (via an Electron session partition)
but nothing else - history, bookmarks, autofill and settings stay global.

Profiles are stored in localStorage (UI-side data, shared across windows
through the same user data directory).
*/

const STORAGE_KEY = 'workspaceProfiles'
let cachedSource
let cachedProfiles = []

function readProfiles () {
  try {
    const source = localStorage.getItem(STORAGE_KEY)
    if (source !== cachedSource) {
      const data = JSON.parse(source)
      cachedProfiles = Array.isArray(data) ? data.filter(p => p && p.id && p.name) : []
      cachedSource = source
    }
  } catch (e) {
    console.warn('failed to read workspace profiles', e)
    return []
  }
  return cachedProfiles
}

function getProfiles () {
  return readProfiles().map(profile => Object.assign({}, profile))
}

function saveProfiles (profiles) {
  const previous = getProfiles()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  try {
    if (typeof ipc !== 'undefined' && ipc.invoke) {
      const keep = {}
      profiles.forEach(function (p) {
        if (p && p.id) {
          keep[p.id] = true
          ipc.invoke('db:saveProfile', p).catch(e => console.warn('failed to save profile', e))
        }
      })
      previous.forEach(function (p) {
        if (p && p.id && !keep[p.id]) {
          ipc.invoke('db:deleteProfile', p.id).catch(e => console.warn('failed to delete profile', e))
        }
      })
    }
  } catch (e) {}
}

// The centralized DB is the source of truth. localStorage only serves as a
// synchronous cache so getProfiles() can stay sync for callers that run
// before the first IPC round-trip. On startup: an empty DB is seeded from
// the cache (upgrade path); otherwise the DB wins and refreshes the cache.
if (typeof ipc !== 'undefined' && ipc.invoke) {
  const initialCache = localStorage.getItem(STORAGE_KEY)
  ipc.invoke('db:getProfiles').then(function (dbProfiles) {
    if (localStorage.getItem(STORAGE_KEY) !== initialCache) return
    const local = getProfiles()
    if (Array.isArray(dbProfiles) && dbProfiles.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dbProfiles))
    } else if (local.length > 0) {
      local.forEach(function (p) {
        if (p && p.id) {
          ipc.invoke('db:saveProfile', p).catch(e => console.warn('failed to save profile', e))
        }
      })
    }
  }).catch(function () {})
}

function getProfile (profileId) {
  const profile = readProfiles().find(p => p.id === profileId)
  return profile ? Object.assign({}, profile) : null
}

function addProfile (name) {
  const id = 'profile-' + Math.round(Math.random() * 100000000000000000)
  const profiles = getProfiles()
  profiles.push({ id, name: name || 'Profile' })
  saveProfiles(profiles)
  return getProfile(id)
}

/* a stable identity color derived from the profile id */
const profileColors = ['#5b8def', '#43a047', '#f4511e', '#8e24aa', '#00897b', '#d81b60', '#6d4c41', '#546e7a']

function getColor (profileId) {
  let hash = 0
  for (let i = 0; i < profileId.length; i++) {
    hash = ((hash << 5) - hash) + profileId.charCodeAt(i)
    hash |= 0
  }
  return profileColors[Math.abs(hash) % profileColors.length]
}

function removeProfile (profileId) {
  const profiles = getProfiles().filter(p => p.id !== profileId)
  saveProfiles(profiles)
}

function renameProfile (profileId, name) {
  const profiles = getProfiles()
  const profile = profiles.find(p => p.id === profileId)
  if (profile) {
    profile.name = name
    saveProfiles(profiles)
  }
}

/* the Electron session partition for a profile (null = default shared session) */
function getPartition (profileId) {
  if (!profileId) {
    return null
  }
  return 'persist:profile-' + profileId
}

module.exports = {
  getProfiles,
  getProfile,
  addProfile,
  removeProfile,
  renameProfile,
  getColor,
  getPartition
}
