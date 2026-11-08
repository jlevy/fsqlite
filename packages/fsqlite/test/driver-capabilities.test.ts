// Capability detection (research G2) and the backup-is-a-contract surface (research C).
// node:sqlite must report session support and produce an integrity-clean online backup.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, capabilities } from '../src/index.ts'
import { open, openBuild, openReadonly, integrityCheck } from '../src/driver.ts'

function withTmp(fn: (dir: string) => unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'driver-cap-'))
  const done = (): void => {
    rmSync(dir, { recursive: true, force: true })
  }
  return Promise.resolve(fn(dir)).then(
    () => {
      done()
    },
    (e: unknown) => {
      done()
      throw e
    },
  )
}

test('capabilities() reports session support on node:sqlite', () => {
  const caps = capabilities()
  assert.equal(caps.session, true, 'node:sqlite should support the session extension')
  assert.equal(caps.applyChangeset, true)
  assert.equal(caps.backup, true)
  assert.equal(caps.rebaser, false, 'node:sqlite exposes no rebaser binding')
})

test('a reconcile build skips SQLite syncs and runs no foreign-key actions', async () => {
  await withTmp((dir) => {
    // The build is fsynced once before publication (spec section 10), so per-transaction
    // syncs only slow reconcile; its recorded foreign-key action effects must not re-fire.
    const db = openBuild(join(dir, '.build-probe.sqlite'))
    try {
      const pragma = (name: string): unknown =>
        Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]
      assert.deepEqual(
        {
          journal: pragma('journal_mode'),
          synchronous: pragma('synchronous'),
          foreignKeys: pragma('foreign_keys'),
          busyTimeout: pragma('busy_timeout'),
        },
        { journal: 'delete', synchronous: 0, foreignKeys: 0, busyTimeout: 5000 },
      )
    } finally {
      db.close()
    }
  })
})

test('backupDatabase() makes an integrity-clean copy of a live database', async () => {
  await withTmp(async (dir) => {
    const srcPath = join(dir, 'src.sqlite')
    const dstPath = join(dir, 'backup.sqlite')
    const db = open(srcPath)
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)')
    for (let i = 0; i < 200; i++) {
      db.exec(`INSERT INTO t VALUES (${i}, 'v${i}')`)
    }

    await backupDatabase(srcPath, dstPath)
    db.close()

    assert.ok(existsSync(dstPath), 'backup file should exist')
    const copy = openReadonly(dstPath)
    assert.equal(integrityCheck(copy), true, 'backup must pass integrity_check')
    assert.equal((copy.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c, 200)
    assert.equal((copy.prepare('SELECT v FROM t WHERE x=42').get() as { v: string }).v, 'v42')
    copy.close()
  })
})

test('backupDatabase() remains consistent while another connection writes', async () => {
  await withTmp(async (dir) => {
    const srcPath = join(dir, 'live.sqlite')
    const dstPath = join(dir, 'restored.sqlite')
    const writer = open(srcPath)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('PRAGMA busy_timeout = 5000')
    writer.exec('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)')
    writer.exec('BEGIN')
    const insert = writer.prepare('INSERT INTO t VALUES (?, ?)')
    for (let index = 0; index < 4000; index++) {
      insert.run(index, 'x'.repeat(1024))
    }
    writer.exec('COMMIT')

    let next = 4000
    const writes = (async (): Promise<void> => {
      for (let index = 0; index < 20; index++) {
        insert.run(next++, 'concurrent')
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    })()
    const writesBeforeBackup = next
    await Promise.all([backupDatabase(srcPath, dstPath, { rate: 1 }), writes])
    writer.close()

    assert.ok(next > writesBeforeBackup, 'the source changed while backup was in progress')
    const restored = open(dstPath)
    try {
      assert.equal(integrityCheck(restored), true)
      const restoredRows = (restored.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number })
        .c
      assert.ok(restoredRows >= 4000 && restoredRows <= next)
      restored.prepare('INSERT INTO t VALUES (?, ?)').run(next + 1, 'restored-is-writable')
    } finally {
      restored.close()
    }
  })
})
