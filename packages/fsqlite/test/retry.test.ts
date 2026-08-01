// Granular optimistic-concurrency retry: a read-modify-write on a `strict` row must not
// lose updates. Two writers increment the same counter from the same base; with
// writeWithRetry the loser re-seeds from the published snapshot and re-applies, so both
// increments land: no global lock, conflict resolved at row granularity.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore } from '../src/index.ts'
import { tmpStore } from './fixture.ts'
import type { StoreOptions } from '../src/types.ts'
import type { DatabaseSync } from 'node:sqlite'

const OPTS: StoreOptions = {
  schema: 'CREATE TABLE counters (k TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL);',
  schemaVersion: 1,
  conflictPolicy: { '*': 'strict' },
}

const increment = (db: DatabaseSync): void => {
  const cur = db.prepare('SELECT n FROM counters WHERE k=?').get('c') as { n: number } | undefined
  if (cur) {
    db.prepare('UPDATE counters SET n=? WHERE k=?').run(cur.n + 1, 'c')
  } else {
    db.prepare('INSERT INTO counters VALUES (?,?)').run('c', 1)
  }
}

const counter = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT n FROM counters WHERE k=?').get('c') as { n: number }).n)

test('writeWithRetry prevents a lost update on a strict read-modify-write', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const a = new SnapshotStore(dir, OPTS).init()
    a.writeWithRetry('seed', increment) // c = 1 (v1)
    assert.equal(counter(a), 1)

    // Two separate handles both increment. Even if their writes interleave, retry makes
    // the second re-seed from the first's published value rather than overwrite it.
    const w1 = new SnapshotStore(dir, OPTS)
    const w2 = new SnapshotStore(dir, OPTS)
    const r1 = w1.writeWithRetry('w1', increment)
    const r2 = w2.writeWithRetry('w2', increment)
    assert.equal(counter(w1), 3, 'both increments landed: 1 → 2 → 3 (no lost update)')
    assert.ok(r1.txId && r2.txId)
  } finally {
    cleanup()
  }
})

test('writeWithRetry re-seeds after a genuine concurrent conflict (forced interleave)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const base = new SnapshotStore(dir, OPTS).init()
    base.writeWithRetry('seed', increment) // c = 1 at v1

    const w1 = new SnapshotStore(dir, OPTS)
    const w2 = new SnapshotStore(dir, OPTS)
    // w1 emits an increment envelope without reconciling it.
    const tx1 = w1.write('w1', increment)
    assert.ok(tx1)
    // w2 uses the retry loop: its first attempt is based on v1, but reconcile() folds w1
    // first because its txid sorts earlier. w2 then has a DATA conflict on 'c', is
    // quarantined, reseeds from v2, and reapplies so c becomes 3.
    const r2 = w2.writeWithRetry('w2', increment)
    assert.equal(counter(w2), 3)
    assert.equal(r2.conflicted, true, 'the retry path was exercised')
    assert.ok(r2.attempts >= 2)
  } finally {
    cleanup()
  }
})

test('writeWithRetry reports a permanent quarantine without retrying it', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, { ...OPTS, maxEnvelopeBytes: 1 }).init()
    let calls = 0
    assert.throws(
      () =>
        store.writeWithRetry('too-large', (db) => {
          calls++
          db.prepare('INSERT INTO counters VALUES (?,?)').run('c', 1)
        }),
      /permanently quarantined: envelope-too-large/,
    )
    assert.equal(calls, 1, 'permanent failures must not be retried')
  } finally {
    cleanup()
  }
})
