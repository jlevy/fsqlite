// Hardening guarantees: writers fail loudly without the session extension, validate/seal
// surface integrity_check diagnostics rather than a bare verdict, a read lease protects
// its snapshot from concurrent gc, and a corrupt pointer is never loaded or echoed whole.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
import * as driver from '../src/driver.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

function freshStore() {
  const { dir, cleanup } = tmpStore()
  return { store: new SnapshotStore(dir, STORE_OPTS).init(), dir, cleanup }
}

test('the writer guard fails loudly when the binding lacks session support', () => {
  assert.throws(() => {
    driver.requireWriterCapabilities(() => ({
      session: false,
      applyChangeset: true,
      backup: true,
      rebaser: false,
    }))
  }, /require the SQLite session extension/)
})

test('the session capability is present and the writer guard is a no-op happy path', () => {
  // The real binding exercises the positive and memoized path after the injected negative case.
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
      for (let i = 0; i < 400; i++) {
        ins.run(`a${i}`, `title-${i}`.repeat(8), 't')
      }
    })
    store.reconcile()
    const cur = store.currentVersion()
    const cleanDb = driver.openReadonly(store.snapshotPath(cur))
    try {
      assert.deepEqual(
        driver.integrityProblems(cleanDb),
        [],
        'a healthy snapshot reports no problems',
      )
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
    const detail = res.issues.find((i) => i.includes('failed integrity validation'))
    assert.match(
      detail ?? '',
      new RegExp(`^snapshot ${cur} failed integrity validation: \\S`),
      'the corrupt verdict carries specific integrity diagnostics, not an empty list',
    )
  } finally {
    cleanup()
  }
})

test('a read lease protects its snapshot from aggressive gc, then releases it', () => {
  const { store, cleanup } = freshStore()
  try {
    // advance to version 3 so there are old snapshots to collect
    for (let i = 0; i < 3; i++) {
      store.write('w', (db) =>
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'x', 't'),
      )
      store.reconcile()
    }
    const lease = store.readLease()
    assert.equal(lease.version, store.currentVersion())
    const leasedVersion = lease.version
    // advance further so the leased version falls below the retain floor
    for (let i = 0; i < 3; i++) {
      store.write('w', (db) =>
        db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`b${i}`, 'y', 't'),
      )
      store.reconcile()
    }
    const held = store.gc({ retain: 1 })
    assert.ok(held.leased.includes(leasedVersion), 'gc reports the leased version as protected')
    // the leased snapshot is still present and holds exactly the rows it was leased with
    const pinned = driver.openReadonly(store.snapshotPath(leasedVersion))
    try {
      assert.equal((pinned.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c, 3)
    } finally {
      pinned.close()
    }
    // once released, gc collects it
    lease.release()
    assert.equal(store.gc({ retain: 1 }).leased.length, 0)
    assert.equal(
      existsSync(store.snapshotPath(leasedVersion)),
      false,
      'the unpinned version is collected',
    )
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('a corrupt current pointer is read and quoted only up to a small bound', () => {
  const { store, cleanup } = freshStore()
  try {
    const corrupt = (pattern: RegExp) => (error: unknown) =>
      error instanceof FsqliteError &&
      error.code === 'corrupt' &&
      pattern.test(error.message) &&
      error.message.length < 200

    // A large file renamed over `current` (a mistaken copy, or a misdirected export).
    writeFileSync(store.currentPath, `SQLite format 3\0${'store data '.repeat(100_000)}`)
    assert.throws(
      () => store.currentVersion(),
      corrupt(/^corrupt current pointer: larger than 64 bytes, beginning "SQLite format 3\\u0000/),
    )
    assert.deepEqual(store.validate(), { state: 'corrupt', issues: ['torn current pointer'] })

    writeFileSync(store.currentPath, `12${'z'.repeat(50)}`)
    assert.throws(() => store.currentVersion(), corrupt(/"12z{30}" \(the first 32 characters\)$/))
    writeFileSync(store.currentPath, '9'.repeat(40)) // digits, but no safe-integer version
    assert.throws(() => store.read(() => 0), corrupt(/^corrupt current pointer: "9{32}"/))
    writeFileSync(store.currentPath, ' 0\n')
    assert.equal(store.currentVersion(), 0, 'surrounding whitespace is still allowed (P1)')
  } finally {
    cleanup()
  }
})

test('a quoted pointer prefix never splits a character and always says it is a prefix', () => {
  const { store, cleanup } = freshStore()
  try {
    const messageFor = (content: string): string => {
      writeFileSync(store.currentPath, content)
      try {
        store.currentVersion()
      } catch (error) {
        assert.ok(error instanceof FsqliteError && error.code === 'corrupt')
        return error.message
      }
      throw new Error(`pointer ${JSON.stringify(content)} parsed`)
    }
    const oversize = 'corrupt current pointer: larger than 64 bytes, beginning '

    // 80 bytes of two-byte characters: over the bound, so the quote is only a prefix.
    assert.equal(
      messageFor('é'.repeat(40)),
      `${oversize}"${'é'.repeat(32)}" (the first 32 characters)`,
    )
    // 64 bytes end inside the 22nd three-byte character, which is left out, not mangled.
    assert.equal(
      messageFor('€'.repeat(30)),
      `${oversize}"${'€'.repeat(21)}" (the first 21 characters)`,
    )
    // Within the bound, the 32nd character is a surrogate pair and is quoted whole.
    assert.equal(
      messageFor(`${'z'.repeat(31)}😀${'z'.repeat(8)}`),
      `corrupt current pointer: "${'z'.repeat(31)}😀" (the first 32 characters)`,
    )
  } finally {
    cleanup()
  }
})
