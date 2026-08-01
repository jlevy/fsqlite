import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from '../src/snapshotStore.ts'
import { FSQLITE_APPLICATION_ID, recognizeStore } from '../src/storeFormat.ts'
import { sqliteFacts } from '../src/sqliteFacts.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('a store is a self-identifying flat directory', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const marker = JSON.parse(readFileSync(join(dir, 'fsqlite.json'), 'utf8')) as Record<
      string,
      unknown
    >

    assert.equal(marker.format, 'fsqlite')
    assert.equal(marker.format_version, 'f1.0')
    assert.deepEqual(marker.required_features, [])
    assert.match(String(marker.store_id), STORE_ID)
    assert.equal(store.snapDir, join(dir, 'snapshots'))
    assert.equal(store.txPending, join(dir, 'tx', 'pending'))
    assert.equal(store.currentPath, join(dir, 'current'))
    assert.equal(existsSync(join(dir, 'data')), false)

    const snapshotIdentity = store.read((db) =>
      Object.fromEntries(
        (
          db
            .prepare(
              "SELECT key, value FROM fsqlite_meta WHERE key IN ('format_version', 'store_id')",
            )
            .all() as { key: string; value: string }[]
        ).map(({ key, value }) => [key, value]),
      ),
    )
    assert.equal(snapshotIdentity.format_version, 'f1.0')
    assert.equal(snapshotIdentity.store_id, marker.store_id)

    const txId = store.write('format-test', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run('a', 'A', '2026-07-31')
    })
    assert.ok(txId)
    const txDir = join(store.txPending, `${txId}.txn`)
    assert.equal(existsSync(join(txDir, 'changeset.bin')), true)
    const manifest = JSON.parse(readFileSync(join(txDir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(manifest.format_version, 'f1.0')
    assert.equal(manifest.store_id, marker.store_id)
    assert.equal(manifest.changeset, 'changeset.bin')

    const reconciled = store.reconcile()
    assert.equal(
      sqliteFacts(store.snapshotPath(reconciled.published)).applicationId,
      FSQLITE_APPLICATION_ID,
    )
    const sealedPath = join(dir, 'sealed.sqlite')
    store.seal(sealedPath)
    assert.equal(sqliteFacts(sealedPath).applicationId, FSQLITE_APPLICATION_ID)
  } finally {
    cleanup()
  }
})

test('init refuses an unmarked non-empty directory without touching its contents', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const sentinel = join(dir, 'keep.txt')
    writeFileSync(sentinel, 'keep me')

    assert.throws(
      () => new SnapshotStore(dir, STORE_OPTS).init(),
      /refusing to initialize an unmarked non-empty directory/,
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep me')
    assert.equal(existsSync(join(dir, 'fsqlite.json')), false)
    assert.equal(existsSync(join(dir, 'snapshots')), false)
  } finally {
    cleanup()
  }
})

test('unsupported format versions remain distinct from corruption and block mutation', () => {
  const { dir, cleanup } = tmpStore()
  try {
    writeFileSync(
      join(dir, 'fsqlite.json'),
      JSON.stringify({
        format: 'fsqlite',
        format_version: 'f2.0',
        required_features: [],
        store_id: randomUUID(),
      }),
    )
    mkdirSync(join(dir, 'snapshots'))
    const store = new SnapshotStore(dir, STORE_OPTS)

    const validation = store.validate()
    assert.equal(validation.state, 'unsupported')
    assert.match(validation.issues.join('; '), /unsupported fsqlite format version "f2\.0"/)
    assert.throws(() => store.gc(), /unsupported fsqlite format version "f2\.0"/)
  } finally {
    cleanup()
  }
})

test('unknown required features block older implementations', () => {
  const { dir, cleanup } = tmpStore()
  try {
    writeFileSync(
      join(dir, 'fsqlite.json'),
      JSON.stringify({
        format: 'fsqlite',
        format_version: 'f1.0',
        required_features: ['future-layout'],
        store_id: randomUUID(),
      }),
    )
    const store = new SnapshotStore(dir, STORE_OPTS)

    const validation = store.validate()
    assert.equal(validation.state, 'unsupported')
    assert.match(
      validation.issues.join('; '),
      /unsupported required fsqlite feature "future-layout"/,
    )
  } finally {
    cleanup()
  }
})

test('recognition distinguishes a missing marker from malformed metadata', () => {
  const { dir, cleanup } = tmpStore()
  try {
    assert.deepEqual(recognizeStore(dir), {
      state: 'not-a-store',
      issue: 'missing fsqlite.json store marker',
    })

    writeFileSync(join(dir, 'fsqlite.json'), '{not json')
    const invalid = recognizeStore(dir)
    assert.equal(invalid.state, 'invalid')
    assert.match('issue' in invalid ? invalid.issue : '', /malformed JSON/)
  } finally {
    cleanup()
  }
})

test('a replaced marker is detected before maintenance can mutate the store', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    writeFileSync(
      join(dir, 'fsqlite.json'),
      JSON.stringify({
        format: 'fsqlite',
        format_version: 'f1.0',
        required_features: [],
        store_id: randomUUID(),
      }),
    )

    const validation = store.validate()
    assert.equal(validation.state, 'corrupt')
    assert.match(validation.issues.join('; '), /snapshot store_id .* does not match fsqlite\.json/)
    assert.throws(() => store.gc(), /snapshot store_id .* does not match fsqlite\.json/)
    assert.throws(() => store.repair(), /no snapshot matches the store identity/)
    assert.equal(existsSync(store.snapshotPath(0)), true)
  } finally {
    cleanup()
  }
})

test('a snapshot with the wrong SQLite application_id is corrupt', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const db = new DatabaseSync(store.snapshotPath(0))
    try {
      db.exec('PRAGMA application_id = 0')
    } finally {
      db.close()
    }

    const validation = store.validate()
    assert.equal(validation.state, 'corrupt')
    assert.match(validation.issues.join('; '), /snapshot application_id 0 does not match/)
    assert.throws(() => {
      store.read(() => {
        return undefined
      })
    }, /snapshot application_id 0 does not match/)
  } finally {
    cleanup()
  }
})

test('reconcile quarantines a transaction envelope from another store', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const txId = store.write('foreign-test', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run('foreign', 'Foreign', '2026-07-31')
    })
    assert.ok(txId)
    const txDir = join(store.txPending, `${txId}.txn`)
    const manifestPath = join(txDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.store_id = randomUUID()
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const result = store.reconcile()
    assert.equal(result.applied, 0)
    assert.equal(result.quarantined, 1)
    assert.equal(
      readFileSync(join(store.txQuarantine, `${txId}.txn`, 'QUARANTINE'), 'utf8'),
      'store-id-mismatch',
    )
  } finally {
    cleanup()
  }
})
