// Publication holds a non-stealable lock through the pointer rename. Tests also inject
// out-of-protocol replacement to cover defensive identity and ledger checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DirectStore, LockTimeoutError, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest, setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { ownerOf } from '../src/lock.ts'
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

for (const strategy of ['direct', 'snapshot'] as const) {
  test(`${strategy}: a publisher paused after its final checks retains exclusive ownership`, () => {
    const { dir, cleanup } = tmpStore()
    try {
      const store = new SnapshotStore(dir, STORE_OPTS).init()
      const direct = new DirectStore(dir, STORE_OPTS)
      if (strategy === 'snapshot') {
        store.write('wx', insert('x'))
      }
      let reached = false
      setAfterFsyncPathForTest((path) => {
        if (!path.startsWith(`${store.currentPath}.`)) {
          return
        }
        setAfterFsyncPathForTest(null)
        reached = true
        // This is the former rollback window: all OCC/token/identity checks passed,
        // and the very next operation blindly renames this pointer over current.
        const token = ownerOf(store.publishLock)
        const past = new Date(Date.now() - 120_000)
        utimesSync(store.publishLock, past, past)
        const lockOpts = { staleMs: 1, timeoutMs: 40, pollMs: 2 }
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.throws(
            () =>
              strategy === 'direct'
                ? direct.write(insert('peer'), { lockOpts })
                : store.reconcile({ lockOpts }),
            LockTimeoutError,
          )
        }
        assert.equal(ownerOf(store.publishLock), token)
        assert.equal(store.currentVersion(), 0)
        assert.deepEqual(rowsOf(store.snapshotPath(1)), ['x'])
      })
      const published =
        strategy === 'direct' ? direct.write(insert('x')) : store.reconcile().published
      assert.equal(reached, true)
      assert.equal(published, 1)
      assert.equal(direct.write(insert('y')), 2)
      assert.equal(direct.write(insert('z')), 3)
      assert.equal(store.currentVersion(), 3)
      assert.deepEqual(rowsOf(store.snapshotPath(1)), ['x'])
      assert.deepEqual(rowsOf(store.snapshotPath(3)), ['x', 'y', 'z'])
    } finally {
      setAfterFsyncPathForTest(null)
      cleanup()
    }
  })
}

/**
 * A complete, valid build from snapshot 0 carrying one foreign row, as an overlapping
 * publisher would produce. It is aged past the default diagnostic window to prove that
 * age never grants publication permission to reclaim it.
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

    assert.throws(() => store.reconcile(), /already exists ahead of current/)
    assert.equal(store.currentVersion(), 0)
    assert.deepEqual(rowsOf(store.snapshotPath(1)), ['foreign'])
    assert.deepEqual(txns(store.txPending), [`${x}.txn`])
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

for (const age of ['fresh', 'old'] as const) {
  test(`a publisher preserves an unexplained ${age} entry ahead of current`, () => {
    const { dir, cleanup } = tmpStore()
    try {
      const store = new SnapshotStore(dir, STORE_OPTS).init()
      store.write('wx', insert('x'))
      const occupant = foreignBuild(store, dir)
      if (age === 'fresh') {
        const future = new Date(Date.now() + 60_000)
        utimesSync(occupant, future, future)
      }
      renameSync(occupant, store.snapshotPath(1))

      assert.throws(
        () => store.reconcile({ lockOpts: { staleMs: 50, timeoutMs: 100, pollMs: 5 } }),
        /snapshot 1 already exists ahead of current/,
      )

      assert.deepEqual(rowsOf(store.snapshotPath(1)), ['foreign'], 'the live entry is untouched')
      assert.equal(store.currentVersion(), 0)
      assert.equal(txns(store.txPending).length, 1, 'the envelope stays pending')
      assert.deepEqual(
        readdirSync(store.snapDir).filter((f) => f.startsWith('.build-')),
        [],
        'the abandoned build is removed',
      )
    } finally {
      cleanup()
    }
  })
}

test('reconcile archives only envelopes the ledger of the head now named by current holds', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const x = store.write('wx', insert('x'))
    const torn = store.write('wt', insert('t'))
    writeFileSync(join(store.txPending, `${torn}.txn`, 'changeset.bin'), 'tampered')
    setAfterFsyncDirForTest((path) => {
      if (path === dir) {
        setAfterFsyncDirForTest(null)
        // A holder that stalled between its final checks and its pointer rename resumes
        // and renames its stale pointer value over current (spec L5).
        writeFileSync(`${store.currentPath}.late.tmp`, '0')
        renameSync(`${store.currentPath}.late.tmp`, store.currentPath)
      }
    })

    store.reconcile()

    assert.equal(store.currentVersion(), 0)
    assert.deepEqual(
      txns(store.txPending).sort(),
      [`${x}.txn`, `${torn}.txn`].sort(),
      'the head current names lacks both, so neither is archived or quarantined yet',
    )
    assert.deepEqual(txns(store.txApplied), [])

    assert.throws(() => store.reconcile(), /already exists ahead of current/)
    store.repair() // no transaction was archived, so explicit recovery can retain the head
    const recovered = store.reconcile()

    assert.equal(recovered.applied, 1)
    assert.equal(recovered.quarantined, 1)
    assert.ok(ledgerOf(store.snapshotPath(store.currentVersion())).includes(x ?? ''))
    assert.deepEqual(txns(store.txQuarantine), [`${torn}.txn`])
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

/** A committed envelope that reconcile will quarantine but cannot record a reason for. */
function unquarantinableEnvelope(store: SnapshotStore): void {
  const txId = store.write('wt', insert('t'))
  const txDir = join(store.txPending, `${txId}.txn`)
  writeFileSync(join(txDir, 'changeset.bin'), 'tampered')
  mkdirSync(join(txDir, 'QUARANTINE')) // the reason file cannot be written
}

const publishedVersionOf = (error: unknown): unknown =>
  error instanceof Error && 'published' in error ? error.published : undefined

test('a reconcile failure after the pointer swap reports the version it published', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const x = store.write('wx', insert('x'))
    unquarantinableEnvelope(store)

    assert.throws(
      () => store.reconcile(),
      (error: unknown) => publishedVersionOf(error) === 1,
    )
    assert.equal(store.currentVersion(), 1)
    assert.ok(ledgerOf(store.snapshotPath(1)).includes(x ?? ''))
  } finally {
    cleanup()
  }
})

test('writeWithRetry returns a published transaction instead of failing after its publication', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    unquarantinableEnvelope(store)
    let calls = 0

    const result = store.writeWithRetry('wx', (db) => {
      calls++
      insert('x')(db)
    })

    assert.equal(result.attempts, 1)
    assert.equal(calls, 1, 'fn is never re-run once its transaction is published')
    assert.ok(ledgerOf(store.snapshotPath(store.currentVersion())).includes(result.txId ?? ''))
  } finally {
    cleanup()
  }
})

test('a DirectStore barrier failure after the pointer rename reports the published version', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    setAfterFsyncDirForTest((path) => {
      if (path === dir) {
        setAfterFsyncDirForTest(null)
        throw Object.assign(new Error('injected store root fsync failure'), { code: 'EIO' })
      }
    })

    assert.throws(
      () => store.write(insert('a')),
      (error: unknown) => publishedVersionOf(error) === 1,
    )
    assert.equal(store.currentVersion(), 1, 'the version is visible, so the caller must not rerun')
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})
