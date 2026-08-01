// doctor/repair: restore the last consistent point from a torn/in-flight store.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const count = (store: SnapshotStore): number =>
  store.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

function storeAt(n: number) {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, STORE_OPTS).init()
  for (let i = 0; i < n; i++) {
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'A', 't')
    })
    store.reconcile()
  }
  return { store, dir, cleanup }
}

test('repair clears an in-flight capture (orphan snapshot + transient + uncommitted tx)', () => {
  const { store, cleanup } = storeAt(3) // current = 3
  try {
    copyFileSync(store.snapshotPath(3), store.snapshotPath(4)) // orphan ahead of pointer
    writeFileSync(join(store.snapDir, '.build-xyz.sqlite'), 'x')
    const txn = join(store.txPending, '999-uncommitted.txn')
    mkdirSync(txn, { recursive: true })
    writeFileSync(join(txn, 'catalog.changeset'), 'partial') // no COMMITTED marker

    assert.equal(store.validate().state, 'in-flight-capture')
    const res = store.repair()
    assert.ok(res.actions.length >= 3, `repair took actions: ${res.actions.join('; ')}`)
    assert.equal(store.validate().state, 'sealed')
    assert.equal(store.currentVersion(), 3, 'restored to the last published head, not the orphan')
    assert.ok(!existsSync(store.snapshotPath(4)), 'orphan removed')
    assert.equal(count(store), 3, 'no published data lost (R1)')
    assert.ok(existsSync(join(store.txQuarantine, '999-uncommitted.txn')), 'uncommitted tx quarantined')
  } finally {
    cleanup()
  }
})

test('repair re-publishes to the highest integrity-clean snapshot when current is torn', () => {
  const { store, cleanup } = storeAt(2) // current = 2
  try {
    writeFileSync(store.currentPath, 'not-a-number')
    assert.equal(store.validate().state, 'corrupt')
    const res = store.repair()
    assert.equal(store.validate().state, 'sealed')
    assert.equal(store.currentVersion(), 2, 'recovered to the highest good snapshot')
    assert.equal(count(store), 2)
    assert.ok(res.actions.some((a) => a.includes('re-published')))
  } finally {
    cleanup()
  }
})

test('repair removes a corrupt head snapshot and falls back to the prior good one', () => {
  const { store, cleanup } = storeAt(2) // snapshots 0,1,2; current = 2
  try {
    writeFileSync(store.snapshotPath(2), 'totally-not-sqlite'.repeat(100))
    const res = store.repair()
    assert.equal(store.currentVersion(), 1, 'fell back to the prior integrity-clean snapshot')
    assert.equal(store.validate().state, 'sealed')
    assert.ok(res.actions.some((a) => a.includes('removed corrupt snapshot 2')))
    assert.equal(count(store), 1, 'v1 (the last clean head) intact; v2 delta is the bounded loss')
  } finally {
    cleanup()
  }
})

test('orphan .direct-/.work- transients are surfaced by validate and removed by repair (spec §2)', () => {
  const { store, cleanup } = storeAt(1)
  try {
    // Crash debris from a SIGKILL'd DirectStore write and a SIGKILL'd writer capture.
    writeFileSync(join(store.snapDir, '.direct-deadbeef.sqlite'), 'x')
    writeFileSync(join(store.txPending, '.work-A-deadbeef.sqlite'), 'x')
    const v = store.validate()
    assert.equal(v.state, 'in-flight-capture', 'transient debris is an in-flight tell, not sealed')
    assert.ok(
      v.issues.some((i) => i.includes('.direct-deadbeef')) && v.issues.some((i) => i.includes('.work-A-deadbeef')),
      `both transient kinds named in issues: ${JSON.stringify(v.issues)}`,
    )
    store.repair()
    assert.equal(existsSync(join(store.snapDir, '.direct-deadbeef.sqlite')), false, 'repair removed the .direct- orphan')
    assert.equal(existsSync(join(store.txPending, '.work-A-deadbeef.sqlite')), false, 'repair removed the .work- orphan')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})
