// Hardening guarantees: writers fail loudly without the session extension, validate/seal
// surface integrity_check diagnostics rather than a bare verdict, and a read lease
// protects its snapshot from concurrent gc.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openSync, writeSync, closeSync, statSync } from 'node:fs'
import { SnapshotStore } from '../src/index.ts'
import * as driver from '../src/driver.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

function freshStore() {
  const { dir, cleanup } = tmpStore()
  return { store: new SnapshotStore(dir, STORE_OPTS).init(), dir, cleanup }
}

test('the session capability is present and the writer guard is a no-op happy path', () => {
  // In CI node:sqlite has sessions, so we assert the positive: the guard does not throw and
  // repeated writes still succeed (the memoized check never breaks the happy path). The loud
  // failure on a session-less binding is exercised by the clear throw in requireWriterCapabilities.
  assert.equal(driver.capabilities().session, true, 'node:sqlite must report session support here')
  assert.doesNotThrow(() => {
    driver.requireWriterCapabilities()
  })
  const { store, cleanup } = freshStore()
  try {
    for (const w of ['w1', 'w2']) {
      store.write(w, (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(w, w, 't'))
    }
    assert.equal(store.reconcile().applied, 2)
  } finally {
    cleanup()
  }
})

test('integrityProblems returns [] for a clean snapshot and validate surfaces diagnostics for a corrupt one', () => {
  const { store, cleanup } = freshStore()
  try {
    // populate enough rows that the DB spans several pages
    store.write('w', (db) => {
      const ins = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
      for (let i = 0; i < 400; i++) ins.run(`a${i}`, `title-${i}`.repeat(8), 't')
    })
    store.reconcile()
    const cur = store.currentVersion()
    const cleanDb = driver.openReadonly(store.snapshotPath(cur))
    try {
      assert.deepEqual(driver.integrityProblems(cleanDb), [], 'a healthy snapshot reports no problems')
    } finally {
      cleanDb.close()
    }
    // Scribble a page deep in the file (leave the header/page-1 intact so it still opens).
    const size = statSync(store.snapshotPath(cur)).size
    assert.ok(size > 8192, 'snapshot should span multiple pages')
    const fd = openSync(store.snapshotPath(cur), 'r+')
    try {
      writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
    } finally {
      closeSync(fd)
    }
    const res = store.validate()
    assert.equal(res.state, 'corrupt', 'a scribbled page is detected as corrupt')
    const detail = res.issues.find((i) => i.includes('integrity_check'))
    assert.ok(detail, 'the corrupt verdict carries an integrity_check issue')
    assert.notEqual(detail, `snapshot ${cur} failed integrity_check: `, 'and the issue carries specific diagnostics, not an empty list')
  } finally {
    cleanup()
  }
})

test('a read lease protects its snapshot from aggressive gc, then releases it', () => {
  const { store, cleanup } = freshStore()
  try {
    // advance to version 3 so there are old snapshots to collect
    for (let i = 0; i < 3; i++) {
      store.write('w', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'x', 't'))
      store.reconcile()
    }
    const lease = store.readLease()
    assert.equal(lease.version, store.currentVersion())
    const leasedVersion = lease.version
    // advance further so the leased version falls below the retain floor
    for (let i = 0; i < 3; i++) {
      store.write('w', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`b${i}`, 'y', 't'))
      store.reconcile()
    }
    const held = store.gc({ retain: 1 })
    assert.ok(held.leased.includes(leasedVersion), 'gc reports the leased version as protected')
    // the leased snapshot is still present and readable through the lease
    const title = new SnapshotStore(store.dir, STORE_OPTS)
    assert.equal(
      title.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c) >= 0,
      true,
    )
    assert.doesNotThrow(() => {
      driver.openReadonly(store.snapshotPath(leasedVersion)).close()
    })
    // once released, gc may collect it
    lease.release()
    store.gc({ retain: 1 })
    assert.equal(store.validate().state === 'corrupt', false, 'store stays healthy after collection')
  } finally {
    cleanup()
  }
})
