// The typed error model: every error fsqlite raises on purpose is an FsqliteError whose
// stable `code` (and `retryable` flag) a caller can branch on without matching message
// text. The GC and retry suites cover lease I/O and captured transactions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ConflictError,
  DirectStore,
  FsqliteError,
  LockTimeoutError,
  PermanentConflictError,
  PostPublishError,
  PublishContentionError,
  SnapshotStore,
  StoreFormatError,
  StrictConflictError,
  readStoreMarker,
} from '../src/index.ts'
import type { FsqliteErrorCode } from '../src/index.ts'
import { setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

/** An assert.throws validator for an FsqliteError with `code` and `retryable`. */
const fsqliteError =
  (code: FsqliteErrorCode, retryable = false) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof FsqliteError, `expected an FsqliteError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    assert.equal(error.retryable, retryable, `${code} retryable`)
    return true
  }

const insertArtifact =
  (id: string) =>
  (db: DatabaseSync): void => {
    db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(id, id, 't')
  }

test('recognition failures carry their state as the error code', () => {
  const { dir, cleanup } = tmpStore()
  try {
    assert.throws(() => readStoreMarker(dir), fsqliteError('not-a-store'))
    writeFileSync(join(dir, 'fsqlite.json'), '[]')
    assert.throws(() => readStoreMarker(dir), fsqliteError('invalid'))
    writeFileSync(
      join(dir, 'fsqlite.json'),
      JSON.stringify({
        format: 'fsqlite',
        format_version: 'f9.0',
        required_features: [],
        store_id: randomUUID(),
      }),
    )
    assert.throws(
      () => readStoreMarker(dir),
      (error: unknown) =>
        error instanceof StoreFormatError &&
        error.state === 'unsupported' &&
        fsqliteError('unsupported')(error),
    )
  } finally {
    cleanup()
  }
})

test('a torn current pointer and a gc of a corrupt store are corrupt errors', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    writeFileSync(store.currentPath, 'xxx')
    assert.throws(() => store.currentVersion(), fsqliteError('corrupt'))
    assert.throws(() => store.gc(), fsqliteError('corrupt'))
  } finally {
    cleanup()
  }
})

test('a handle whose schema does not match the store is incompatible', () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    assert.throws(
      () => new SnapshotStore(dir, { ...STORE_OPTS, schemaVersion: 2 }).init(),
      fsqliteError('incompatible'),
    )
    assert.throws(
      () =>
        new SnapshotStore(join(dir, 'other'), {
          schema: 'CREATE TABLE t (x TEXT);',
        }).init(),
      fsqliteError('incompatible'),
    )
  } finally {
    cleanup()
  }
})

test('seal with a pending tail is refused', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('w', insertArtifact('a'))
    assert.throws(
      () => store.seal(join(dir, '..', `${randomUUID()}.sqlite`)),
      fsqliteError('refused'),
    )
  } finally {
    cleanup()
  }
})

test('repair under a live publisher lock is an in-flight, retryable refusal', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('live'))
    assert.throws(() => store.repair(), fsqliteError('in-flight', true))
  } finally {
    cleanup()
  }
})

test('a lock timeout is retryable and names the lock and the timeout', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('live'))
    const fresh = new Date(Date.now() + 60_000)
    utimesSync(store.publishLock, fresh, fresh)
    assert.throws(
      () => store.gc({ lockOpts: { staleMs: 100, timeoutMs: 150, pollMs: 5 } }),
      (error: unknown) =>
        error instanceof LockTimeoutError &&
        error.lockPath === store.publishLock &&
        error.timeoutMs === 150 &&
        fsqliteError('retryable', true)(error),
    )
  } finally {
    cleanup()
  }
})

test('a reconcile that loses every publish race is a PublishContentionError, not a lock timeout', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('w', insertArtifact('a'))
    // A DirectStore peer publishes after each reconcile build is durable and before that
    // reconcile takes the lock, so every attempt finds `current` moved. The peer leaves
    // the pending envelope alone, so the next attempt has work again.
    const peer = new DirectStore(dir, STORE_OPTS)
    let peerWrites = 0
    setAfterFsyncPathForTest((path) => {
      if (path.includes('.build-')) {
        peer.write(insertArtifact(`peer-${peerWrites++}`))
      }
    })
    assert.throws(
      () => store.reconcile({ maxRetries: 2 }),
      (error: unknown) =>
        error instanceof PublishContentionError &&
        !(error instanceof LockTimeoutError) &&
        error.attempts === 2 &&
        fsqliteError('retryable', true)(error),
    )
    assert.equal(peerWrites, 2, 'each attempt lost to a peer publication')
    setAfterFsyncPathForTest(null)
    assert.equal(store.reconcile().applied, 1, 'the envelope is still pending, not lost')
  } finally {
    setAfterFsyncPathForTest(null)
    cleanup()
  }
})

test('conflict errors expose their conflict types; only strict conflicts are retryable', () => {
  const strict = new StrictConflictError(['DATA'])
  const permanent = new PermanentConflictError(['CONSTRAINT', 'NOTFOUND'])
  assert.ok(strict instanceof ConflictError && permanent instanceof ConflictError)
  assert.deepEqual(strict.conflictTypes, ['DATA'])
  assert.deepEqual(permanent.conflictTypes, ['CONSTRAINT', 'NOTFOUND'])
  assert.ok(fsqliteError('conflict', true)(strict))
  assert.ok(fsqliteError('conflict', false)(permanent))
  assert.equal(strict.message, 'strict conflict (DATA)')
})

test('a strict conflict is recorded with a machine reason code that writeWithRetry reads', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const opts = { ...STORE_OPTS, conflictPolicy: { '*': 'strict' as const } }
    const store = new SnapshotStore(dir, opts).init()
    store.write('a', insertArtifact('same'))
    const loser = store.write('b', insertArtifact('same'))
    store.reconcile()
    const reason = readFileSync(
      join(store.txQuarantine, `${loser ?? ''}.txn`, 'QUARANTINE'),
      'utf8',
    )
    assert.equal(reason, 'strict-conflict: CONFLICT')
  } finally {
    cleanup()
  }
})

test('a failure after publication is a PostPublishError naming the published version', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('w', insertArtifact('a'))
    const txId = store.write('t', insertArtifact('b'))
    const txDir = join(store.txPending, `${txId ?? ''}.txn`)
    writeFileSync(join(txDir, 'changeset.bin'), 'tampered')
    mkdirSync(join(txDir, 'QUARANTINE')) // the reason file cannot be written
    assert.throws(
      () => store.reconcile(),
      (error: unknown) =>
        error instanceof PostPublishError &&
        error.published === 1 &&
        fsqliteError('post-publish')(error),
    )
  } finally {
    cleanup()
  }
})

test('argument validation throws TypeError, not a store error', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    assert.throws(() => store.write('../escape', insertArtifact('a')), TypeError)
    assert.throws(
      () => new SnapshotStore(dir, { conflictPolicy: { t: 'toString' as 'lww' } }),
      TypeError,
    )
  } finally {
    cleanup()
  }
})
