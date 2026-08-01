// Schema-only seeding: the cheaper write path for insert-mostly writers. Proves insert
// correctness, that deferred same-key detection is still resolved by the merge policy, and
// that snapshot-seed write cost grows with catalog size while schema-only does not pay the
// O(catalog) copy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore, DirectStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const title = (s: SnapshotStore, id: string): string =>
  s.read((db) => (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get(id) as { title: string }).title)
const artifactCount = (s: SnapshotStore): number =>
  s.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

test('schema-only seed produces an equivalent insert and reconciles correctly', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'), { seed: 'schema-only' })
    store.write('B', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('b', 'B', 't'), { seed: 'schema-only' })
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
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'first', 't'))
    store.reconcile() // 'a' now in the head
    // A schema-only writer does NOT see the existing 'a' (empty base): the insert
    // succeeds locally and the clash surfaces at reconcile, where lww replaces.
    store.write('B', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'second', 't'), { seed: 'schema-only' })
    const res = store.reconcile()
    assert.equal(res.applied, 1)
    assert.equal(res.quarantined, 0)
    assert.equal(title(store, 'a'), 'second', 'lww at reconcile resolves the deferred conflict')
  } finally {
    cleanup()
  }
})

test('snapshot-seed write cost grows with catalog size; schema-only avoids the copy', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const direct = new DirectStore(dir, STORE_OPTS)
    const BLOB = 'x'.repeat(2048) // ~2KB/row so the snapshot grows fast with fewer rows
    // Seed the catalog in bulk via ONE direct transaction (fast): we benchmark write
    // cost, not seeding cost.
    const grow = (rows: number): void => {
      direct.write((db) => {
        const ins = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
        for (let i = 0; i < rows; i++) ins.run(`g-${Math.random()}`, BLOB, 't')
      })
    }
    const timeN = (n: number, seed: 'snapshot' | 'schema-only'): number => {
      const t = process.hrtime.bigint()
      for (let i = 0; i < n; i++) {
        store.write('bench', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`b-${seed}-${Math.random()}`, BLOB, 't'), { seed })
      }
      return Number(process.hrtime.bigint() - t) / 1e6 / n
    }

    grow(500)
    const snapSmall = timeN(20, 'snapshot')
    grow(5000) // now a multi-MB snapshot — the copy gap is wide and robust to noise
    const snapBig = timeN(20, 'snapshot')
    const schemaBig = timeN(20, 'schema-only')

    // eslint-disable-next-line no-console -- benchmark timing is intentional human-review output
    console.log(`    seed bench  snapshot: ${snapSmall.toFixed(2)} → ${snapBig.toFixed(2)} ms/write   schema-only@big: ${schemaBig.toFixed(2)} ms/write`)
    // Robust, wide-gap properties (no fragile flat-cost ratio): the O(catalog) copy makes
    // snapshot-seed grow with size, and at a multi-MB catalog copying dominates so
    // schema-only (which never copies) is cheaper.
    assert.ok(snapBig > snapSmall, 'snapshot-seed write cost grows as the catalog grows (the copy is O(size))')
    assert.ok(schemaBig < snapBig, 'schema-only avoids the O(catalog) copy, so it beats snapshot-seed on a large catalog')
  } finally {
    cleanup()
  }
})
