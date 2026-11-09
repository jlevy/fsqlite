// A published head is a standard SQLite file that any binding, language, or sqlite3 CLI
// can open without the session extension. These tests verify the SQLite header and the
// application_id and user_version pragmas used by other readers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FSQLITE_APPLICATION_ID, SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const SQLITE_MAGIC = 'SQLite format 3\0'
const head = (store: SnapshotStore): Buffer =>
  readFileSync(store.snapshotPath(store.currentVersion()))

test('a published snapshot is a standard SQLite file (magic header)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    store.reconcile()
    assert.equal(head(store).subarray(0, 16).toString('latin1'), SQLITE_MAGIC)
  } finally {
    cleanup()
  }
})

test('a published snapshot carries application_id and user_version for foreign capability checks', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, { ...STORE_OPTS, schemaVersion: 1 }).init()
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    store.reconcile()
    // Open the head as a plain reader (no session API used at all).
    const db = new DatabaseSync(store.snapshotPath(store.currentVersion()), { readOnly: true })
    try {
      assert.equal(
        (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
        FSQLITE_APPLICATION_ID,
      )
      assert.equal(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        1,
      )
      assert.equal(
        (
          db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('a') as {
            title: string
          }
        ).title,
        'A',
      )
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('a sealed single-file export is also a standard SQLite file', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(join(dir, 'store'), STORE_OPTS).init()
    store.write('A', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    store.reconcile()
    const out = join(dir, 'export.sqlite')
    store.seal(out)
    assert.equal(readFileSync(out).subarray(0, 16).toString('latin1'), SQLITE_MAGIC)
  } finally {
    cleanup()
  }
})
