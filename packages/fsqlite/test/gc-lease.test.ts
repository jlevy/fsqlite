// GC and read leases protect packaging. A packager or uploader reads an older
// immutable snapshot; reconcile's snapshot GC must not delete a version that an active
// read-lease still pins, or the packager reads a hole. The lease is a file with a
// heartbeat mtime so a dead packager's pin self-clears.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  rmSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FsqliteError, LockTimeoutError, SnapshotStore } from '../src/index.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

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
    // The dead packager's lease ages past the stale window, so it is swept and v2 is collectible.
    const past = new Date(Date.now() - 120_000)
    for (const lease of readdirSync(store.leaseDir)) {
      utimesSync(join(store.leaseDir, lease), past, past)
    }
    store.gc({ retain: 1, leaseStaleMs: 60_000 })
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
    assert.throws(
      () => {
        lease.heartbeat()
      },
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'retryable' &&
        error.message.includes(`read lease on snapshot ${lease.version} was lost`) &&
        (error.cause as NodeJS.ErrnoException).code === 'ENOENT',
    )
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
    // The packager reads the pinned snapshot directly instead of current.
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

const snapshotFiles = (store: SnapshotStore): number[] => store.snapshotVersions()

/** Overwrite one page of a snapshot: identity rows stay readable, integrity_check fails. */
function corruptPage(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
  } finally {
    closeSync(fd)
  }
}

test('gc refuses a store whose head fails integrity validation and keeps every recovery point', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    for (const batch of ['a', 'b']) {
      store.write('w', (db) => {
        const ins = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
        for (let i = 0; i < 400; i++) {
          ins.run(`${batch}${i}`, `t${i}`.repeat(8), 't')
        }
      })
      store.reconcile()
    }
    corruptPage(store.snapshotPath(2))
    assert.equal(store.validate().state, 'corrupt')

    assert.throws(() => store.gc({ retain: 0 }), /gc refused: store is corrupt: .*integrity/)

    assert.deepEqual(snapshotFiles(store), [0, 1, 2], 'no snapshot was deleted')
    store.repair()
    assert.equal(store.currentVersion(), 1, 'repair can still fall back to the clean predecessor')
  } finally {
    cleanup()
  }
})

test('gc waits for the publish lock instead of deleting under a live publisher or repair', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 3)
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('repairing'))
    const fresh = new Date(Date.now() + 60_000) // the holder stays live for the whole test
    utimesSync(store.publishLock, fresh, fresh)

    assert.throws(
      () => store.gc({ retain: 0, lockOpts: { staleMs: 1_000, timeoutMs: 1_050, pollMs: 5 } }),
      LockTimeoutError,
    )
    assert.deepEqual(snapshotFiles(store), [0, 1, 2, 3])
  } finally {
    cleanup()
  }
})

test('gc revalidates its lock token before each snapshot deletion', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 4)
    const scanLeases = (
      store as unknown as { activeLeasedVersions: (ms: number) => Set<number> }
    ).activeLeasedVersions.bind(store)
    let scans = 0
    Object.assign(store, {
      activeLeasedVersions: (ms: number): Set<number> => {
        scans++
        if (scans === 2 && existsSync(store.publishLock)) {
          // A peer stale-broke gc's lock and now holds it.
          writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('peer'))
        }
        return scanLeases(ms)
      },
    })

    assert.throws(() => store.gc({ retain: 0 }), /gc lost ownership of publish\.lock/)
    assert.deepEqual(snapshotFiles(store), [0, 1, 2, 3, 4], 'nothing was deleted unfenced')
  } finally {
    cleanup()
  }
})

test('gc rejects invalid options before deleting anything, even with a live lease', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 4)
    const lease = store.readLease()
    advance(store, 1)
    const invalid: Record<string, unknown>[] = [
      { retain: Number.NaN },
      { retain: -5 },
      { retain: 1.5 },
      { retain: '1' },
      { leaseStaleMs: -1 },
      { leaseStaleMs: 0 },
      { leaseStaleMs: Number.NaN },
      { leaseStaleMs: Infinity },
      { transientStaleMs: -1 },
      { transientStaleMs: Number.NaN },
    ]
    for (const opts of invalid) {
      assert.throws(
        () => store.gc({ retain: 0, ...opts }),
        (error: unknown) => error instanceof TypeError && error.message.startsWith('gc option '),
        JSON.stringify(opts),
      )
    }
    assert.deepEqual(snapshotFiles(store), [0, 1, 2, 3, 4, 5])
    assert.ok(readdirSync(store.leaseDir).length === 1, 'the live lease is untouched')
    lease.release()
  } finally {
    cleanup()
  }
})

test('a lease published at any point during gc never pins a deleted snapshot', () => {
  // A reader read `current` when it was 1, several publishes ago, and publishes its lease
  // while gc runs (spec RL1). Inject that lease before and after every lease scan gc makes.
  for (let scan = 1; ; scan++) {
    let injected = false
    for (const position of ['before', 'after'] as const) {
      const { dir, cleanup } = tmpStore()
      try {
        const store = new SnapshotStore(dir, STORE_OPTS).init()
        advance(store, 3)
        const reader = new SnapshotStore(dir, STORE_OPTS)
        const readCurrent = reader.currentVersion.bind(reader)
        // A stale pointer read until that snapshot disappears; RL1's retry reads afresh.
        reader.currentVersion = () => (existsSync(reader.snapshotPath(1)) ? 1 : readCurrent())
        let lease: ReturnType<SnapshotStore['readLease']> | null = null
        const scanLeases = (
          store as unknown as { activeLeasedVersions: (ms: number) => Set<number> }
        ).activeLeasedVersions.bind(store)
        let scans = 0
        Object.assign(store, {
          activeLeasedVersions: (ms: number): Set<number> => {
            scans++
            const take = scans === scan && lease === null
            if (take && position === 'before') {
              lease = reader.readLease()
            }
            const result = scanLeases(ms)
            if (take && position === 'after') {
              lease = reader.readLease()
            }
            return result
          },
        })

        store.gc({ retain: 0 })

        const held = lease as ReturnType<SnapshotStore['readLease']> | null
        if (held !== null) {
          injected = true
          assert.ok(
            existsSync(store.snapshotPath(held.version)),
            `lease on ${held.version} injected ${position} scan ${scan} must keep it`,
          )
          held.release()
        }
      } finally {
        cleanup()
      }
    }
    if (!injected) {
      break // gc made fewer scans than this; every boundary has been covered
    }
  }
})

test('gc restores a tombstoned snapshot when the re-scan after the tombstone fails', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 3)
    const scanLeases = (
      store as unknown as { activeLeasedVersions: (ms: number) => Set<number> }
    ).activeLeasedVersions.bind(store)
    Object.assign(store, {
      activeLeasedVersions: (ms: number): Set<number> => {
        // Once snapshot 0 is tombstoned, a fresh lease that cannot be read appears.
        if (!existsSync(store.snapshotPath(0))) {
          writeFileSync(join(store.leaseDir, 'torn.lease'), '{')
        }
        return scanLeases(ms)
      },
    })

    assert.throws(
      () => store.gc({ retain: 0 }),
      /gc refused: fresh lease torn\.lease is unreadable/,
    )

    assert.deepEqual(snapshotFiles(store), [0, 1, 2, 3], 'the tombstoned snapshot is back')
    assert.deepEqual(
      readdirSync(store.snapDir).filter((f) => f.startsWith('.gc-')),
      [],
      'no tombstone is left for a later sweep to delete',
    )
  } finally {
    cleanup()
  }
})

test('gc reports a snapshot it could not remove and leaves every other version', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 2)
    // A directory under a snapshot's name can be renamed to its tombstone but not unlinked,
    // so the second phase of the two-phase delete fails.
    rmSync(store.snapshotPath(0))
    mkdirSync(store.snapshotPath(0))
    assert.throws(
      () => store.gc({ retain: 0 }),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'io' &&
        error.message.startsWith('gc failed to remove snapshot 0') &&
        (error.cause as NodeJS.ErrnoException).code === 'EISDIR',
    )
    assert.ok(existsSync(store.snapshotPath(1)) && existsSync(store.snapshotPath(2)))
    assert.equal(
      store.validate().state,
      'in-flight-capture',
      'the tombstone is a visible transient',
    )
  } finally {
    cleanup()
  }
})

test('gc refuses to delete after current moves back behind the version it validated', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    advance(store, 2)
    // Model a repair that re-points current between gc's validation and its lock.
    const validate = store.validate.bind(store)
    store.validate = () => ({ ...validate(), current: 3 })
    assert.throws(
      () => store.gc({ retain: 0 }),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'retryable' &&
        error.message.includes('current moved from 3 back to 2'),
    )
    assert.deepEqual(snapshotFiles(store), [0, 1, 2])
  } finally {
    cleanup()
  }
})

test('readLease gives up with a retryable error once its retries are spent', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    // Every attempt reads a pointer whose snapshot is already gone, as when gc keeps
    // winning the race between the pointer read and the existence check.
    const currentVersion = store.currentVersion.bind(store)
    let calls = 0
    store.currentVersion = () => (++calls > 1 ? 99 : currentVersion())
    assert.throws(
      () => store.readLease({ maxRetries: 2 }),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'retryable' &&
        error.message.includes('snapshot 99 was collected under contention after 2 retries'),
    )
    assert.deepEqual(readdirSync(store.leaseDir), [], 'every losing lease was withdrawn')
  } finally {
    cleanup()
  }
})

test('a read lease is disposable, and release reports a pin it could not drop', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const disposed = store.readLease()
    disposed[Symbol.dispose]()
    assert.deepEqual(readdirSync(store.leaseDir), [], 'disposal drops the pin')
    disposed.release() // releasing twice is harmless

    // A pin that cannot be removed would hold gc off for leaseStaleMs; say so instead.
    const stuck = store.readLease()
    const [name = ''] = readdirSync(store.leaseDir)
    rmSync(join(store.leaseDir, name))
    mkdirSync(join(store.leaseDir, name, 'blocker'), { recursive: true })
    assert.throws(
      () => {
        stuck.release()
      },
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'io' &&
        error.message.includes('could not release the read lease'),
    )
  } finally {
    cleanup()
  }
})
