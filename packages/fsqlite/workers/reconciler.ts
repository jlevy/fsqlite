// Child-process reconciler for the racing-reconciler tests. Runs reconcile in a loop
// until the pending tail is empty, then exits. Multiple of these run at once to prove
// exactly-once publish under optimistic concurrency on `current`.
//
// argv: <dir> <maxPasses> [buildMarker]
//
// With a build marker, the first reconcile writes that file once its build is complete and
// fsynced, then hangs before publishing, so a test can SIGKILL it at a known point.

import { writeFileSync } from 'node:fs'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', maxPassesStr = '50', buildMarker] = process.argv.slice(2)
if (buildMarker !== undefined) {
  setAfterFsyncPathForTest((path) => {
    if (path.includes('.build-')) {
      writeFileSync(buildMarker, path)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000_000) // until SIGKILL
    }
  })
}
const maxPasses = Number(maxPassesStr)
const store = new SnapshotStore(dir, STORE_OPTS)

// A reconcile that keeps losing the publish race to its peers throws a `retryable` error
// by contract; a real caller backs off and retries, so this worker does too rather than
// exiting. Correctness (zero loss, no double-apply) is still asserted by the tests.
const CONTENTION_BACKOFF_MIN_MS = 5
const CONTENTION_BACKOFF_SPREAD_MS = 20
const backoff = (): void => {
  const ms = CONTENTION_BACKOFF_MIN_MS + Math.floor(Math.random() * CONTENTION_BACKOFF_SPREAD_MS)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let totalApplied = 0
let passes = 0
let contended = 0
for (let p = 0; p < maxPasses; p++) {
  passes++
  let res
  try {
    res = store.reconcile({ lockOpts: { timeoutMs: 10_000, staleMs: 5_000, pollMs: 10 } })
  } catch (error) {
    if (error instanceof FsqliteError && error.retryable) {
      contended++
      backoff()
      continue
    }
    throw error
  }
  totalApplied += res.applied
  if (store.pendingTxns().length === 0) {
    break
  }
}
process.stdout.write(JSON.stringify({ pid: process.pid, totalApplied, passes, contended }) + '\n')
