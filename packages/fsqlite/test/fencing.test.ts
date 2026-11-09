// Publication requires exclusive lock ownership across arbitrary process pauses.
// Age is diagnostic only; abandoned-lock recovery requires verified quiescence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { LockTimeoutError, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest } from '../src/fsutil.ts'
import { ownerOf, setOwnerWriterForTest, withLock } from '../src/lock.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

test('a poll interval longer than timeout does not extend the acquisition deadline', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    mkdirSync(lockPath)
    const start = performance.now()
    assert.throws(() => {
      withLock(lockPath, () => undefined, { timeoutMs: 30, staleMs: 1, pollMs: 10_000 })
    }, LockTimeoutError)
    assert.ok(performance.now() - start < 2_000, 'the 10-second poll is capped by the deadline')
  } finally {
    cleanup()
  }
})

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

test('an arbitrarily old lock is never stolen, including when a legacy callback is supplied', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  try {
    // A crashed holder left the lock dir behind with an old mtime, past the stale window.
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), ownerRecord('dead-holder'))
    const oldTime = new Date(Date.now() - 10_000)
    utimesSync(lockPath, oldTime, oldTime)
    let ran = false
    let broken = false
    assert.throws(() => {
      withLock(
        lockPath,
        () => {
          ran = true
        },
        {
          timeoutMs: 60,
          staleMs: 1,
          pollMs: 5,
          onStaleBreak: () => {
            broken = true
          },
        },
      )
    }, LockTimeoutError)
    assert.equal(ran, false)
    assert.equal(broken, false)
    assert.equal(ownerOf(lockPath), 'dead-holder', 'age cannot prove that its owner is dead')
  } finally {
    cleanup()
  }
})

test('a malformed old lock is retained until quiescent recovery', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  mkdirSync(lockPath)
  const oldTime = new Date(Date.now() - 10_000)
  utimesSync(lockPath, oldTime, oldTime)
  try {
    assert.throws(() => {
      withLock(lockPath, () => undefined, { timeoutMs: 80, staleMs: 1, pollMs: 20 })
    }, /could not acquire/)
    assert.equal(existsSync(lockPath), true)
  } finally {
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

test('SnapshotStore refuses a foreign lock installed after its snapshot commit', () => {
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

    assert.throws(
      () =>
        store.reconcile({
          lockOpts: { staleMs: 1, timeoutMs: 60, pollMs: 1 },
        }),
      LockTimeoutError,
    )
    assert.equal(store.currentVersion(), 0)
    assert.equal(artifactCount(store), 0)
    assert.equal(ownerOf(store.publishLock), 'successor')
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
