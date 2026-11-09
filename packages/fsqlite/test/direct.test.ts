// DirectStore provides serialized-writer operation and format interoperability with the
// envelope engine. The two write strategies share one immutable-snapshot format, so a
// store written by one reads identically via the other and via plain sqlite3. These cover
// the in-process behavior and format interop; multi-process direct-writer serialization
// runs in the concurrent suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest, setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { isLockFresh } from '../src/lock.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

test('direct write → read round-trips and increments the version synchronously', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    assert.equal(store.currentVersion(), 0)
    const v = store.write((db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    assert.equal(v, 1, 'a direct write publishes immediately with no pending tail or reconcile')
    assert.equal(store.currentVersion(), 1)
    assert.equal(
      store.read(
        (db) =>
          (
            db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('a') as {
              title: string
            }
          ).title,
      ),
      'A',
    )
    assert.equal(
      store.validate().state,
      'sealed',
      'no pending tail in direct mode → always sealed between writes',
    )
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
        (db) =>
          (
            db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('d') as {
              title: string
            }
          ).title,
      ),
      'from-direct',
    )

    engine.write('agent', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('e', 'from-engine', 't')
    })
    engine.reconcile()
    assert.equal(
      direct.read(
        (db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c,
      ),
      2,
    )
  } finally {
    cleanup()
  }
})

test('direct writer with divergent schema fails before invoking its callback', () => {
  const { dir, cleanup } = tmpStore()
  try {
    new DirectStore(dir, STORE_OPTS).init()
    const rogue = new DirectStore(dir, {
      ...STORE_OPTS,
      schema: (STORE_OPTS.schema ?? '') + '\nCREATE TABLE extra (z TEXT PRIMARY KEY NOT NULL);',
    })
    let callbackRan = false
    assert.throws(
      () =>
        rogue.write(() => {
          callbackRan = true
        }),
      /schema is incompatible|schema_hash/i,
    )
    assert.equal(callbackRan, false)
    assert.equal(rogue.currentVersion(), 0)
  } finally {
    cleanup()
  }
})

test('DirectStore supports triggers, and SnapshotStore refuses to open that store', () => {
  const { dir, cleanup } = tmpStore()
  const options = {
    schema: `
      CREATE TABLE doc (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE audit (id TEXT PRIMARY KEY NOT NULL);
      CREATE TRIGGER doc_audit AFTER INSERT ON doc BEGIN INSERT INTO audit VALUES (NEW.id); END;
    `,
    schemaVersion: 1,
  }
  try {
    const direct = new DirectStore(dir, options).init()
    direct.write((db) => {
      db.prepare('INSERT INTO doc VALUES (?)').run('d1')
    })
    assert.deepEqual(
      direct.read((db) =>
        db
          .prepare('SELECT id FROM audit')
          .all()
          .map((row) => ({ ...row })),
      ),
      [{ id: 'd1' }],
    )

    const engine = new SnapshotStore(dir, options)
    for (const open of [() => engine.init(), () => engine.write('w', () => undefined)]) {
      assert.throws(open, /SnapshotStore does not support triggers/)
    }
  } finally {
    cleanup()
  }
})

test('direct mode never records a session (so it runs on session-less bindings)', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    const v = store.write((db) => {
      assert.equal(
        typeof db.createSession,
        'function',
        'the binding has session, but direct mode must not use it',
      )
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    assert.equal(v, 1)
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('direct writers use explicit rollback, durability, foreign-key, and busy-timeout settings', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    store.write((db) => {
      assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete')
      assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2)
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
      assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000)
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    const snapshot = store.snapshotPath(store.currentVersion())
    assert.equal(existsSync(`${snapshot}-wal`), false)
    assert.equal(existsSync(`${snapshot}-shm`), false)
  } finally {
    cleanup()
  }
})

for (const scenario of [
  {
    name: 'SQLite application id',
    mutate: (db: DatabaseSync) => {
      db.exec('PRAGMA application_id = 0')
    },
    error: /application callback changed the fsqlite SQLite application id/,
  },
  {
    name: 'caller schema version',
    mutate: (db: DatabaseSync) => {
      db.exec('PRAGMA user_version = 99')
    },
    error: /application callback changed the caller schema version/,
  },
  {
    name: 'owned metadata rows',
    mutate: (db: DatabaseSync) => {
      db.exec("DELETE FROM fsqlite_meta WHERE key = 'store_id'")
    },
    error: /fsqlite-owned table fsqlite_meta is read-only/,
  },
  {
    name: 'temporary protection schema',
    mutate: (db: DatabaseSync) => {
      db.exec(`
        DROP TRIGGER fsqlite_protect_applied_tx_insert;
        INSERT INTO applied_tx VALUES ('forged', '2026-08-01T00:00:00Z');
      `)
    },
    error: /application callback changed the SQLite temporary schema/,
  },
  {
    name: 'owned ledger schema',
    mutate: (db: DatabaseSync) => {
      db.exec('DROP TABLE applied_tx')
    },
    error: /application callback changed the SQLite schema/,
  },
  {
    name: 'caller schema',
    mutate: (db: DatabaseSync) => {
      db.exec('CREATE TABLE unversioned_change (id TEXT PRIMARY KEY)')
    },
    error: /application callback changed the SQLite schema/,
  },
]) {
  test(`DirectStore rejects callback changes to the ${scenario.name}`, () => {
    const { dir, cleanup } = tmpStore()
    try {
      const store = new DirectStore(dir, STORE_OPTS).init()
      assert.throws(() => store.write(scenario.mutate), scenario.error)
      assert.equal(store.currentVersion(), 0)
      assert.equal(store.validate().state, 'sealed')
    } finally {
      cleanup()
    }
  })
}

test('SnapshotStore callbacks cannot mutate fsqlite-owned rows', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    assert.throws(
      () =>
        store.write('bad-writer', (db) => {
          db.exec("INSERT INTO applied_tx VALUES ('forged', '2026-08-01T00:00:00Z')")
        }),
      /fsqlite-owned table applied_tx is read-only/,
    )
    assert.equal(store.currentVersion(), 0)
    assert.deepEqual(readdirSync(store.txPending), [])
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('SnapshotStore callbacks cannot remove owned-table protection', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    assert.throws(
      () =>
        store.write('bad-writer', (db) => {
          db.exec(`
            DROP TRIGGER fsqlite_protect_applied_tx_insert;
            INSERT INTO applied_tx VALUES ('forged', '2026-08-01T00:00:00Z');
          `)
        }),
      /application callback changed the SQLite temporary schema/,
    )
    assert.equal(store.currentVersion(), 0)
    assert.deepEqual(readdirSync(store.txPending), [])
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('DirectStore forwards repair and transient cleanup maintenance options', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    const transient = join(dir, 'snapshots', '.direct-stale.sqlite')
    writeFileSync(transient, 'stale')
    const old = new Date(Date.now() - 120_000)
    utimesSync(transient, old, old)

    store.gc({ transientStaleMs: 60_000 })

    assert.equal(existsSync(transient), false)
    assert.equal(store.repair().state, 'sealed')
  } finally {
    cleanup()
  }
})

for (const scenario of [
  {
    name: 'snapshot fsync',
    setHook: setAfterFsyncPathForTest,
    matches: (path: string, dir: string) => path.includes('.direct-') && path.startsWith(dir),
  },
  {
    name: 'snapshot directory fsync',
    setHook: setAfterFsyncDirForTest,
    matches: (path: string, dir: string) => path === join(dir, 'snapshots'),
  },
]) {
  test(`DirectStore retries when its publication lease is stolen during ${scenario.name}`, () => {
    const { dir, cleanup } = tmpStore()
    let calls = 0
    try {
      const store = new DirectStore(dir, STORE_OPTS).init()
      const publishLock = join(dir, 'publish.lock')
      scenario.setHook((path) => {
        if (!scenario.matches(path, dir)) {
          return
        }
        scenario.setHook(null)
        rmSync(publishLock, { recursive: true, force: true })
        mkdirSync(publishLock)
        writeFileSync(join(publishLock, 'owner.json'), ownerRecord('successor'))
        const old = new Date(Date.now() - 10_000)
        utimesSync(publishLock, old, old)
      })

      const version = store.write(
        (db) => {
          calls++
          db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
        },
        { lockOpts: { staleMs: 1, timeoutMs: 500, pollMs: 1 } },
      )

      assert.equal(version, 1)
      assert.equal(calls, 2, 'the unfenced build is discarded and caller code is rerun')
      assert.equal(
        store.read(
          (db) =>
            (db.prepare('SELECT COUNT(*) count FROM artifacts').get() as { count: number }).count,
        ),
        1,
      )
    } finally {
      scenario.setHook(null)
      cleanup()
    }
  })
}

test('a DirectStore write renews its publish lease at step boundaries', () => {
  const { dir, cleanup } = tmpStore()
  const lockPath = join(dir, 'publish.lock')
  const staleMs = 1_000
  // Age the lock as if the step that just ran took twice the stale window. A waiter would
  // break any lock still this old, so each later step boundary must have renewed it.
  const ageLock = (): void => {
    const past = new Date(Date.now() - 2 * staleMs)
    utimesSync(lockPath, past, past)
  }
  const observed: string[] = []
  try {
    const store = new DirectStore(dir, STORE_OPTS).init()
    setAfterFsyncPathForTest((path) => {
      if (path.includes('.direct-')) {
        observed.push(`after callback: fresh=${isLockFresh(lockPath, staleMs)}`)
        ageLock() // a slow snapshot fsync
      }
    })
    setAfterFsyncDirForTest((path) => {
      if (path === join(dir, 'snapshots')) {
        observed.push(`after fsync: fresh=${isLockFresh(lockPath, staleMs)}`)
      }
    })
    const version = store.write(
      (db) => {
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
        ageLock() // a slow callback
      },
      { lockOpts: { staleMs, timeoutMs: 2 * staleMs, pollMs: 5 } },
    )
    assert.equal(version, 1)
    assert.deepEqual(observed, ['after callback: fresh=true', 'after fsync: fresh=true'])
  } finally {
    setAfterFsyncPathForTest(null)
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})
