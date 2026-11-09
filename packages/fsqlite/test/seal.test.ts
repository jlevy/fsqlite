// seal() is a conforming backup (spec section 10), so its output must meet the bar of a
// published file: a reader of the destination sees no file or the complete,
// integrity-checked, fsynced export, never a partial one, and an interrupted seal leaves
// nothing that blocks the next one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
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

test('seal creates a complete durable export at a new destination', () => {
  const { dir, cleanup } = tmpStore()
  const synced: string[] = []
  try {
    const store = storeWithOneRow(dir)
    const out = exportDir(dir)
    const dest = join(out, 'sealed.sqlite')
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
    assert.deepEqual(readdirSync(store.leaseDir), [], 'the seal released its read lease')
    assert.ok(
      synced.some((entry) => entry.startsWith(`file:${out}`) && entry.endsWith('.tmp')),
      `the export is fsynced before it is linked into place: ${synced.join(', ')}`,
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
    assert.throws(() => store.seal(join(store.dir, 'CURRENT')), /a path inside the store/)
    assert.throws(() => store.seal(join(store.dir, 'backup.sqlite')), /a path inside the store/)
    const alias = join(dir, 'store-alias')
    symlinkSync(store.dir, alias)
    assert.throws(() => store.seal(join(alias, 'backup.sqlite')), /a path inside the store/)
    const caseAlias = join(dir, 'STORE')
    if (existsSync(caseAlias)) {
      assert.throws(() => store.seal(join(caseAlias, 'new.sqlite')), /a path inside the store/)
    }

    assert.deepEqual(readFileSync(store.snapshotPath(0)), published, 'snapshot 0 is unchanged')
    assert.equal(readFileSync(store.currentPath, 'utf8'), pointer)
  } finally {
    cleanup()
  }
})

test('seal reports a lost leased snapshot as a refusal and drops its pin', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    const readLease = store.readLease.bind(store)
    store.readLease = () => {
      const lease = readLease()
      // Model a process paused after claiming until the pin expired and gc collected it.
      rmSync(store.snapshotPath(lease.version))
      return lease
    }
    const out = exportDir(dir)
    assert.throws(
      () => store.seal(join(out, 'sealed.sqlite')),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'refused' &&
        !error.retryable &&
        error.message.includes('lease may have expired'),
    )
    assert.deepEqual(readdirSync(store.leaseDir), [])
    assert.deepEqual(readdirSync(out), [])
  } finally {
    cleanup()
  }
})

test('seal refuses existing files, symlinks, and a destination created during export', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    const out = exportDir(dir)
    const dest = join(out, 'sealed.sqlite')
    writeFileSync(dest, 'previous export')
    assert.throws(() => store.seal(dest), /destination already exists/)
    assert.equal(readFileSync(dest, 'utf8'), 'previous export')
    const alias = join(out, 'alias.sqlite')
    symlinkSync(store.currentPath, alias)
    const pointer = readFileSync(store.currentPath)
    assert.throws(() => store.seal(alias), /destination already exists/)
    assert.deepEqual(readFileSync(store.currentPath), pointer)
    const raced = join(out, 'raced.sqlite')
    setAfterFsyncPathForTest((path) => {
      if (path.startsWith(out)) {
        writeFileSync(raced, 'concurrent creator')
      }
    })
    assert.throws(() => store.seal(raced), /destination already exists/)
    assert.equal(readFileSync(raced, 'utf8'), 'concurrent creator')
    assert.ok(readdirSync(out).every((name) => !name.endsWith('.tmp')))
  } finally {
    setAfterFsyncPathForTest(null)
    cleanup()
  }
})

test('seal refuses SQLite sidecars before and after building the export', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    const out = exportDir(dir)
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const dest = join(out, `sealed${suffix}.sqlite`)
      writeFileSync(`${dest}${suffix}`, 'unrelated SQLite state')
      assert.throws(() => store.seal(dest), /SQLite sidecar exists/)
      assert.equal(readFileSync(`${dest}${suffix}`, 'utf8'), 'unrelated SQLite state')
    }
    const dest = join(out, 'raced.sqlite')
    setAfterFsyncPathForTest((path) => {
      if (path.startsWith(out)) {
        writeFileSync(`${dest}-journal`, 'concurrent SQLite state')
      }
    })
    assert.throws(() => store.seal(dest), /SQLite sidecar exists/)
    assert.ok(readdirSync(out).every((name) => !name.endsWith('.tmp')))
  } finally {
    setAfterFsyncPathForTest(null)
    cleanup()
  }
})

test('seal refuses a head that fails integrity validation as corrupt and leaves no temp', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = storeWithOneRow(dir)
    store.write('w', (db) => {
      const insert = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
      for (let i = 0; i < 400; i++) {
        insert.run(`b${i}`, `t${i}`.repeat(8), 't')
      }
    })
    store.reconcile()
    // Scribble a page deep in the head: its identity rows still read, its b-tree does not.
    const fd = openSync(store.snapshotPath(2), 'r+')
    try {
      writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
    } finally {
      closeSync(fd)
    }
    const out = exportDir(dir)
    assert.throws(
      () => store.seal(join(out, 'sealed.sqlite')),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'corrupt' &&
        error.message.startsWith('cannot seal: snapshot 2 is corrupt'),
    )
    assert.deepEqual(readdirSync(out), [], 'no export and no temp')
    assert.deepEqual(readdirSync(store.leaseDir), [], 'the seal lease was released')
  } finally {
    cleanup()
  }
})
