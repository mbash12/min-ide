/* Whether each workspace's stored folder is still there.
 *
 * A folder that was moved or deleted must not break its workspace: the
 * workspace becomes browser-only until the user picks a new path, and the
 * stored path is never changed here (HANDOVER §8).
 *
 * Results are cached per workspace so the sidebar can ask on every refresh
 * without re-checking, and a check that is already running is never duplicated.
 */

const cache = {} // workspaceId: { path, usable }
const checksInFlight = {}
const listeners = []

function notify () {
  listeners.forEach(function (fn) {
    try {
      fn()
    } catch (e) {}
  })
}

/* true when the folder is usable, false when it is gone, undefined while it has
not been checked yet. Call sites treat unknown as usable, so a valid folder is
never hidden just because the check is still running. */
function isUsable (workspaceId) {
  const entry = cache[workspaceId]
  return entry ? entry.usable : undefined
}

function onChange (fn) {
  listeners.push(fn)
}

async function refresh (workspace) {
  if (!workspace || !workspace.id) {
    return
  }
  const storedPath = workspace.path

  // a workspace without a path is a different case: the sidebar hides the
  // path-dependent tabs on its own
  if (!storedPath) {
    if (cache[workspace.id]) {
      delete cache[workspace.id]
      notify()
    }
    return
  }
  if (checksInFlight[workspace.id]) {
    return
  }
  const cached = cache[workspace.id]
  if (cached && cached.path === storedPath) {
    return
  }

  checksInFlight[workspace.id] = true
  let usable = true
  try {
    const result = await ipc.invoke('workspacePathStatus', storedPath)
    usable = !!(result && result.ok)
  } catch (e) {
    // if the check itself fails, keep showing the files rather than hiding a
    // folder that may well be fine
    usable = true
  }
  delete checksInFlight[workspace.id]

  const current = workspaces.get(workspace.id)
  if (!current || current.path !== storedPath) {
    // the path changed while checking; that change runs its own check
    return
  }
  cache[workspace.id] = { path: storedPath, usable: usable }
  notify()
}

module.exports = { isUsable, onChange, refresh }
