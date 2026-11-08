// Spec section 13 (Reader): a snapshot that disappears between the pointer read and the
// open is not corruption. gc may have collected it after a newer publish, so the reader
// re-reads `current` and retries, a bounded number of times. A pointer that still names
// a missing snapshot is corruption.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
import { setBeforeSnapshotOpenForTest } from '../src/snapshotStore.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const count = (store: SnapshotStore): number =>
  store.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

const publishOne = (store: SnapshotStore, id: string): void => {
  store.write('w', (db) => db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(id, id, 't'))
  store.reconcile()
}

test('a reader whose snapshot gc collects after the pointer read retries on the new head', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    publishOne(store, 'a') // v1
    const peer = new SnapshotStore(dir, STORE_OPTS)
    const opened: number[] = []
    setBeforeSnapshotOpenForTest((version) => {
      opened.push(version)
      if (opened.length === 1) {
        // The reader holds a stale pointer; a peer publishes and gc collects that version.
        setBeforeSnapshotOpenForTest(null)
        publishOne(peer, 'b') // v2
        assert.equal(peer.gc({ retain: 0 }).removed, 2)
        setBeforeSnapshotOpenForTest((v) => opened.push(v))
      }
    })

    assert.equal(count(store), 2, 'the read observed the head that replaced the collected one')
    assert.deepEqual(opened, [1, 2])
  } finally {
    setBeforeSnapshotOpenForTest(null)
    cleanup()
  }
})

test('a reader gives up with a retryable error after bounded collected-snapshot retries', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    let attempts = 0
    // Every attempt loses the race: the head moves on and its predecessor disappears.
    setBeforeSnapshotOpenForTest((version) => {
      attempts++
      copyFileSync(store.snapshotPath(version), store.snapshotPath(version + 1))
      writeFileSync(store.currentPath, String(version + 1))
      rmSync(store.snapshotPath(version))
    })
    assert.throws(
      () => count(store),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'retryable' &&
        /collected .* times/.test(error.message),
    )
    assert.ok(attempts > 1 && attempts < 20, `bounded: ${attempts} attempts`)
  } finally {
    setBeforeSnapshotOpenForTest(null)
    cleanup()
  }
})

test('a pointer that still names a missing snapshot is corruption, not a race', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    let attempts = 0
    setBeforeSnapshotOpenForTest((version) => {
      attempts++
      rmSync(store.snapshotPath(version), { force: true })
    })
    assert.throws(
      () => count(store),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'corrupt' &&
        error.message.includes('current points at missing snapshot 0'),
    )
    assert.equal(attempts, 1)
  } finally {
    setBeforeSnapshotOpenForTest(null)
    cleanup()
  }
})
