// init() guarantees: the NON-NULL primary key contract, schema/version compatibility on
// reopen, and a fenced first-open so concurrent initializers converge on one clean
// snapshot 0 (never a torn or half-built one).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, FsqliteError, SnapshotStore } from '../src/index.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'
import type { StoreOptions } from '../src/types.ts'
import { runAsync } from './spawn.ts'
import { setOwnerWriterForTest } from '../src/lock.ts'
import { setAfterFsyncDirForTest } from '../src/fsutil.ts'

test('init enforces the NON-NULL primary key contract', () => {
  const cases: [string, RegExp | null][] = [
    ['CREATE TABLE t (a TEXT, b TEXT);', /primary key/i], // no PK at all
    ['CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT);', /primary key/i], // nullable TEXT PK (SQLite quirk)
    ['CREATE TABLE t (k TEXT PRIMARY KEY NOT NULL, v TEXT);', null], // explicit NOT NULL PK
    ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);', null], // INTEGER PK is a non-null rowid alias
    // A column-level DESC key is not a rowid alias and admits NULL, which sessions drop.
    ['CREATE TABLE t (id INTEGER PRIMARY KEY DESC, v TEXT);', /not a rowid alias/],
    ['CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY DESC, v TEXT);', null],
    ['CREATE TABLE t (id INTEGER, v TEXT, PRIMARY KEY (id DESC));', null], // still an alias
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

test('SnapshotStore init rejects a caller schema that declares a trigger', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const schema = `
      CREATE TABLE doc (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE audit (id TEXT PRIMARY KEY NOT NULL);
      CREATE TRIGGER doc_audit AFTER INSERT ON doc BEGIN INSERT INTO audit VALUES (NEW.id); END;
    `
    assert.throws(
      () => new SnapshotStore(dir, { schema, schemaVersion: 1 }).init(),
      /SnapshotStore does not support triggers: .*"doc_audit" on table "doc".*DirectStore/,
    )
    assert.equal(existsSync(join(dir, 'current')), false)
  } finally {
    cleanup()
  }
})

test('SnapshotStore rejects a key constraint whose ON CONFLICT clause hides apply conflicts', () => {
  // A declared REPLACE or IGNORE resolution on a primary key or UNIQUE constraint resolves
  // the changeset apply's own statements, so a clash never reaches the merge policy: rows
  // are deleted or dropped while the envelope is ledgered as applied.
  const cases: [string, boolean][] = [
    ['CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT UNIQUE ON CONFLICT REPLACE);', false],
    ['CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT UNIQUE ON CONFLICT IGNORE);', false],
    ['CREATE TABLE t (id TEXT PRIMARY KEY ON CONFLICT REPLACE NOT NULL, u TEXT);', false],
    ['CREATE TABLE t (id TEXT NOT NULL, u TEXT, PRIMARY KEY (id) ON CONFLICT IGNORE);', false],
    [
      'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT, UNIQUE (u) ON  conflict\nreplace);',
      false,
    ],
    // Clauses that abort still surface as conflicts, and a NOT NULL default is applied at capture.
    ['CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT UNIQUE ON CONFLICT ROLLBACK);', true],
    ['CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT UNIQUE ON CONFLICT FAIL);', true],
    [
      "CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'd');",
      true,
    ],
    // The words inside a comment, a string, or a quoted identifier are not a clause.
    [
      "CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, u TEXT DEFAULT 'on conflict replace'); -- unique on conflict ignore",
      true,
    ],
    [
      'CREATE TABLE "on conflict replace" (id TEXT PRIMARY KEY NOT NULL /* unique on conflict replace */);',
      true,
    ],
  ]
  for (const [schema, accepted] of cases) {
    const { dir, cleanup } = tmpStore()
    try {
      const init = (): unknown => new SnapshotStore(dir, { schema, schemaVersion: 1 }).init()
      if (accepted) {
        assert.doesNotThrow(init, `should accept: ${schema}`)
      } else {
        assert.throws(
          init,
          /SnapshotStore does not support ON CONFLICT REPLACE or IGNORE on a primary key or UNIQUE constraint: table "t".*DirectStore/,
          `should reject: ${schema}`,
        )
        assert.equal(existsSync(join(dir, 'current')), false)
        // DirectStore runs callbacks directly, so SQLite resolves those clauses as declared.
        rmSync(dir, { recursive: true, force: true })
        assert.doesNotThrow(() => new DirectStore(dir, { schema, schemaVersion: 1 }).init())
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

test('schemaVersion rejects values SQLite cannot preserve before touching the store path', () => {
  const { dir, cleanup } = tmpStore()
  const schema = 'CREATE TABLE t (k TEXT PRIMARY KEY NOT NULL);'
  const invalid = [1.5, -1, 2_147_483_648, NaN, Infinity, '1', null]
  try {
    for (const [index, schemaVersion] of invalid.entries()) {
      const storeDir = join(dir, `invalid-${index}`)
      assert.throws(
        () =>
          new SnapshotStore(storeDir, {
            schema,
            schemaVersion: schemaVersion as number,
          }).init(),
        /schemaVersion.*integer between 0 and 2147483647/i,
      )
      assert.equal(existsSync(storeDir), false, 'validation must precede filesystem mutation')
    }
  } finally {
    cleanup()
  }
})

test('maxEnvelopeBytes and maxRetries reject values that would disable or wedge their guard', () => {
  const { dir, cleanup } = tmpStore()
  try {
    for (const [index, maxEnvelopeBytes] of [0, -1, 1.5, NaN, Infinity].entries()) {
      const storeDir = join(dir, `envelope-${index}`)
      assert.throws(
        () => new SnapshotStore(storeDir, { ...STORE_OPTS, maxEnvelopeBytes }).init(),
        (error: unknown) =>
          error instanceof TypeError && error.message.startsWith('maxEnvelopeBytes must be'),
      )
      assert.equal(existsSync(storeDir), false, 'validation must precede filesystem mutation')
    }
    const store = new SnapshotStore(join(dir, 'store'), STORE_OPTS).init()
    const direct = new DirectStore(join(dir, 'store'), STORE_OPTS)
    let calls = 0
    const fn = (): void => {
      calls++
    }
    for (const maxRetries of [0, -1, 1.5, NaN]) {
      assert.throws(() => store.reconcile({ maxRetries }), /maxRetries must be/)
      assert.throws(() => store.writeWithRetry('w', fn, { maxRetries }), /maxRetries must be/)
      assert.throws(() => direct.write(fn, { maxRetries }), /maxRetries must be/)
    }
    assert.throws(() => store.readLease({ maxRetries: -1 }), /maxRetries must be/)
    assert.equal(calls, 0, 'no attempt runs before its options are validated')
  } finally {
    cleanup()
  }
})

test('init rejects a conflict policy that names a table the schema does not declare', () => {
  const { dir, cleanup } = tmpStore()
  try {
    for (const [index, conflictPolicy] of [
      { urll_index: 'lww' as const, '*': 'strict' as const },
      { applied_tx: 'lww' as const },
    ].entries()) {
      const storeDir = join(dir, `policy-${index}`)
      const table = Object.keys(conflictPolicy)[0] ?? ''
      assert.throws(
        () => new SnapshotStore(storeDir, { ...STORE_OPTS, conflictPolicy }).init(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`conflictPolicy names table "${table}"`) &&
          error.message.includes('not a caller table'),
      )
    }
    // DirectStore applies no changesets, so it never consults a policy, even one a
    // JavaScript caller passes despite DirectStoreOptions.
    const untyped: StoreOptions = { ...STORE_OPTS, conflictPolicy: { urll_index: 'lww' } }
    assert.doesNotThrow(() => new DirectStore(join(dir, 'direct'), untyped).init())
  } finally {
    cleanup()
  }
})

test('schemaVersion preserves both ends of the supported fsqlite range', () => {
  const { dir, cleanup } = tmpStore()
  const schema = 'CREATE TABLE t (k TEXT PRIMARY KEY NOT NULL);'
  try {
    for (const schemaVersion of [0, 2_147_483_647]) {
      const storeDir = join(dir, `valid-${schemaVersion}`)
      const store = new SnapshotStore(storeDir, { schema, schemaVersion }).init()
      assert.equal(
        store.read(
          (db) =>
            (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ),
        schemaVersion,
      )
    }
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
      'changed exact DDL at the same schemaVersion must be rejected, not silently accepted',
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

test('first opens with mismatched schemas: only the creating schema initializes', () => {
  const { dir, cleanup } = tmpStore()
  try {
    // Two distinct schemas open one fresh store in turn: the first creates snapshot 0, and
    // every handle with the other schema must be refused as incompatible. Racing processes
    // are covered by the multiprocess first-open test below.
    const schemaA = 'CREATE TABLE a (k TEXT PRIMARY KEY NOT NULL);'
    const schemaB = 'CREATE TABLE b (k TEXT PRIMARY KEY NOT NULL);'
    const attempts = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? schemaA : schemaB))
    const outcomes = attempts.map((schema) => {
      try {
        new SnapshotStore(dir, { schema, schemaVersion: 1 }).init()
        return schema
      } catch (error) {
        if (error instanceof FsqliteError && error.code === 'incompatible') {
          return null
        }
        throw error
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

test('init abandons snapshot-0 publication after losing its lock token', () => {
  const { dir, cleanup } = tmpStore()
  try {
    setOwnerWriterForTest((path, data) => {
      writeFileSync(path, data)
      const lock = join(dir, 'publish.lock')
      rmSync(lock, { recursive: true, force: true })
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), ownerRecord('successor'))
    })
    assert.throws(() => new SnapshotStore(dir, STORE_OPTS).init(), /lost ownership|publish lock/i)
    assert.equal(readdirSync(join(dir, 'snapshots')).length, 0, 'no unfenced snapshot is published')
  } finally {
    setOwnerWriterForTest(null)
    cleanup()
  }
})

test('init refuses a store whose current pointer is missing but whose snapshots exist', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    for (let i = 0; i < 3; i++) {
      store.write('w', (db) =>
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'A', 't'),
      )
      store.reconcile()
    }
    rmSync(store.currentPath)
    const before = readdirSync(store.snapDir).sort()

    assert.throws(() => new SnapshotStore(dir, STORE_OPTS).init(), /current is missing.*run repair/)
    assert.deepEqual(readdirSync(store.snapDir).sort(), before, 'no snapshot was rebuilt')
    assert.equal(existsSync(store.currentPath), false, 'init did not roll the store back to 0')

    store.repair()
    assert.equal(new SnapshotStore(dir, STORE_OPTS).init().currentVersion(), 3)
  } finally {
    cleanup()
  }
})

test('init still completes a first-open that crashed before committing snapshot 0', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    rmSync(store.currentPath)
    rmSync(store.snapshotPath(0))

    assert.equal(new SnapshotStore(dir, STORE_OPTS).init().currentVersion(), 0)
  } finally {
    cleanup()
  }
})

test('init makes every store subdirectory it creates durable through its parent', () => {
  const { dir, cleanup } = tmpStore()
  const synced: string[] = []
  setAfterFsyncDirForTest((path) => synced.push(path))
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    assert.ok(synced.includes(join(dir, 'tx')), 'tx/ holds the new pending, applied, quarantine')

    rmSync(store.leaseDir, { recursive: true })
    synced.length = 0
    new SnapshotStore(dir, STORE_OPTS).init()
    assert.deepEqual(synced, [dir], 'a re-created leases/ is fsynced into the store root')
  } finally {
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})
