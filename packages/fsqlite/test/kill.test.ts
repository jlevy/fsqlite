// True process-kill (SIGKILL) tests: harsher than the crashAt tests (which throw an
// exception with a finally). A real SIGKILL leaves no finally and no cleanup. These
// prove the locking and recovery survive a hard kill: a holder killed mid-publish must
// not permanently wedge the store (the single most important locking property).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'
import { runSync, spawnWorker } from './spawn.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

const seedWriters = (dir: string, writers: number, per: number): void => {
  for (let i = 0; i < writers; i++) {
    runSync<{ written: number }>('writer.ts', [dir, `w${i}`, String(per)])
  }
}

test('a process SIGKILLed while holding publish.lock does not wedge the store', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    seedWriters(dir, 3, 4) // 12 pending tx
    const marker = join(dir, 'holding.marker')

    // Child grabs the publish lock and hangs.
    const child = spawnWorker('lock-holder.ts', [dir, marker, '3000'])
    for (let i = 0; i < 200 && !existsSync(marker); i++) {
      await sleep(10)
    } // wait until it provably holds
    assert.ok(existsSync(marker), 'child acquired the publish lock')
    assert.ok(existsSync(store.publishLock), 'publish.lock dir is held')

    // Hard kill: no finally, the lock dir is left behind (the stale-lock-on-crash case).
    child.kill('SIGKILL')
    await sleep(50)

    // A fresh reconcile with a short stale window must reclaim the abandoned lock and
    // recover all 12 tx exactly once. (timeoutMs must exceed staleMs.)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 30) {
      store.reconcile({ lockOpts: { timeoutMs: 8000, staleMs: 1500, pollMs: 20 } })
    }
    assert.equal(artifactCount(store), 12, 'all tx recovered after the lock-holder was killed')
    assert.notEqual(store.validate().state, 'corrupt')
  } finally {
    cleanup()
  }
})

test('a reconciler SIGKILLed mid-build orphans only a temp; recovery is exactly-once', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    seedWriters(dir, 4, 6) // 24 pending

    // Start a reconciler child and wait until its build snapshot is observable before killing it.
    const child = spawnWorker('reconciler.ts', [dir, '100'])
    let observedBuild = false
    for (let i = 0; i < 1000; i++) {
      observedBuild = readdirSync(store.snapDir).some((file) => file.startsWith('.build-'))
      if (observedBuild) {
        break
      }
      await sleep(1)
    }
    assert.equal(observedBuild, true, 'the child reached the mid-build state before SIGKILL')
    child.kill('SIGKILL')
    await sleep(50)

    assert.ok(store.currentVersion() >= 0, 'current never regressed below its base')
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 40) {
      store.reconcile()
    }
    assert.equal(artifactCount(store), 24, 'exactly-once after a mid-build kill')

    // gc sweeps any orphan .build- temp the kill left behind.
    store.gc({ retain: 0, transientStaleMs: 1 }) // older than 1 ms: everything the kill left
    const orphans = existsSync(store.snapDir)
      ? readdirSync(store.snapDir).filter((f) => f.startsWith('.build-') || f.endsWith('.tmp'))
      : []
    assert.deepEqual(orphans, [], 'no orphan build temps remain after gc')
  } finally {
    cleanup()
  }
})
