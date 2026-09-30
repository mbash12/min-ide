/* Tracks the latest async request for a changing panel scope. A scope is a
 * stable primitive key (for example a workspace id plus folder path). */
module.exports = function createRequestGate () {
  let scope
  let scopeVersion = 0
  let requestVersion = 0

  return {
    setScope: function (nextScope) {
      if (nextScope === scope) return
      scope = nextScope
      scopeVersion++
      requestVersion++
    },
    begin: function (nextScope) {
      if (arguments.length) this.setScope(nextScope)
      requestVersion++
      return {
        scope: scope,
        scopeVersion: scopeVersion,
        requestVersion: requestVersion
      }
    },
    invalidate: function () {
      requestVersion++
    },
    isCurrent: function (request, selectedScope) {
      return !!request &&
        request.scope === scope &&
        request.scopeVersion === scopeVersion &&
        request.requestVersion === requestVersion &&
        (arguments.length < 2 || request.scope === selectedScope)
    }
  }
}
