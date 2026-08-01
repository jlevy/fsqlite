// Capability detection (research G2) and the backup-is-a-contract surface (research C).
// node:sqlite must report session support and produce an integrity-clean online backup.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, openReadonly, capabilities, backupTo, integrityCheck } from '../src/driver.ts'

function withTmp(fn: (dir: string) => unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'driver-cap-'))
  const done = (): void => { rmSync(dir, { recursive: true, force: true }); }
  return Promise.resolve(fn(dir)).then(
    () => { done(); },
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

test('backupTo() makes an integrity-clean copy of a live database', async () => {
  await withTmp(async (dir) => {
    const srcPath = join(dir, 'src.sqlite')
    const dstPath = join(dir, 'backup.sqlite')
    const db = open(srcPath)
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)')
    for (let i = 0; i < 200; i++) db.exec(`INSERT INTO t VALUES (${i}, 'v${i}')`)

    await backupTo(db, dstPath)
    db.close()

    assert.ok(existsSync(dstPath), 'backup file should exist')
    const copy = openReadonly(dstPath)
    assert.equal(integrityCheck(copy), true, 'backup must pass integrity_check')
    assert.equal((copy.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c, 200)
    assert.equal((copy.prepare('SELECT v FROM t WHERE x=42').get() as { v: string }).v, 'v42')
    copy.close()
  })
})
