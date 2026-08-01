// init() guarantees: the NON-NULL primary key contract, schema/version compatibility on
// reopen, and a fenced first-open so concurrent initializers converge on one clean
// snapshot 0 (never a torn or half-built one).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'
import { runAsync } from './spawn.ts'

test('init enforces the NON-NULL primary key contract', () => {
  const cases: [string, RegExp | null][] = [
    ['CREATE TABLE t (a TEXT, b TEXT);', /primary key/i], // no PK at all
    ['CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT);', /primary key/i], // nullable TEXT PK (SQLite quirk)
    ['CREATE TABLE t (k TEXT PRIMARY KEY NOT NULL, v TEXT);', null], // explicit NOT NULL PK
    ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);', null], // INTEGER PK is a non-null rowid alias
  ]
  for (const [schema, expectErr] of cases) {
    const { dir, cleanup } = tmpStore()
    try {
      const init = (): unknown => new SnapshotStore(dir, { schema, schemaVersion: 1 }).init()
      if (expectErr) {
        assert.throws(init, expectErr, `should reject: ${schema}`)
      } else {
        assert.doesNotThrow(init, `should accept: ${schema}`)
      }
    } finally {
      cleanup()
    }
  }
})

test('init rejects reopening a store with an incompatible schema version', () => {
  const { dir, cleanup } = tmpStore()
  const schema = 'CREATE TABLE t (k TEXT PRIMARY KEY NOT NULL);'
  try {
    new SnapshotStore(dir, { schema, schemaVersion: 1 }).init()
    assert.throws(
      () => new SnapshotStore(dir, { schema, schemaVersion: 2 }).init(),
      /schema version|incompatible/i,
      'a different schemaVersion on reopen must be surfaced, not silently accepted',
    )
  } finally {
    cleanup()
  }
})

test('init rejects reopening a store with a divergent schema at the SAME version', () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, {
      schema: 'CREATE TABLE a (k TEXT PRIMARY KEY NOT NULL);',
      schemaVersion: 1,
    }).init()
    assert.throws(
      () =>
        new SnapshotStore(dir, {
          schema: 'CREATE TABLE b (k TEXT PRIMARY KEY NOT NULL);',
          schemaVersion: 1,
        }).init(),
      /schema is incompatible|schema_hash/i,
      'a changed DDL without a schemaVersion bump must be rejected, not silently accepted',
    )
    // Reopening with the original DDL still succeeds (the hash matches).
    assert.doesNotThrow(
      () =>
        new SnapshotStore(dir, {
          schema: 'CREATE TABLE a (k TEXT PRIMARY KEY NOT NULL);',
          schemaVersion: 1,
        }).init(),
      'the matching schema reopens cleanly',
    )
  } finally {
    cleanup()
  }
})

test('concurrent first-open with mismatched schemas: the losers reject, the store stays consistent', () => {
  const { dir, cleanup } = tmpStore()
  try {
    // Two distinct schemas race to create snapshot 0; exactly one wins, and every handle that
    // reopens with a schema different from the winner's must fail _verifyCompatible.
    const schemaA = 'CREATE TABLE a (k TEXT PRIMARY KEY NOT NULL);'
    const schemaB = 'CREATE TABLE b (k TEXT PRIMARY KEY NOT NULL);'
    const attempts = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? schemaA : schemaB))
    const outcomes = attempts.map((schema) => {
      try {
        new SnapshotStore(dir, { schema, schemaVersion: 1 }).init()
        return schema
      } catch {
        return null
      }
    })
    const winners = new Set(outcomes.filter((o) => o !== null))
    assert.equal(winners.size, 1, 'only the schema that created snapshot 0 may init successfully')
    assert.ok(
      outcomes.some((o) => o === null),
      'handles with the other schema were rejected, not silently accepted',
    )
  } finally {
    cleanup()
  }
})

test('N processes initializing one fresh store concurrently converge on a clean snapshot 0', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, () => runAsync<{ ok: boolean }>('init-worker.ts', [dir])),
    )
    assert.ok(
      results.every((r) => r.ok),
      'every concurrent initializer succeeded',
    )
    const store = new SnapshotStore(dir, STORE_OPTS)
    assert.equal(store.currentVersion(), 0, 'exactly the initial published version')
    assert.notEqual(
      store.validate().state,
      'corrupt',
      'snapshot 0 is integrity-clean after the race',
    )
    const snaps = readdirSync(store.snapDir)
    assert.deepEqual(
      snaps.filter((f) => f.endsWith('.sqlite')).sort(),
      ['000000000000.fsqlite.sqlite'],
      'exactly one snapshot 0, no duplicate or partial snapshot files',
    )
    assert.equal(
      snaps.filter((f) => f.endsWith('.tmp') || f.startsWith('.build-')).length,
      0,
      'no orphan temp/build files left by the race',
    )
    const tables = store.read(
      (db) =>
        (
          db
            .prepare(
              "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('artifacts','applied_tx')",
            )
            .get() as { c: number }
        ).c,
    )
    assert.equal(tables, 2, 'the caller schema and the applied_tx ledger are both present')
  } finally {
    cleanup()
  }
})
