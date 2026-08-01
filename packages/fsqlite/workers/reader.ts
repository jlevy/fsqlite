// Child-process reader for the readers-during-publish test. Polls the artifact count
// from the published snapshot; asserts it is monotonic (never torn, never goes
// backwards) across concurrent publishes.
//
// argv: <dir> <iterations>

import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', iterStr = '200'] = process.argv.slice(2)
const iterations = Number(iterStr)
const store = new SnapshotStore(dir, STORE_OPTS)

let last = -1
let torn = false
let reads = 0
for (let i = 0; i < iterations; i++) {
  try {
    const n = store.read(
      (db) => (db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as { c: number }).c,
    )
    reads++
    if (n < last) {
      torn = true
    } // a published snapshot count must never go backwards
    last = Math.max(last, n)
  } catch {
    /* pointer momentarily mid-swap is fine; retry next loop */
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
}
process.stdout.write(JSON.stringify({ pid: process.pid, reads, last, torn }) + '\n')
