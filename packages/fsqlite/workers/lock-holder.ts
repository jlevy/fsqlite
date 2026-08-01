// Worker that ACQUIRES the publish lock and then hangs forever, simulating a reconciler
// that died (or wedged) while holding the lock. The parent SIGKILLs it and verifies the
// store can still recover: i.e. the lease lock is reclaimable and the kill cannot
// permanently wedge the store.
//
// argv: <dir> <markerPath> <staleMs>

import { writeFileSync } from 'node:fs'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'
import { withLock } from '../src/lock.ts'

const [dir = '', markerPath = '', staleMsStr = '0'] = process.argv.slice(2)
const staleMs = Number(staleMsStr)
const store = new SnapshotStore(dir, STORE_OPTS)

// Hold the publish lock with a long stale window, then hang. We write the marker from
// INSIDE the lock so the parent only kills us once we provably hold it.
withLock(
  store.publishLock,
  () => {
    writeFileSync(markerPath, String(process.pid))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000_000) // hang until SIGKILL
  },
  { timeoutMs: staleMs + 60_000, staleMs: staleMs + 30_000, pollMs: 10 },
)
