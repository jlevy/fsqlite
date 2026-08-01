// Constraint closure (fsql-format-spec.md §6.1): what row-level merge preserves, what it
// cannot, and (the part that matters for R2) that everything it cannot preserve is
// reported rather than silently accepted.
//
// The merge is keyed on primary keys. UNIQUE, FOREIGN KEY, and CHECK are caller-declared
// constraints the writer honors at capture but that the merge can still break, because two
// envelopes that were each valid against the base can combine into a state neither writer
// produced. These tests pin the reporting contract for each case.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'
import type { ConflictPolicyInput } from '../src/types.ts'

const FK_SCHEMA = `
  CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE child  (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES parent(id));
`
const UNIQUE_SCHEMA = `CREATE TABLE url_index (
  id TEXT PRIMARY KEY NOT NULL,
  url TEXT NOT NULL UNIQUE,
  hits INTEGER NOT NULL
);`

function storeWith(schema: string, conflictPolicy: ConflictPolicyInput) {
  const dir = mkdtempSync(join(tmpdir(), 'fsq-constraints-'))
  const store = new SnapshotStore(dir, { schema, conflictPolicy }).init()
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true })
  }
  return { store, cleanup }
}

test('a UNIQUE collision under lww is counted as a dropped change, not silently lost', () => {
  const { store, cleanup } = storeWith(UNIQUE_SCHEMA, { url_index: 'lww', '*': 'strict' })
  try {
    // Two writers claim the same UNIQUE natural key under different surrogate keys. Both
    // envelopes are valid against the base; only one row can survive the merge.
    store.write('A', (db) =>
      db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('id-A', 'https://example.com', 1),
    )
    store.write('B', (db) =>
      db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('id-B', 'https://example.com', 2),
    )
    const res = store.reconcile()

    // lww cannot REPLACE on a CONSTRAINT conflict (SQLite forbids it), so it falls back to
    // OMIT. The row really is gone; the contract is that reconcile SAYS so.
    assert.equal(res.applied, 2, 'both envelopes applied')
    assert.equal(res.quarantined, 0)
    const kept = store.read(
      (db) => db.prepare('SELECT COUNT(*) c FROM url_index').get() as { c: number },
    )
    assert.equal(kept.c, 1, 'only one of the two colliding rows survives')
    assert.equal(res.dropped.total, 1, 'the discarded row is counted (R2)')
    assert.equal(res.dropped.byConflictType.CONSTRAINT, 1, 'attributed to its conflict type')
  } finally {
    cleanup()
  }
})

test('an UPDATE to a row another writer deleted is counted as dropped', () => {
  const { store, cleanup } = storeWith(UNIQUE_SCHEMA, { url_index: 'lww', '*': 'strict' })
  try {
    store.write('setup', (db) =>
      db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('id-A', 'https://a.example', 1),
    )
    store.reconcile()
    store.write('A', (db) => db.prepare('DELETE FROM url_index WHERE id = ?').run('id-A'))
    store.write('B', (db) => db.prepare('UPDATE url_index SET hits = 99 WHERE id = ?').run('id-A'))
    const res = store.reconcile()

    assert.equal(res.applied, 2)
    assert.equal(res.dropped.total, 1, "B's update hit NOTFOUND and was dropped")
    assert.equal(res.dropped.byConflictType.NOTFOUND, 1)
  } finally {
    cleanup()
  }
})

test('a cross-writer dangling foreign key is detected and reported, not published silently', () => {
  const { store, cleanup } = storeWith(FK_SCHEMA, { parent: 'lww', child: 'lww', '*': 'strict' })
  try {
    store.write('setup', (db) => db.prepare('INSERT INTO parent VALUES (?,?)').run('p1', 'P'))
    store.reconcile()

    // Each envelope is individually valid against the published base; together they leave a
    // child pointing at a parent that no longer exists. Inherent to write-set merge.
    // Leaving it undetected is not (neither quick_check nor integrity_check sees it).
    store.write('A', (db) => db.prepare('DELETE FROM parent WHERE id = ?').run('p1'))
    store.write('B', (db) => db.prepare('INSERT INTO child VALUES (?,?)').run('c1', 'p1'))
    const res = store.reconcile()

    assert.equal(res.applied, 2)
    assert.equal(res.foreignKeyViolations, 1, 'reconcile reports the violation it created')

    const v = store.validate()
    assert.equal(v.constraints?.foreignKeyViolations, 1, 'validate reports it too')
    assert.ok(
      v.issues.some((i) => i.includes('foreign key violation')),
      `issues name the violation: ${JSON.stringify(v.issues)}`,
    )
    // Referential integrity is a DIFFERENT axis from structural integrity: the SQLite file
    // is sound, so the state must stay structural or repair would roll the store back over
    // a caller-constraint problem it cannot fix.
    assert.equal(v.state, 'sealed', 'a constraint violation is not file corruption')
  } finally {
    cleanup()
  }
})

test('a clean store reports zero constraint violations', () => {
  const { store, cleanup } = storeWith(FK_SCHEMA, { parent: 'lww', child: 'lww', '*': 'strict' })
  try {
    store.write('w', (db) => {
      db.prepare('INSERT INTO parent VALUES (?,?)').run('p1', 'P')
      db.prepare('INSERT INTO child VALUES (?,?)').run('c1', 'p1')
    })
    const res = store.reconcile()
    assert.equal(res.foreignKeyViolations, 0)
    assert.equal(res.dropped.total, 0)
    assert.equal(store.validate().constraints?.foreignKeyViolations, 0)
  } finally {
    cleanup()
  }
})

// The merge runs one filtered apply pass per distinct action. Deriving that pass order from
// the policy object's key order would make the result depend on how the caller happened to
// write the literal (same policy, different outcome), and would break the spec's guarantee
// that two reconcilers folding the same tail build equivalent snapshots (§6).
test('merge outcome is independent of policy-object key order', () => {
  const permutations: ConflictPolicyInput[] = [
    { parent: 'lww', child: 'strict', '*': 'strict' },
    { child: 'strict', parent: 'lww', '*': 'strict' },
    { '*': 'strict', child: 'strict', parent: 'lww' },
    { parent: 'lww', '*': 'strict', child: 'strict' },
  ]
  const outcomes = permutations.map((policy) => {
    const { store, cleanup } = storeWith(FK_SCHEMA, policy)
    try {
      // One internally-consistent envelope whose tables land in DIFFERENT passes.
      store.write('w', (db) => {
        db.prepare('INSERT INTO parent VALUES (?,?)').run('p1', 'P')
        db.prepare('INSERT INTO child VALUES (?,?)').run('c1', 'p1')
      })
      const res = store.reconcile()
      const rows = store.read((db) =>
        db.prepare('SELECT (SELECT COUNT(*) FROM parent) p, (SELECT COUNT(*) FROM child) c').get(),
      )
      return JSON.stringify({ applied: res.applied, quarantined: res.quarantined, rows })
    } finally {
      cleanup()
    }
  })

  assert.equal(
    new Set(outcomes).size,
    1,
    `every key order must merge identically, got: ${outcomes.join(' | ')}`,
  )
  assert.match(outcomes[0] ?? '', /"applied":1/, 'the consistent envelope lands, not quarantined')
})

test('an envelope consistent as a whole applies even when its tables span passes', () => {
  // Deferred foreign keys are what make this true: the child pass may run before the parent
  // pass, so enforcement has to wait for COMMIT, the unit the writer actually validated.
  const { store, cleanup } = storeWith(FK_SCHEMA, { child: 'strict', parent: 'lww', '*': 'strict' })
  try {
    store.write('w', (db) => {
      db.prepare('INSERT INTO parent VALUES (?,?)').run('p1', 'P')
      db.prepare('INSERT INTO child VALUES (?,?)').run('c1', 'p1')
    })
    const res = store.reconcile()
    assert.equal(res.applied, 1, 'not quarantined by a mid-apply FK trip')
    assert.equal(res.foreignKeyViolations, 0)
  } finally {
    cleanup()
  }
})

test('writeWithRetry refuses a schema-only seed instead of retrying against no rows', () => {
  const { store, cleanup } = storeWith(UNIQUE_SCHEMA, { url_index: 'strict', '*': 'strict' })
  try {
    assert.throws(
      () =>
        store.writeWithRetry(
          'w',
          (db) => db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('a', 'https://a', 1),
          { seed: 'schema-only' },
        ),
      /cannot use seed 'schema-only'/,
      'a read-modify-write retry against an empty working copy is meaningless',
    )
  } finally {
    cleanup()
  }
})
