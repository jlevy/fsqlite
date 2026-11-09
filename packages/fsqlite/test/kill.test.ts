// True process-kill (SIGKILL) tests: harsher than the crashAt tests (which throw an
// exception with a finally). A real SIGKILL leaves no finally and no cleanup. These
// prove the locking and recovery survive a hard kill: a holder killed mid-publish must
// not permanently wedge the store (the single most important locking property).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'
import { runSync, spawnWorker } from './spawn.ts'

/** Polls of a child's marker file before the test gives up on it. */
const MARKER_POLLS = 1000
const MARKER_POLL_MS = 10

/** Wait until the child writes `marker`, failing if it exits or the polls run out. */
async function waitForMarker(child: ChildProcess, marker: string): Promise<void> {
  for (let i = 0; i < MARKER_POLLS && !existsSync(marker); i++) {
    if (child.exitCode !== null) {
      break
    }
    await sleep(MARKER_POLL_MS)
  }
  assert.ok(
    existsSync(marker),
    `the child reached its marked state (exit ${String(child.exitCode)})`,
  )
}

/** SIGKILL `child` and wait until it is gone: a killed process runs no cleanup. */
async function killHard(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
}
const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

const seedWriters = (dir: string, writers: number, per: number): void => {
  for (let i = 0; i < writers; i++) {
    runSync<{ written: number }>('writer.ts', [dir, `w${i}`, String(per)])
  }
}

test('a process SIGKILLed while holding publish.lock does not wedge the store', async () => {
  const { dir, cleanup } = tmpStore()
  let child: ChildProcess | null = null
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    seedWriters(dir, 3, 4) // 12 pending tx
    const marker = join(dir, 'holding.marker')

    // Child grabs the publish lock and hangs; it writes the marker from inside the lock.
    child = spawnWorker('lock-holder.ts', [dir, marker, '3000'])
    await waitForMarker(child, marker)
    assert.ok(existsSync(store.publishLock), 'publish.lock dir is held')

    // Hard kill: no finally, the lock dir is left behind (the stale-lock-on-crash case).
    await killHard(child)

    // A fresh reconcile with a short stale window must reclaim the abandoned lock and
    // recover all 12 tx exactly once. (timeoutMs must exceed staleMs.)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 30) {
      store.reconcile({ lockOpts: { timeoutMs: 8000, staleMs: 1500, pollMs: 20 } })
    }
    assert.equal(artifactCount(store), 12, 'all tx recovered after the lock-holder was killed')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    if (child !== null) {
      await killHard(child)
    }
    cleanup()
  }
})

test('a reconciler SIGKILLed mid-build orphans only a temp; recovery is exactly-once', async () => {
  const { dir, cleanup } = tmpStore()
  let child: ChildProcess | null = null
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    seedWriters(dir, 4, 6) // 24 pending
    const marker = join(dir, 'built.marker')

    // The child stops after its build is complete and fsynced, before it can publish.
    child = spawnWorker('reconciler.ts', [dir, '100', marker])
    await waitForMarker(child, marker)
    assert.ok(readdirSync(store.snapDir).some((file) => file.startsWith('.build-')))
    await killHard(child)

    assert.equal(store.currentVersion(), 0, 'the killed build published nothing')
    assert.equal(store.validate().state, 'in-flight-capture', 'its orphan build is visible')
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 40) {
      store.reconcile()
    }
    assert.equal(artifactCount(store), 24, 'exactly-once after a mid-build kill')

    // gc sweeps the orphan .build- temp the kill left behind.
    store.gc({ retain: 0, transientStaleMs: 1 }) // older than 1 ms: everything the kill left
    const orphans = readdirSync(store.snapDir).filter(
      (f) => f.startsWith('.build-') || f.endsWith('.tmp'),
    )
    assert.deepEqual(orphans, [], 'no orphan build temps remain after gc')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    if (child !== null) {
      await killHard(child)
    }
    cleanup()
  }
})
