/* Per-key serialization and cancellation for asynchronous agent session work.
 * This module is dependency-free so the race rules can be exercised without
 * Electron or the pi SDK. */

function createLifecycleCoordinator () {
  const records = new Map()

  function getRecord (key) {
    let record = records.get(key)
    if (!record) {
      record = {
        generation: 0,
        tail: Promise.resolve(),
        contextSignature: null,
        requests: new Map(),
        pendingCount: 0
      }
      records.set(key, record)
    }
    return record
  }

  function cleanup (key, record) {
    if (record.pendingCount === 0 && record.requests.size === 0 && records.get(key) === record) {
      records.delete(key)
    }
  }

  function queue (key, record, operation) {
    const before = record.tail
    const promise = before.catch(function () {}).then(operation)
    record.tail = promise.catch(function () {})
    record.pendingCount++
    promise.then(function () {
      record.pendingCount--
      cleanup(key, record)
    }, function () {
      record.pendingCount--
      cleanup(key, record)
    })
    return promise
  }

  /* Requests with the same context and operation share one promise. Ordinary
   * operations for the same context serialize without cancelling each other;
   * an explicit replacement (open/create) or context change invalidates all
   * pending work so it cannot publish into the newer session context. */
  function run (key, contextSignature, operationSignature, work, options) {
    // Keep the original three-argument API usable for small consumers/tests.
    if (typeof operationSignature === 'function') {
      const legacySignature = contextSignature
      options = work
      work = operationSignature
      operationSignature = 'default'
      contextSignature = legacySignature
    }
    options = options || {}
    const record = getRecord(key)
    if (record.contextSignature !== contextSignature) {
      record.generation++
      record.contextSignature = contextSignature
      record.requests.clear()
    }
    if (options.supersede) {
      record.generation++
      record.requests.clear()
    }

    const signature = String(operationSignature)
    const previous = record.requests.get(signature)
    if (previous && previous.generation === record.generation) return previous.promise

    const generation = record.generation
    const request = { signature: signature, generation: generation, promise: null }
    request.promise = queue(key, record, function () {
      const context = {
        generation: generation,
        isCurrent: function () {
          return record.generation === generation && record.contextSignature === contextSignature
        }
      }
      if (!context.isCurrent()) return null
      return work(context)
    })
    record.requests.set(signature, request)
    request.promise.then(function () {
      if (record.requests.get(signature) === request) record.requests.delete(signature)
      cleanup(key, record)
    }, function () {
      if (record.requests.get(signature) === request) record.requests.delete(signature)
      cleanup(key, record)
    })
    return request.promise
  }

  /* Place teardown behind all earlier work and invalidate it immediately.
   * New work requested during teardown queues behind this barrier. */
  function invalidateAndRun (key, work) {
    const record = getRecord(key)
    record.generation++
    record.requests.clear()
    return queue(key, record, function () {
      return work({ generation: record.generation })
    })
  }

  function invalidate (key) {
    const record = getRecord(key)
    record.generation++
    record.requests.clear()
    cleanup(key, record)
    return record.generation
  }

  return { run: run, invalidate: invalidate, invalidateAndRun: invalidateAndRun }
}

module.exports = { createLifecycleCoordinator: createLifecycleCoordinator }
