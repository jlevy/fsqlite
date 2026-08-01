// doctor/repair: restore the last consistent point from a torn/in-flight store.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, copyFileSync, mkdirSync, utimesSync } from 'node:fs'
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

test('repair clears an in-flight capture (orphan snapshot, transient, and uncommitted tx)', () => {
  const { store, cleanup } = storeAt(3) // current = 3
  try {
    copyFileSync(store.snapshotPath(3), store.snapshotPath(4)) // orphan ahead of pointer
    writeFileSync(join(store.snapDir, '.build-xyz.sqlite'), 'x')
    const txn = join(store.txPending, '999-uncommitted.txn')
    mkdirSync(txn, { recursive: true })
    writeFileSync(join(txn, 'changeset.bin'), 'partial') // no COMMITTED marker

    assert.equal(store.validate().state, 'in-flight-capture')
    const res = store.repair()
    assert.ok(res.actions.length >= 3, `repair took actions: ${res.actions.join('; ')}`)
    assert.equal(store.validate().state, 'sealed')
    assert.equal(store.currentVersion(), 3, 'restored to the last published head, not the orphan')
    assert.ok(!existsSync(store.snapshotPath(4)), 'orphan removed')
    assert.equal(count(store), 3, 'no published data lost (R1)')
    assert.ok(
      existsSync(join(store.txQuarantine, '999-uncommitted.txn')),
      'uncommitted tx quarantined',
    )
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

test('repair preserves every snapshot when no clean recovery point exists', () => {
  const { store, cleanup } = storeAt(2)
  try {
    const paths = store.snapshotVersions().map((version) => store.snapshotPath(version))
    for (const path of paths) {
      writeFileSync(path, 'damaged-but-still-forensically-valuable')
    }

    assert.throws(() => store.repair(), /no snapshot (?:matches|integrity-clean)/)
    for (const path of paths) {
      assert.equal(existsSync(path), true, `repair must preserve ${path}`)
    }
  } finally {
    cleanup()
  }
})

test('repair refuses to mutate while a publisher lock is present', () => {
  const { store, cleanup } = storeAt(1)
  try {
    const transient = join(store.snapDir, '.build-live.sqlite')
    writeFileSync(transient, 'live work')
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), JSON.stringify({ token: 'live' }))

    assert.throws(() => store.repair(), /repair refused: publish\.lock is present/)
    assert.equal(existsSync(transient), true)
    assert.equal(existsSync(store.snapshotPath(1)), true)
  } finally {
    cleanup()
  }
})

test('repair reclaims a stale publisher lock before restoring the store', () => {
  const { store, cleanup } = storeAt(1)
  try {
    const transient = join(store.snapDir, '.build-abandoned.sqlite')
    writeFileSync(transient, 'abandoned work')
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), JSON.stringify({ token: 'dead' }))
    const old = new Date(Date.now() - 10_000)
    utimesSync(store.publishLock, old, old)

    const result = store.repair({ lockOpts: { staleMs: 100, timeoutMs: 500, pollMs: 5 } })
    assert.ok(result.actions.some((action) => action.includes('removed transient')))
    assert.equal(existsSync(transient), false)
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('repair revalidates its fence before every destructive step', () => {
  const { store, cleanup } = storeAt(1)
  try {
    copyFileSync(store.snapshotPath(1), store.snapshotPath(2))
    const snapshotVersions = store.snapshotVersions.bind(store)
    let calls = 0
    store.snapshotVersions = (): number[] => {
      calls += 1
      if (calls === 2) {
        writeFileSync(
          join(store.publishLock, 'owner.json'),
          JSON.stringify({ token: 'successor', pid: 1, host: 'other', at: Date.now() }),
        )
      }
      return snapshotVersions()
    }

    assert.throws(() => store.repair(), /repair lost ownership of publish\.lock before mutation/)
    assert.equal(existsSync(store.snapshotPath(2)), true, 'the orphan remains for a fenced retry')
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
      v.issues.some((i) => i.includes('.direct-deadbeef')) &&
        v.issues.some((i) => i.includes('.work-A-deadbeef')),
      `both transient kinds named in issues: ${JSON.stringify(v.issues)}`,
    )
    store.repair()
    assert.equal(
      existsSync(join(store.snapDir, '.direct-deadbeef.sqlite')),
      false,
      'repair removed the .direct- orphan',
    )
    assert.equal(
      existsSync(join(store.txPending, '.work-A-deadbeef.sqlite')),
      false,
      'repair removed the .work- orphan',
    )
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('root pointer transients are surfaced, swept by gc, and removed by repair', () => {
  const { store, cleanup } = storeAt(1)
  try {
    const stale = join(store.dir, 'current.deadbeef.tmp')
    writeFileSync(stale, '1')
    const old = new Date(Date.now() - 120_000)
    utimesSync(stale, old, old)
    assert.equal(store.validate().state, 'in-flight-capture')
    assert.ok(store.validate().issues.some((issue) => issue.includes('current.deadbeef.tmp')))

    store.gc({ transientStaleMs: 60_000 })
    assert.equal(existsSync(stale), false, 'gc sweeps stale root transient')

    const fresh = join(store.dir, 'fsqlite.json.deadbeef.tmp')
    writeFileSync(fresh, '{}')
    store.repair()
    assert.equal(existsSync(fresh), false, 'repair removes fresh root transient')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})
