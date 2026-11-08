// Overlapping publishers. A holder paused past the lock's stale window can be broken
// and later resume in the middle of its publication. Correctness must not depend on the
// lock (spec L5), so these interleavings must never replace a published snapshot, publish
// another holder's build as one's own, or archive an envelope the published ledger lacks.
// Each test models the resumed holder at a real step boundary through a fault-injection
// seam, and models any foreign build with real SQLite files.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest } from '../src/fsutil.ts'
import { setBeforeSnapshotLinkForTest } from '../src/publication.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const insert = (id: string) => (db: DatabaseSync) => {
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(id, id.toUpperCase(), 't')
}

function column(path: string, sql: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare(sql).all() as { v: string }[]).map((row) => row.v)
  } finally {
    db.close()
  }
}
const rowsOf = (path: string): string[] =>
  column(path, 'SELECT artifact_id AS v FROM artifacts ORDER BY 1')
const ledgerOf = (path: string): string[] =>
  column(path, 'SELECT tx_id AS v FROM applied_tx ORDER BY 1')
const txns = (dir: string): string[] => readdirSync(dir).filter((d) => d.endsWith('.txn'))

/**
 * A complete, valid build from snapshot 0 carrying one foreign row, as an overlapping
 * publisher would produce. It is aged past the default stale window so a later publisher
 * may reclaim it as an abandoned orphan.
 */
function foreignBuild(store: SnapshotStore | DirectStore, dir: string): string {
  const path = join(dir, 'foreign-build.sqlite')
  copyFileSync(store.snapshotPath(0), path)
  const db = new DatabaseSync(path)
  try {
    insert('foreign')(db)
  } finally {
    db.close()
  }
  const past = new Date(Date.now() - 120_000)
  utimesSync(path, past, past)
  return path
}

test('a stale-broken reconciler resuming after a peer published cannot replace that snapshot', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const paused = new SnapshotStore(dir, STORE_OPTS).init()
    const x = paused.write('wx', insert('x'))
    let y: string | null = null
    setBeforeSnapshotLinkForTest(() => {
      setBeforeSnapshotLinkForTest(null)
      // The holder passed OCC and fencing, then paused past the stale window. A peer breaks
      // its lock, a writer commits Y, and the peer publishes {X, Y} as the same version.
      rmSync(paused.publishLock, { recursive: true, force: true })
      const peer = new SnapshotStore(dir, STORE_OPTS)
      y = peer.write('wy', insert('y'))
      assert.equal(peer.reconcile().published, 1)
    })

    paused.reconcile()

    const head = paused.snapshotPath(paused.currentVersion())
    assert.deepEqual(rowsOf(paused.snapshotPath(1)), ['x', 'y'], "the peer's snapshot is intact")
    assert.deepEqual(ledgerOf(head), [x, y].sort(), 'every archived envelope is in the ledger')
    assert.deepEqual(txns(paused.txPending), [])
    assert.equal(paused.validate().state, 'sealed')
  } finally {
    setBeforeSnapshotLinkForTest(null)
    cleanup()
  }
})

test("a stale-broken DirectStore writer resuming after a peer published cannot replace the peer's write", () => {
  const { dir, cleanup } = tmpStore()
  try {
    const paused = new DirectStore(dir, STORE_OPTS).init()
    let peerVersion: number | null = null
    setBeforeSnapshotLinkForTest(() => {
      setBeforeSnapshotLinkForTest(null)
      rmSync(join(dir, 'publish.lock'), { recursive: true, force: true })
      peerVersion = new DirectStore(dir, STORE_OPTS).write(insert('b'))
    })
    let calls = 0

    const version = paused.write((db) => {
      calls++
      insert('a')(db)
    })

    assert.equal(peerVersion, 1)
    assert.deepEqual(rowsOf(paused.snapshotPath(1)), ['b'], "the peer's returned write survives")
    assert.equal(version, 2)
    assert.deepEqual(rowsOf(paused.snapshotPath(2)), ['a', 'b'])
    assert.equal(calls, 2, 'the resumed writer reran its callback on the new head')
  } finally {
    setBeforeSnapshotLinkForTest(null)
    cleanup()
  }
})

test('a reconciler does not publish a foreign build that replaced its own before the pointer swap', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const x = store.write('wx', insert('x'))
    const foreign = foreignBuild(store, dir)
    setAfterFsyncDirForTest((path) => {
      if (path === store.snapDir) {
        setAfterFsyncDirForTest(null)
        renameSync(foreign, store.snapshotPath(1)) // an overlapping holder's late rename
      }
    })

    const result = store.reconcile()

    assert.equal(result.applied, 1)
    assert.ok(ledgerOf(store.snapshotPath(store.currentVersion())).includes(x ?? ''))
    assert.deepEqual(rowsOf(store.snapshotPath(store.currentVersion())), ['x'])
    assert.deepEqual(txns(store.txPending), [])
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

test('a DirectStore write whose published snapshot was replaced after the swap retries', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    const foreign = foreignBuild(store, dir)
    setAfterFsyncDirForTest((path) => {
      if (path === dir) {
        setAfterFsyncDirForTest(null)
        renameSync(foreign, store.snapshotPath(1)) // replaced right after the pointer swap
      }
    })

    const version = store.write(insert('b'))

    assert.ok(
      rowsOf(store.snapshotPath(version)).includes('b'),
      'write() returns only a version that carries its own mutation',
    )
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

test('a DirectStore retry after committing its build leaves no orphan a later repair could publish', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    setAfterFsyncDirForTest((path) => {
      if (path === join(dir, 'snapshots')) {
        setAfterFsyncDirForTest(null)
        rmSync(join(dir, 'publish.lock'), { recursive: true, force: true }) // lease stolen
      }
    })

    assert.throws(() => store.write(insert('a'), { maxRetries: 1 }), /exceeded retries/)

    assert.equal(existsSync(store.snapshotPath(1)), false, 'the unpublished build was removed')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

test("a publisher never reclaims a fresh entry inside another holder's link-to-swap window", () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('wx', insert('x'))
    const occupant = foreignBuild(store, dir)
    const future = new Date(Date.now() + 60_000) // stays fresh for the whole attempt
    utimesSync(occupant, future, future)
    renameSync(occupant, store.snapshotPath(1))

    assert.throws(
      () => store.reconcile({ lockOpts: { staleMs: 50, timeoutMs: 100, pollMs: 5 } }),
      /snapshot 1 is held by a publication that neither finished nor went stale/,
    )

    assert.deepEqual(rowsOf(store.snapshotPath(1)), ['foreign'], 'the live entry is untouched')
    assert.equal(store.currentVersion(), 0)
    assert.equal(txns(store.txPending).length, 1, 'the envelope stays pending')
  } finally {
    cleanup()
  }
})
