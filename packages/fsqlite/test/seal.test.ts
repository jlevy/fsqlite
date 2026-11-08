// seal() is a conforming backup (spec section 10), so its output must meet the bar of a
// published file: a reader of the destination sees the previous file or the complete,
// integrity-checked, fsynced export, never a partial one, and an interrupted seal leaves
// nothing that blocks the next one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from '../src/index.ts'
import { setAfterFsyncDirForTest, setAfterFsyncPathForTest } from '../src/fsutil.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

function storeWithOneRow(dir: string): SnapshotStore {
  const store = new SnapshotStore(join(dir, 'store'), STORE_OPTS).init()
  store.write('w', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
  store.reconcile()
  return store
}

const exportDir = (dir: string): string => {
  const out = join(dir, 'exports')
  mkdirSync(out, { recursive: true })
  return out
}

test('seal replaces a partial file left by an interrupted seal with a durable export', () => {
  const { dir, cleanup } = tmpStore()
  const synced: string[] = []
  try {
    const store = storeWithOneRow(dir)
    const out = exportDir(dir)
    const dest = join(out, 'sealed.sqlite')
    writeFileSync(dest, 'partial-from-a-crashed-seal')
    setAfterFsyncPathForTest((path) => synced.push(`file:${path}`))
    setAfterFsyncDirForTest((path) => synced.push(`dir:${path}`))

    assert.equal(store.seal(dest), dest)

    const db = new DatabaseSync(dest, { readOnly: true })
    try {
      const rows = db.prepare('SELECT artifact_id FROM artifacts').all()
      assert.deepEqual(
        rows.map((row) => row.artifact_id),
        ['a'],
      )
    } finally {
      db.close()
    }
    assert.deepEqual(readdirSync(out), ['sealed.sqlite'], 'no temp is left beside the export')
    assert.ok(
      synced.some((entry) => entry.startsWith(`file:${out}`) && entry.endsWith('.tmp')),
      `the export is fsynced before it is renamed into place: ${synced.join(', ')}`,
    )
    assert.ok(synced.includes(`dir:${out}`), 'the destination directory is fsynced')
  } finally {
    setAfterFsyncPathForTest(null)
    setAfterFsyncDirForTest(null)
    cleanup()
  }
})

test('a seal that fails before its commit leaves the previous destination untouched', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    const out = exportDir(dir)
    const dest = join(out, 'sealed.sqlite')
    writeFileSync(dest, 'previous export')
    setAfterFsyncPathForTest((path) => {
      if (path.startsWith(out)) {
        throw Object.assign(new Error('injected export fsync failure'), { code: 'EIO' })
      }
    })

    assert.throws(() => store.seal(dest), /injected export fsync failure/)

    assert.equal(readFileSync(dest, 'utf8'), 'previous export')
    assert.deepEqual(readdirSync(out), ['sealed.sqlite'], 'the failed temp was removed')
  } finally {
    setAfterFsyncPathForTest(null)
    cleanup()
  }
})

test('seal refuses a destination the store owns', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    const published = readFileSync(store.snapshotPath(0))
    const pointer = readFileSync(store.currentPath, 'utf8')

    assert.throws(() => store.seal(store.snapshotPath(0)), /a path inside the store/)
    assert.throws(() => store.seal(store.currentPath), /a path inside the store/)

    assert.deepEqual(readFileSync(store.snapshotPath(0)), published, 'snapshot 0 is unchanged')
    assert.equal(readFileSync(store.currentPath, 'utf8'), pointer)
  } finally {
    cleanup()
  }
})
