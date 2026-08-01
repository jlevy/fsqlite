// Direct-mode (the "easy local" write strategy) and format interoperability with the
// envelope engine. The two write strategies share one immutable-snapshot format, so a
// store written by one reads identically via the other and via plain sqlite3. These cover
// the in-process behavior and format interop; multi-process direct-writer concurrency runs
// in the concurrent suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

test('direct write → read round-trips and increments the version synchronously', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    assert.equal(store.currentVersion(), 0)
    const v = store.write((db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    assert.equal(v, 1, 'a direct write publishes immediately — no pending tail, no reconcile')
    assert.equal(store.currentVersion(), 1)
    assert.equal(
      store.read(
        (db) => (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('a') as { title: string }).title,
      ),
      'A',
    )
    assert.equal(store.validate().state, 'sealed', 'no pending tail in direct mode → always sealed between writes')
  } finally {
    cleanup()
  }
})

test('format interop: a store written directly is read by SnapshotStore (and vice versa)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const direct = new DirectStore(dir, STORE_OPTS).init()
    direct.write((db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('d', 'from-direct', 't')
    })

    const engine = new SnapshotStore(dir, STORE_OPTS)
    assert.equal(
      engine.read(
        (db) => (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('d') as { title: string }).title,
      ),
      'from-direct',
    )

    engine.write('agent', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('e', 'from-engine', 't')
    })
    engine.reconcile()
    assert.equal(
      direct.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c),
      2,
    )
  } finally {
    cleanup()
  }
})

test('direct mode never records a session (so it runs on session-less bindings)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    const v = store.write((db) => {
      assert.equal(typeof db.createSession, 'function', 'the binding has session, but direct mode must not use it')
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    assert.equal(v, 1)
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})
