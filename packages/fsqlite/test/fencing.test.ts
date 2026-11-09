// Fencing / lease semantics of the publish lock. The publish lock is the only
// mutual-exclusion point, and correctness must not depend on it being perfect. These
// tests pin the three properties that make that true:
//   - revalidate-before-publish: a holder whose lease was stolen aborts (the
//     ownerOf(lockPath) === token check) instead of writing under a new owner
//   - stale-break: a lock older than staleMs is reclaimable (no permanent wedge)
//   - the timeoutMs > staleMs invariant is enforced

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DirectStore, LockTimeoutError, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest } from '../src/fsutil.ts'
import { ownerOf, setOwnerWriterForTest, setStaleLockMoverForTest, withLock } from '../src/lock.ts'
import type { LockOptions } from '../src/lock.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

test('withLock enforces timeoutMs > staleMs before touching the lock path', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    assert.throws(
      () => withLock(lockPath, () => 0, { timeoutMs: 100, staleMs: 100 }),
      (error: unknown) =>
        error instanceof TypeError && error.message.includes('requires timeoutMs > staleMs'),
    )
    assert.equal(existsSync(lockPath), false)
  } finally {
    cleanup()
  }
})

test('every lockOpts entry point rejects an invalid window before touching a live lock or build', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const direct = new DirectStore(dir, STORE_OPTS)
    store.write('w', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    // A live publisher: a fresh lock and its build in flight.
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('live'))
    const build = join(store.snapDir, '.build-live.sqlite')
    writeFileSync(build, 'a live build')
    const invalid: LockOptions[] = [
      { staleMs: 0 },
      { staleMs: -1 },
      { staleMs: Number.NaN },
      { pollMs: 0 },
      { pollMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { onStaleBreak: 'log' as unknown as null },
    ]
    const entryPoints: Record<string, (lockOpts: LockOptions) => unknown> = {
      reconcile: (lockOpts) => store.reconcile({ lockOpts }),
      gc: (lockOpts) => store.gc({ retain: 0, lockOpts }),
      repair: (lockOpts) => store.repair({ lockOpts }),
      planRepair: (lockOpts) => store.planRepair({ lockOpts }),
      'DirectStore.write': (lockOpts) => direct.write(() => undefined, { lockOpts }),
    }
    for (const lockOpts of invalid) {
      for (const [name, run] of Object.entries(entryPoints)) {
        assert.throws(
          () => run(lockOpts),
          (error: unknown) => error instanceof TypeError && error.message.includes('lockOpts'),
          `${name} accepted ${String(Object.values(lockOpts)[0])}`,
        )
      }
    }
    assert.equal(ownerOf(store.publishLock), 'live', 'the live lock was not broken')
    assert.ok(existsSync(build), 'the live build was not removed')
    assert.equal(store.pendingTxns().length, 1, 'nothing was reconciled')
  } finally {
    cleanup()
  }
})

test('a holder whose lease was stolen fails its fence and leaves the successor lock alone', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    const result = withLock(
      lockPath,
      (_token, lease) => {
        // A stale break and re-acquisition by a second holder while this one was paused:
        // the lock dir is reclaimed and re-owned by a different token.
        rmSync(lockPath, { recursive: true, force: true })
        mkdirSync(lockPath)
        writeFileSync(join(lockPath, 'owner.json'), ownerRecord('successor'))
        return { fenced: lease.fence(), renewed: lease.heartbeat() }
      },
      { timeoutMs: 5000, staleMs: 1000 },
    )
    assert.deepEqual(result, { fenced: false, renewed: false }, 'both checks report the loss')
    // The fenced release removes the lock only while this holder owns it.
    assert.equal(ownerOf(lockPath), 'successor', "the successor's lock survives the release")
  } finally {
    cleanup()
  }
})

test('a stale lock (older than staleMs) is reclaimed, not a permanent wedge', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    // A crashed holder left the lock dir behind with an old mtime, past the stale window.
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), ownerRecord('dead-holder'))
    const oldTime = new Date(Date.now() - 10_000)
    utimesSync(lockPath, oldTime, oldTime)
    let ran = false
    const out = withLock(
      lockPath,
      () => {
        ran = true
        return 'ok'
      },
      { timeoutMs: 3000, staleMs: 500, pollMs: 10 },
    )
    assert.equal(out, 'ok')
    assert.equal(ran, true, 'a stale lock must be breakable so a live worker can proceed')
  } finally {
    cleanup()
  }
})

test('a failed stale-lock removal backs off until timeout', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  mkdirSync(lockPath)
  const oldTime = new Date(Date.now() - 10_000)
  utimesSync(lockPath, oldTime, oldTime)
  let attempts = 0
  setStaleLockMoverForTest(() => {
    attempts++
    const error = new Error('injected stale removal failure') as NodeJS.ErrnoException
    error.code = 'EPERM'
    throw error
  })
  try {
    assert.throws(() => {
      withLock(lockPath, () => undefined, { timeoutMs: 80, staleMs: 1, pollMs: 20 })
    }, /could not acquire/)
    assert.ok(attempts <= 5, `stale removal should poll rather than spin; attempts=${attempts}`)
  } finally {
    setStaleLockMoverForTest(null)
    cleanup()
  }
})

test('a stale-lock break never deletes a successor that re-acquired the lock first', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  mkdirSync(lockPath)
  writeFileSync(join(lockPath, 'owner.json'), ownerRecord('dead-holder'))
  const oldTime = new Date(Date.now() - 10_000)
  utimesSync(lockPath, oldTime, oldTime)
  setStaleLockMoverForTest((from, to) => {
    setStaleLockMoverForTest(null)
    // A second waiter judged the same lock stale, broke it first, and now holds a fresh
    // lock (its mtime is in the future so it stays fresh for the whole test)...
    rmSync(from, { recursive: true, force: true })
    mkdirSync(from)
    writeFileSync(join(from, 'owner.json'), ownerRecord('successor'))
    const fresh = new Date(Date.now() + 60_000)
    utimesSync(from, fresh, fresh)
    // ...and only then does this waiter's own break land.
    renameSync(from, to)
  })
  try {
    assert.throws(() => {
      withLock(lockPath, () => undefined, { timeoutMs: 150, staleMs: 100, pollMs: 5 })
    }, LockTimeoutError)
    assert.equal(ownerOf(lockPath), 'successor', "the successor's live lock survives the break")
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry !== 'publish.lock'),
      [],
      'no lock grave is left behind',
    )
  } finally {
    setStaleLockMoverForTest(null)
    cleanup()
  }
})

test('a failed owner metadata write does not orphan the lock directory', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'owner-write-fails.lock')
  setOwnerWriterForTest(() => {
    const error = new Error('injected owner write failure') as NodeJS.ErrnoException
    error.code = 'ENOSPC'
    throw error
  })
  try {
    assert.throws(() => {
      withLock(
        lockPath,
        () => {
          return undefined
        },
        { timeoutMs: 100, staleMs: 50 },
      )
    }, /injected owner write failure/)
    assert.equal(existsSync(lockPath), false)
  } finally {
    setOwnerWriterForTest(null)
    cleanup()
  }
})

test('OCC on the pointer: a reconcile that builds against a superseded base converges to a no-op', () => {
  // Two SnapshotStore handles on the same dir = two reconcilers. handle1 publishes v1;
  // handle2, which read base=0, must detect current moved and converge (its view of the
  // tail already in v1): never corrupt.
  const { dir, cleanup } = tmpStore()
  try {
    const s1 = new SnapshotStore(dir, STORE_OPTS).init()
    s1.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    const s2 = new SnapshotStore(dir, STORE_OPTS)

    const r1 = s1.reconcile()
    assert.equal(r1.published, 1)
    const r2 = s2.reconcile()
    assert.equal(r2.applied, 0)
    assert.equal(s2.currentVersion(), 1)
    assert.equal(artifactCount(s2), 1)
  } finally {
    cleanup()
  }
})

test('SnapshotStore retries when its lease is stolen after the snapshot rename', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('writer', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    setAfterFsyncDirForTest((path) => {
      if (path !== store.snapDir) {
        return
      }
      setAfterFsyncDirForTest(null)
      rmSync(store.publishLock, { recursive: true, force: true })
      mkdirSync(store.publishLock)
      writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('successor'))
      const old = new Date(Date.now() - 10_000)
      utimesSync(store.publishLock, old, old)
    })

    const result = store.reconcile({
      lockOpts: { staleMs: 1, timeoutMs: 500, pollMs: 1 },
    })

    assert.equal(result.attempts, 2)
    assert.equal(result.applied, 1)
    assert.equal(artifactCount(store), 1)
    assert.equal(store.validate().state, 'sealed')
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

test('a malformed owner record names no owner, so no holder can fence on it', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    mkdirSync(lockPath)
    for (const record of ['{"token":"partial"}', '{"token":7,"pid":1,"host":"h","at":0}', '[]']) {
      writeFileSync(join(lockPath, 'owner.json'), record)
      assert.equal(ownerOf(lockPath), null, record)
    }
    writeFileSync(join(lockPath, 'owner.json'), ownerRecord('complete'))
    assert.equal(ownerOf(lockPath), 'complete')
  } finally {
    cleanup()
  }
})
