// Adoption test: exercise the worked-example document-catalog schema and per-table merge
// policy through fsqlite, proving the generic package fits a realistic consumer. Imports
// the runnable example's schema/policy verbatim, so this test and the example can never
// drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore } from '../src/index.ts'
import { tmpStore } from './fixture.ts'
import { CATALOG_SCHEMA, CATALOG_POLICY } from '../examples/document-catalog.ts'
import type { StoreOptions } from '../src/types.ts'

const STORE: StoreOptions = {
  schema: CATALOG_SCHEMA,
  schemaVersion: 1,
  conflictPolicy: CATALOG_POLICY,
}
const now = (): string => new Date().toISOString()
const one = <T>(s: SnapshotStore, sql: string, ...a: (string | number)[]): T =>
  s.read((db) => db.prepare(sql).get(...a) as T)

test('the catalog schema merges correctly through fsqlite (lww + union)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const cat = new SnapshotStore(dir, STORE).init()
    cat.write('A', (db) => {
      db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run('u1', 'https://x', 'blob_a', now())
      db.prepare('INSERT INTO relationships VALUES (?,?,?,?,?,?,?)').run(
        'r1',
        'artifact',
        'art_1',
        'derived_from',
        'blob',
        'blob_a',
        now(),
      )
    })
    cat.write('B', (db) => {
      db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run('u1', 'https://x', 'blob_b', now()) // lww
      db.prepare('INSERT INTO relationships VALUES (?,?,?,?,?,?,?)').run(
        'r1',
        'artifact',
        'art_1',
        'derived_from',
        'blob',
        'blob_a',
        now(),
      ) // dup → union no-op
    })
    const res = cat.reconcile()
    assert.equal(res.applied, 2)
    assert.equal(res.quarantined, 0)
    assert.equal(
      one<{ blob_id: string }>(cat, 'SELECT blob_id FROM url_index WHERE url_hash=?', 'u1').blob_id,
      'blob_b',
      'url_index is last-writer-wins',
    )
    assert.equal(
      one<{ c: number }>(cat, 'SELECT COUNT(*) c FROM relationships').c,
      1,
      'relationships is set-union',
    )
  } finally {
    cleanup()
  }
})

test('a write to a table outside the catalog policy is denied by the strict default', () => {
  const { dir, cleanup } = tmpStore()
  try {
    // Add a stray table not covered by CATALOG_POLICY; '*' = strict means a clash on it
    // quarantines rather than silently merging.
    const cat = new SnapshotStore(dir, {
      ...STORE,
      schema: CATALOG_SCHEMA + '\nCREATE TABLE stray (k TEXT PRIMARY KEY NOT NULL, v TEXT);',
    }).init()
    cat.write('A', (db) => db.prepare('INSERT INTO stray VALUES (?,?)').run('k', 'A'))
    cat.write('B', (db) => db.prepare('INSERT INTO stray VALUES (?,?)').run('k', 'B'))
    const res = cat.reconcile()
    assert.equal(res.applied, 1)
    assert.equal(res.quarantined, 1, 'strict default quarantines the conflicting stray-table write')
  } finally {
    cleanup()
  }
})

test('content_blobs is content-addressed: a duplicate blob_id insert is a union no-op', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const cat = new SnapshotStore(dir, STORE).init()
    const ins =
      (id: string) =>
      (db: Parameters<Parameters<SnapshotStore['write']>[1]>[0]): void => {
        db.prepare('INSERT INTO content_blobs VALUES (?,?,?,?,?,?,?)').run(
          id,
          'sha',
          1,
          'text/html',
          'managed',
          `p/${id}`,
          now(),
        )
      }
    cat.write('A', ins('blob_x'))
    cat.write('B', ins('blob_x')) // same content-addressed id from a second writer
    cat.reconcile()
    assert.equal(
      one<{ c: number }>(cat, 'SELECT COUNT(*) c FROM content_blobs').c,
      1,
      'identical content-addressed blob dedups',
    )
  } finally {
    cleanup()
  }
})
