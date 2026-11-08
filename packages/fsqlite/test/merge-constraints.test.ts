import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ACTIONS, SnapshotStore, applyWithPolicy, normalize } from '../src/index.ts'
import type { ConflictPolicyInput, NormalizedPolicy } from '../src/index.ts'
import * as driver from '../src/driver.ts'
import { tmpStore } from './fixture.ts'

const FOREIGN_KEY_SCHEMA = `
  CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE child (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT NOT NULL REFERENCES parent(id)
  );
`

test('the normative filtered-pass order cannot be mutated by consumers', () => {
  assert.deepEqual(ACTIONS, ['replace', 'omit', 'strict'])
  assert.equal(Object.isFrozen(ACTIONS), true)
  assert.throws(() => (ACTIONS as unknown as string[]).reverse(), TypeError)
})

test('a UNIQUE conflict quarantines the atomic envelope instead of ledgering a partial apply', () => {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, {
    schema: `
      CREATE TABLE url_index (
        id TEXT PRIMARY KEY NOT NULL,
        url TEXT NOT NULL UNIQUE,
        hits INTEGER NOT NULL
      );
    `,
    schemaVersion: 1,
    conflictPolicy: { url_index: 'lww', '*': 'strict' },
  }).init()
  try {
    store.write('A', (db) => {
      db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('id-A', 'https://example.com', 1)
    })
    const conflictingTx = store.write('B', (db) => {
      db.prepare('INSERT INTO url_index VALUES (?,?,?)').run('id-B', 'https://example.com', 2)
    })
    assert.ok(conflictingTx)

    const result = store.reconcile()

    assert.equal(result.applied, 1)
    assert.equal(result.quarantined, 1)
    assert.deepEqual(
      store.read((db) =>
        (db.prepare('SELECT id, url, hits FROM url_index').all() as Record<string, unknown>[]).map(
          (row) => ({ ...row }),
        ),
      ),
      [{ id: 'id-A', url: 'https://example.com', hits: 1 }],
    )
    assert.equal(
      store.read(
        (db) =>
          (db.prepare('SELECT COUNT(*) count FROM applied_tx').get() as { count: number }).count,
      ),
      1,
    )
    const quarantinedDir = join(store.txQuarantine, `${conflictingTx}.txn`)
    assert.equal(existsSync(quarantinedDir), true)
    assert.match(readFileSync(join(quarantinedDir, 'QUARANTINE'), 'utf8'), /CONSTRAINT/)
  } finally {
    cleanup()
  }
})

test('reconcile quarantines the envelope that would introduce a dangling foreign key', () => {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, {
    schema: FOREIGN_KEY_SCHEMA,
    schemaVersion: 1,
    conflictPolicy: { parent: 'lww', child: 'lww', '*': 'strict' },
  }).init()
  try {
    store.write('seed', (db) => {
      db.prepare('INSERT INTO parent VALUES (?)').run('p')
    })
    store.reconcile()
    store.write('A', (db) => {
      db.prepare('DELETE FROM parent WHERE id = ?').run('p')
    })
    const offendingTx = store.write('B', (db) => {
      db.prepare('INSERT INTO child VALUES (?,?)').run('c', 'p')
    })
    assert.ok(offendingTx)

    const result = store.reconcile()

    assert.equal(result.applied, 1)
    assert.equal(result.quarantined, 1)
    assert.equal(
      store.read(
        (db) => (db.prepare('SELECT COUNT(*) count FROM parent').get() as { count: number }).count,
      ),
      0,
    )
    assert.equal(
      store.read(
        (db) => (db.prepare('SELECT COUNT(*) count FROM child').get() as { count: number }).count,
      ),
      0,
    )
    assert.equal(store.validate().state, 'sealed')
    assert.match(
      readFileSync(join(store.txQuarantine, `${offendingTx}.txn`, 'QUARANTINE'), 'utf8'),
      /FOREIGN_KEY|foreign_key_check/,
    )
  } finally {
    cleanup()
  }
})

test('policy key insertion order does not change filtered apply pass results', () => {
  const reconcileWithPolicy = (conflictPolicy: {
    parent: 'lww' | 'strict'
    child: 'lww' | 'strict'
    '*': 'strict'
  }) => {
    const { dir, cleanup } = tmpStore()
    const store = new SnapshotStore(dir, {
      schema: FOREIGN_KEY_SCHEMA,
      schemaVersion: 1,
      conflictPolicy,
    }).init()
    try {
      store.write('writer', (db) => {
        db.prepare('INSERT INTO parent VALUES (?)').run('p')
        db.prepare('INSERT INTO child VALUES (?,?)').run('c', 'p')
      })
      const result = store.reconcile()
      return {
        applied: result.applied,
        quarantined: result.quarantined,
        parents: store.read(
          (db) =>
            (db.prepare('SELECT COUNT(*) count FROM parent').get() as { count: number }).count,
        ),
        children: store.read(
          (db) => (db.prepare('SELECT COUNT(*) count FROM child').get() as { count: number }).count,
        ),
      }
    } finally {
      cleanup()
    }
  }

  const parentFirst = reconcileWithPolicy({ parent: 'lww', child: 'strict', '*': 'strict' })
  const childFirst = reconcileWithPolicy({ child: 'strict', parent: 'lww', '*': 'strict' })
  const childActionFirst = reconcileWithPolicy({ parent: 'strict', child: 'lww', '*': 'strict' })

  assert.deepEqual(childFirst, parentFirst)
  assert.deepEqual(childActionFirst, parentFirst)
  assert.deepEqual(parentFirst, { applied: 1, quarantined: 0, parents: 1, children: 1 })
})

test('publication and validation reject a snapshot with dangling foreign keys', () => {
  const fixture = tmpStore()
  const options = {
    schema: FOREIGN_KEY_SCHEMA,
    schemaVersion: 1,
    conflictPolicy: { parent: 'lww', child: 'lww', '*': 'strict' } as const,
  }
  try {
    const store = new SnapshotStore(fixture.dir, options).init()
    const db = new DatabaseSync(store.snapshotPath(store.currentVersion()), {
      enableForeignKeyConstraints: false,
    })
    try {
      db.prepare('INSERT INTO child VALUES (?,?)').run('c', 'missing')
      assert.throws(() => {
        driver.quickCheck(db)
      }, /foreign_key_check/)
    } finally {
      db.close()
    }
    const validation = store.validate()
    assert.equal(validation.state, 'corrupt')
    assert.match(validation.issues.join('; '), /foreign_key_check/)
  } finally {
    fixture.cleanup()
  }
})

test('applyWithPolicy rejects a dangling foreign key without a caller-supplied callback', () => {
  const fixture = tmpStore()
  const writerPath = join(fixture.dir, 'writer.sqlite')
  const targetPath = join(fixture.dir, 'target.sqlite')
  const writer = driver.open(writerPath)
  const target = driver.open(targetPath)
  try {
    writer.exec(FOREIGN_KEY_SCHEMA)
    target.exec(FOREIGN_KEY_SCHEMA)
    writer.prepare('INSERT INTO parent VALUES (?)').run('p')
    const changeset = driver.recordChangeset(writer, (db) => {
      db.prepare('INSERT INTO child VALUES (?,?)').run('c', 'p')
    })
    assert.ok(changeset)

    assert.throws(() => {
      applyWithPolicy(target, changeset, normalize({ child: 'lww', '*': 'strict' }))
    }, /foreign_key_check/)
    assert.equal(
      (target.prepare('SELECT COUNT(*) count FROM child').get() as { count: number }).count,
      0,
    )
  } finally {
    writer.close()
    target.close()
    fixture.cleanup()
  }
})

test('normalize rejects Object.prototype member names as conflict actions', () => {
  for (const action of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const policy = JSON.parse(`{"docs": "${action}"}`) as ConflictPolicyInput
    assert.throws(
      () => normalize(policy),
      /unknown conflict action/,
      `should reject action ${action}`,
    )
  }
})

test('tables named after Object.prototype members reconcile under their own policy', () => {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, {
    schema: `
      CREATE TABLE "constructor" (id TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
      CREATE TABLE "__proto__" (id TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
    `,
    schemaVersion: 1,
    // Parsed JSON makes `__proto__` an own key, as a policy loaded from a config file would.
    conflictPolicy: JSON.parse('{"__proto__": "lww", "*": "union"}') as ConflictPolicyInput,
  }).init()
  try {
    for (const [writer, value] of [
      ['A', 'a'],
      ['B', 'b'],
    ] as const) {
      store.write(writer, (db) => {
        db.prepare('INSERT INTO "constructor" VALUES (?, ?)').run('k', value)
        db.prepare('INSERT INTO "__proto__" VALUES (?, ?)').run('k', value)
      })
    }

    const result = store.reconcile()

    assert.deepEqual(
      { applied: result.applied, quarantined: result.quarantined },
      { applied: 2, quarantined: 0 },
    )
    // `__proto__` is listed as lww, so B's row wins; `constructor` falls back to the
    // union default, so A's first row stays.
    assert.deepEqual(
      store.read((db) => ({
        constructor: (db.prepare('SELECT v FROM "constructor"').get() as { v: string }).v,
        proto: (db.prepare('SELECT v FROM "__proto__"').get() as { v: string }).v,
      })),
      { constructor: 'a', proto: 'b' },
    )
  } finally {
    cleanup()
  }
})

test('applyWithPolicy applies tables a hand-built policy leaves to the strict default', () => {
  const fixture = tmpStore()
  const writer = driver.open(join(fixture.dir, 'writer.sqlite'))
  const target = driver.open(join(fixture.dir, 'target.sqlite'))
  const parents = (): number =>
    (target.prepare('SELECT COUNT(*) count FROM parent').get() as { count: number }).count
  try {
    writer.exec(FOREIGN_KEY_SCHEMA)
    target.exec(FOREIGN_KEY_SCHEMA)
    const changeset = driver.recordChangeset(writer, (db) => {
      db.prepare('INSERT INTO parent VALUES (?)').run('p')
    })
    assert.ok(changeset)

    // An action outside the normalized vocabulary would match no pass, so it is refused.
    const unnormalized = { parent: 'lww' } as unknown as NormalizedPolicy
    assert.throws(() => {
      applyWithPolicy(target, changeset, unnormalized)
    }, /policy maps table 'parent' to 'lww'/)
    assert.equal(parents(), 0)

    // A policy without '*' still routes the unlisted `parent` table to strict.
    applyWithPolicy(target, changeset, { child: 'replace' })
    assert.equal(parents(), 1)
  } finally {
    writer.close()
    target.close()
    fixture.cleanup()
  }
})
