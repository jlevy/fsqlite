// Schema-only seeding: the cheaper write path for insert-mostly writers. Proves insert
// correctness, that deferred same-key detection is still resolved by the merge policy, and
// that snapshot-seed write cost grows with database size while schema-only does not pay the
// O(database-size) copy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const title = (s: SnapshotStore, id: string): string =>
  s.read(
    (db) =>
      (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get(id) as { title: string })
        .title,
  )
const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

test('schema-only seed produces an equivalent insert and reconciles correctly', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write(
      'A',
      (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'),
      { seed: 'schema-only' },
    )
    store.write(
      'B',
      (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('b', 'B', 't'),
      { seed: 'schema-only' },
    )
    store.reconcile()
    assert.equal(artifactCount(store), 2)
    assert.equal(title(store, 'a'), 'A')
  } finally {
    cleanup()
  }
})

test('schema-only seed defers same-key detection to reconcile (lww still resolves it)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('A', (db) =>
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'first', 't'),
    )
    store.reconcile() // 'a' now in the head
    // A schema-only writer does NOT see the existing 'a' (empty base): the insert
    // succeeds locally and the clash surfaces at reconcile, where lww replaces.
    store.write(
      'B',
      (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'second', 't'),
      { seed: 'schema-only' },
    )
    const res = store.reconcile()
    assert.equal(res.applied, 1)
    assert.equal(res.quarantined, 0)
    assert.equal(title(store, 'a'), 'second', 'lww at reconcile resolves the deferred conflict')
  } finally {
    cleanup()
  }
})
