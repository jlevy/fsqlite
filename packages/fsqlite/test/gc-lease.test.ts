// GC + read-lease: the packaging-safety property. A packager/uploader reads an older
// immutable snapshot; reconcile's snapshot GC must not delete a version that an active
// read-lease still pins, or the packager reads a hole. The lease is a file with a
// heartbeat mtime so a dead packager's pin self-clears.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const readVersionCount = (store: SnapshotStore, version: number): number => {
  const db = new DatabaseSync(store.snapshotPath(version), { readOnly: true })
  try {
    return (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c
  } finally {
    db.close()
  }
}

const advance = (store: SnapshotStore, n: number): void => {
  for (let i = 0; i < n; i++) {
    store.write('A', (db) =>
      db
        .prepare('INSERT INTO artifacts VALUES (?,?,?)')
        .run(`a${store.currentVersion()}-${i}`, 'A', 't'),
    )
    store.reconcile()
  }
}

test('gc keeps a snapshot pinned by an active read-lease, then collects it after release', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 2) // now at v2
    const lease = store.readLease() // pin v2
    assert.equal(lease.version, 2)
    advance(store, 4) // now at v6; v2 is old and would normally be gc'd at retain<4

    store.gc({ retain: 1 })
    assert.ok(existsSync(store.snapshotPath(2)), 'leased v2 is retained despite retain=1')
    assert.ok(existsSync(store.snapshotPath(6)), 'current always retained')

    lease.release()
    store.gc({ retain: 1 })
    assert.ok(!existsSync(store.snapshotPath(2)), 'after release, v2 is collectible')
    assert.ok(existsSync(store.snapshotPath(6)))
  } finally {
    cleanup()
  }
})

test('a stale lease (past leaseStaleMs) does not pin forever', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 2)
    store.readLease() // pin v2 but never heartbeat / release (simulates a dead packager)
    advance(store, 4) // v6
    // With a 0ms stale window, the abandoned lease is swept and v2 is collectible.
    store.gc({ retain: 1, leaseStaleMs: 0 })
    assert.ok(
      !existsSync(store.snapshotPath(2)),
      'an abandoned lease must not wedge gc permanently',
    )
  } finally {
    cleanup()
  }
})

test('gc fails closed on a fresh unreadable lease', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 4)
    const protectedSnapshot = store.snapshotPath(1)
    writeFileSync(join(store.leaseDir, 'torn.lease'), '{')

    assert.throws(
      () => store.gc({ retain: 0 }),
      /gc refused: fresh lease torn\.lease is unreadable/,
    )
    assert.equal(existsSync(protectedSnapshot), true)
  } finally {
    cleanup()
  }
})

test('read-lease heartbeat reports when its lease has been lost', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const lease = store.readLease()
    lease.release()
    assert.throws(() => {
      lease.heartbeat()
    }, /ENOENT/)
  } finally {
    cleanup()
  }
})

test('a packager reads a consistent pinned snapshot while writers keep publishing', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 3) // v3
    const lease = store.readLease()
    assert.equal(readVersionCount(store, lease.version), 3)
    advance(store, 3) // v6; current moves ahead of the pin
    store.gc({ retain: 1 })
    // The packager reads the PINNED snapshot directly (not current): stable.
    assert.ok(
      existsSync(store.snapshotPath(lease.version)),
      'pinned snapshot still present mid-publish',
    )
    assert.equal(
      readVersionCount(store, lease.version),
      3,
      'pinned snapshot is byte-stable while current advances',
    )
    assert.equal(store.currentVersion(), 6)
    lease.release()
  } finally {
    cleanup()
  }
})

test('gc sweeps only STALE transients, sparing a fresh (possibly live) build (spec G3)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const fresh = join(store.snapDir, '.build-fresh.sqlite')
    const old = join(store.snapDir, '.direct-old.sqlite')
    writeFileSync(fresh, 'x')
    writeFileSync(old, 'x')
    const past = new Date(Date.now() - 120_000)
    utimesSync(old, past, past) // crash debris: 2 minutes old
    store.gc({ transientStaleMs: 60_000 })
    assert.equal(
      existsSync(fresh),
      true,
      'a fresh transient (live build in another process) is spared',
    )
    assert.equal(existsSync(old), false, 'a stale transient (crash debris) is swept')
  } finally {
    cleanup()
  }
})
