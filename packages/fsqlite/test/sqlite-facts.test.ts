// Plain-SQLite inspection helpers behind `stats`/`doctor`: file detection, header/page/
// schema facts, and integrity reporting over any SQLite file (not just an fsqlite store).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import * as driver from '../src/driver.ts'
import { isSqliteFile, sqliteFacts, integrityReport } from '../src/sqliteFacts.ts'
import { tmpStore } from './fixture.ts'

function makePlainDb(path: string, rows = 3): void {
  const db = driver.open(path)
  db.exec('PRAGMA application_id = 305419896;') // 0x12345678
  db.exec('PRAGMA user_version = 7;')
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);')
  // One transaction: an autocommit insert per row syncs the file each time.
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO widgets VALUES (?,?)')
  for (let i = 0; i < rows; i++) {
    ins.run(i, `w${i}`.padEnd(40, 'x'))
  }
  db.exec('COMMIT')
  db.close()
}

test('isSqliteFile detects a SQLite file vs other paths', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const db = join(dir, 'x.db')
    makePlainDb(db)
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'not a database')
    assert.equal(isSqliteFile(db), true)
    assert.equal(isSqliteFile(txt), false)
    assert.equal(isSqliteFile(dir), false, 'a directory is not a sqlite file')
    assert.equal(isSqliteFile(join(dir, 'missing.db')), false)
  } finally {
    cleanup()
  }
})

test('sqliteFacts reports header/page/schema facts for a plain SQLite file', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const db = join(dir, 'x.db')
    makePlainDb(db, 5)
    const f = sqliteFacts(db)
    assert.equal(f.applicationId, 305419896)
    assert.equal(f.userVersion, 7)
    assert.ok(
      f.pageSize >= 512 && (f.pageSize & (f.pageSize - 1)) === 0,
      'page size is a power of two',
    )
    assert.ok(f.pageCount >= 1)
    assert.ok(f.fileBytes >= f.pageSize)
    assert.ok(/^\d+\.\d+/.test(f.sqliteVersion), 'sqlite version looks like a version')
    assert.deepEqual(f.tables, [{ name: 'widgets', rows: 5 }])
  } finally {
    cleanup()
  }
})

test('integrityReport is empty for a clean db and non-empty for a corrupted one', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const db = join(dir, 'x.db')
    makePlainDb(db, 1000) // enough rows to span several pages
    assert.deepEqual(integrityReport(db), [])
    const fd = openSync(db, 'r+')
    try {
      writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
    } finally {
      closeSync(fd)
    }
    assert.ok(integrityReport(db).length > 0, 'a scribbled page is reported as a problem')
  } finally {
    cleanup()
  }
})
