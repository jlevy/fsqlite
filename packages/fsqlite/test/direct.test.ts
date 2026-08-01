// DirectStore provides local single-writer operation and format interoperability with the
// envelope engine. The two write strategies share one immutable-snapshot format, so a
// store written by one reads identically via the other and via plain sqlite3. These cover
// the in-process behavior and format interop; multi-process direct-writer concurrency runs
// in the concurrent suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest, setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

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
        writeFileSync(join(publishLock, 'owner.json'), JSON.stringify({ token: 'successor' }))
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
