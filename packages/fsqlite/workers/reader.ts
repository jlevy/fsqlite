// Child-process reader for the readers-during-publish tests. Polls the artifact count
// from the published snapshot and reports what it saw: the count must never go backwards
// across concurrent publishes, and no read may fail, since publication is an atomic
// pointer swap over immutable snapshots.
//
// argv: <dir> <iterations> [controlDir]
//
// With a control directory the reader writes `ready-<pid>` after its first read, then
// polls until `stop` appears there (or `iterations` reads pass) and reads once more, so a
// test can publish while every reader is known to be running.

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', iterStr = '200', controlDir] = process.argv.slice(2)
const iterations = Number(iterStr)
const store = new SnapshotStore(dir, STORE_OPTS)
/** Pause between reads, so publishes interleave with them. */
const POLL_MS = 1

let last = -1
let torn = false
let reads = 0
let errors = 0
let firstError: string | null = null
const distinct = new Set<number>()

const readOnce = (): void => {
  try {
    const n = store.read(
      (db) => (db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as { c: number }).c,
    )
    reads++
    distinct.add(n)
    if (n < last) {
      torn = true // a published snapshot count must never go backwards
    }
    last = Math.max(last, n)
  } catch (error) {
    errors++
    firstError ??= error instanceof Error ? error.message : String(error)
  }
}

readOnce()
if (controlDir !== undefined) {
  writeFileSync(join(controlDir, `ready-${process.pid}`), '')
}
for (let i = 1; i < iterations; i++) {
  if (controlDir !== undefined && existsSync(join(controlDir, 'stop'))) {
    break
  }
  readOnce()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS)
}
readOnce()
process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    reads,
    last,
    torn,
    errors,
    firstError,
    distinct: distinct.size,
  }) + '\n',
)
