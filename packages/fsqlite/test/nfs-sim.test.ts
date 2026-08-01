// Shared-storage behavior, simulated locally (a real gate needs a real NFSv4.1, EFS, or
// Filestore mount). These tests pin two design properties used by the shared-filesystem
// protocol:
//   1. Close-to-open coherence: every read opens a FRESH connection to the immutable
//      snapshot named by `current`, so a second "host" observes a publish with no stale
//      connection-cache. fsqlite never holds a long-lived handle to a mutable shared DB
//      file: the exact thing that corrupts SQLite-on-NFS.
//   2. Conflict-free writes: writers only CREATE uniquely named envelope directories,
//      so a local burst never collides.
// What this canNOT prove without a real mount: fcntl/lease-break races under true network
// partition, attribute-cache staleness (actimeo), and fsync durability.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

test('close-to-open: a second store handle sees a publish with no stale cache', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const hostA = new SnapshotStore(dir, STORE_OPTS).init()
    const hostB = new SnapshotStore(dir, STORE_OPTS) // a different "host" / process handle

    assert.equal(artifactCount(hostB), 0)
    hostA.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    hostA.reconcile()
    // hostB opens fresh on every read and observes hostA's publish immediately.
    assert.equal(hostB.currentVersion(), 1)
    assert.equal(artifactCount(hostB), 1)
  } finally {
    cleanup()
  }
})

test('no long-lived mutable handle: no WAL/-shm side files in the shared snapshot dir', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    store.reconcile()
    const side = readdirSync(store.snapDir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))
    assert.deepEqual(side, [], 'no WAL/-shm side files in the shared snapshot dir')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('conflict-free writes: a burst of concurrent envelopes never collides on a path', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const tx = store.write(`w${i % 8}`, (db) =>
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'A', 't'),
      )
      assert.ok(tx && !ids.has(tx), 'every envelope id is unique (no path collision)')
      ids.add(tx)
    }
    const dirs = readdirSync(store.txPending).filter((d) => d.endsWith('.txn'))
    assert.equal(dirs.length, 200, 'all 200 envelopes coexist with distinct paths')
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 20) {
      store.reconcile()
    }
    assert.equal(artifactCount(store), 200)
  } finally {
    cleanup()
  }
})

test('simulated sync-folder hazard is detected by validate (not silently accepted)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    // A naive sync client copying a live DB would leave a -wal next to the snapshot.
    writeFileSync(store.snapshotPath(store.currentVersion()) + '-wal', 'fake-wal')
    assert.equal(
      store.validate().state,
      'in-flight-capture',
      'a live -wal side file is surfaced loudly, not ignored (R2)',
    )
  } finally {
    cleanup()
  }
})
