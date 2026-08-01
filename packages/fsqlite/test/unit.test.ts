import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const count = (store: SnapshotStore, table: string): number =>
  store.read((db) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c)

function freshStore() {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, STORE_OPTS).init()
  return { store, dir, cleanup }
}

test('write → reconcile → read round-trips through an immutable snapshot', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.equal(store.currentVersion(), 0)
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a1', 'Alpha', 't')
    })
    assert.equal(count(store, 'artifacts'), 0, 'pending tx not yet visible to readers')
    const res = store.reconcile()
    assert.equal(res.applied, 1)
    assert.equal(store.currentVersion(), 1)
    assert.equal(
      store.read(
        (db) => (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('a1') as { title: string }).title,
      ),
      'Alpha',
    )
  } finally {
    cleanup()
  }
})

test('base snapshot stays byte-immutable after a publish', () => {
  const { store, cleanup } = freshStore()
  try {
    const before = readFileSync(store.snapshotPath(0))
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a1', 'X', 't')
    })
    store.reconcile()
    const after = readFileSync(store.snapshotPath(0))
    assert.ok(before.equals(after), 'snapshot 0 must be byte-identical after publishing snapshot 1')
  } finally {
    cleanup()
  }
})

test('last-writer-wins on a same-PK clash, ordered by logical clock', () => {
  const { store, cleanup } = freshStore()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('dup', 'from-A', 't1')
    })
    store.write('B', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('dup', 'from-B', 't2')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 2)
    assert.equal(
      store.read(
        (db) => (db.prepare('SELECT title FROM artifacts WHERE artifact_id=?').get('dup') as { title: string }).title,
      ),
      'from-B',
      'later tx (by txid order) wins',
    )
  } finally {
    cleanup()
  }
})

test('set-union policy drops duplicate relationship inserts without conflict', () => {
  const { store, cleanup } = freshStore()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO relationships VALUES (?,?,?,?)').run('r1', 's', 'p', 'o')
    })
    store.write('B', (db) => {
      db.prepare('INSERT INTO relationships VALUES (?,?,?,?)').run('r1', 's', 'p', 'o')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 2)
    assert.equal(res.quarantined, 0)
    assert.equal(count(store, 'relationships'), 1)
  } finally {
    cleanup()
  }
})

test('reconcile is idempotent — replaying an applied tx does not double-apply', () => {
  const { store, cleanup } = freshStore()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run('h', 'http://x', 'b', 't')
    })
    const r1 = store.reconcile()
    assert.equal(r1.applied, 1)
    const r2 = store.reconcile()
    assert.equal(r2.applied, 0)
    assert.equal(count(store, 'url_index'), 1)
  } finally {
    cleanup()
  }
})

test('a digest-mismatched envelope is quarantined, not applied', () => {
  const { store, cleanup } = freshStore()
  try {
    const txId = store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    writeFileSync(join(store.txPending, `${txId}.txn`, 'catalog.changeset'), Buffer.from('corrupted'))
    const res = store.reconcile()
    assert.equal(res.applied, 0)
    assert.equal(res.quarantined, 1)
    assert.ok(existsSync(join(store.txQuarantine, `${txId}.txn`)))
    assert.equal(count(store, 'artifacts'), 0)
  } finally {
    cleanup()
  }
})

test('last-writer-wins handles a NOTFOUND conflict by OMIT, not SQLITE_MISUSE', () => {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, {
    ...STORE_OPTS,
    schema: STORE_OPTS.schema + '\nCREATE TABLE counters (k TEXT PRIMARY KEY NOT NULL, n INTEGER);',
    conflictPolicy: { ...STORE_OPTS.conflictPolicy, counters: 'lww' },
  }).init()
  try {
    store.write('seed', (db) => {
      db.prepare('INSERT INTO counters VALUES (?,?)').run('x', 0)
    })
    store.reconcile()
    store.write('A', (db) => {
      db.prepare('DELETE FROM counters WHERE k=?').run('x')
    })
    store.write('B', (db) => {
      db.prepare('UPDATE counters SET n=? WHERE k=?').run(5, 'x')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 2, 'delete lands, update hits NOTFOUND → OMIT (no MISUSE throw)')
    assert.equal(res.quarantined, 0)
    assert.equal(count(store, 'counters'), 0, 'row stays deleted')
  } finally {
    cleanup()
  }
})

test('a strict-table conflict quarantines the whole tx', () => {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, {
    ...STORE_OPTS,
    schema: STORE_OPTS.schema + '\nCREATE TABLE strict_t (k TEXT PRIMARY KEY NOT NULL, v TEXT);',
  }).init()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO strict_t VALUES (?,?)').run('k', 'A')
    })
    store.write('B', (db) => {
      db.prepare('INSERT INTO strict_t VALUES (?,?)').run('k', 'B')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 1, 'the first writer lands; the conflicting one does not')
    assert.equal(res.quarantined, 1, 'strict conflict is quarantined, not silently merged')
    assert.equal(
      store.read((db) => (db.prepare('SELECT v FROM strict_t WHERE k=?').get('k') as { v: string }).v),
      'A',
    )
  } finally {
    cleanup()
  }
})

test('an envelope written under a divergent schema (same version) is quarantined by schema_hash', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const rogue = new SnapshotStore(dir, {
      ...STORE_OPTS,
      schema: STORE_OPTS.schema + '\nCREATE TABLE extra (z TEXT PRIMARY KEY NOT NULL);',
    })
    rogue.write('rogue', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 0)
    assert.equal(res.quarantined, 1)
    assert.equal(count(store, 'artifacts'), 0)
  } finally {
    cleanup()
  }
})

test('validate classifies sealed / live / in-flight states', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.equal(store.validate().state, 'sealed', 'empty reconciled store is sealed')
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    assert.equal(store.validate().state, 'live', 'a committed pending tail is a normal live store')
    store.reconcile()
    assert.equal(store.validate().state, 'sealed')
    writeFileSync(join(store.snapDir, '.build-orphan.sqlite'), 'x')
    assert.equal(store.validate().state, 'in-flight-capture')
  } finally {
    cleanup()
  }
})

test('seal produces a clean single-file snapshot that passes integrity_check', () => {
  const { store, dir, cleanup } = freshStore()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    })
    store.reconcile()
    const out = join(dir, 'sealed.sqlite')
    store.seal(out)
    assert.ok(existsSync(out))
    assert.ok(!existsSync(out + '-wal') && !existsSync(out + '-shm'), 'no live side files in a sealed file')
  } finally {
    cleanup()
  }
})

test('gc drops old snapshots but keeps current + retained', () => {
  const { store, cleanup } = freshStore()
  try {
    for (let i = 0; i < 6; i++) {
      store.write('A', (db) => {
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'A', 't')
      })
      store.reconcile()
    }
    assert.equal(store.currentVersion(), 6)
    const r = store.gc({ retain: 2 })
    assert.ok(r.removed >= 1)
    assert.ok(existsSync(store.snapshotPath(6)), 'current kept')
    assert.ok(existsSync(store.snapshotPath(5)), 'retained kept')
    assert.ok(!existsSync(store.snapshotPath(0)), 'old dropped')
  } finally {
    cleanup()
  }
})

test('write rejects an unsafe writerId before it reaches the filesystem', () => {
  const { store, cleanup } = freshStore()
  try {
    const insert = (db: DatabaseSync): void => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't')
    }
    for (const bad of ['', 'a/b', '../escape', 'a\\b', 'x'.repeat(65)]) {
      assert.throws(() => store.write(bad, insert), /invalid writerId/, `should reject ${JSON.stringify(bad)}`)
    }
    // A safe id still works.
    assert.ok(store.write('agent.1_ok-2', insert))
  } finally {
    cleanup()
  }
})

test('reconcile quarantines an envelope larger than maxEnvelopeBytes instead of loading it', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, { ...STORE_OPTS, maxEnvelopeBytes: 1 }).init()
    store.write('w1', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
    const res = store.reconcile()
    assert.equal(res.applied, 0, 'oversized envelope is not applied')
    assert.equal(res.quarantined, 1, 'oversized envelope is quarantined (not OOM-loaded)')
  } finally {
    cleanup()
  }
})
