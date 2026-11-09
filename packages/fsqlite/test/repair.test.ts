// doctor/repair: restore the last consistent point from a torn/in-flight store.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
import { setOwnerWriterForTest } from '../src/lock.ts'
import { ownerRecord, STORE_OPTS, tmpStore } from './fixture.ts'

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
    const abandoned = new Date(Date.now() - 120_000) // a capture that died long ago
    utimesSync(txn, abandoned, abandoned)

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

/** Every path below `dir` with its size and mtime, to prove a dry run changed nothing. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((entry) => {
      const st = statSync(join(dir, entry))
      return `${entry} ${st.isDirectory() ? 'dir' : String(st.size)} ${st.mtimeMs}`
    })
}

test('planRepair reports the steps repair would take and changes nothing', () => {
  const { store, dir, cleanup } = storeAt(1)
  try {
    copyFileSync(store.snapshotPath(1), store.snapshotPath(2)) // orphan ahead of pointer
    writeFileSync(join(store.snapDir, '.build-xyz.sqlite'), 'x')
    const txn = join(store.txPending, '999-uncommitted.txn')
    mkdirSync(txn, { recursive: true })
    const abandoned = new Date(Date.now() - 120_000)
    utimesSync(txn, abandoned, abandoned)
    writeFileSync(store.currentPath, 'torn')
    const before = tree(dir)

    const plan = store.planRepair()
    assert.equal(plan.state, 'corrupt')
    assert.deepEqual(plan.actions, [
      're-publish current -> 2',
      'remove transient .build-xyz.sqlite',
      'quarantine uncommitted 999-uncommitted.txn',
    ])
    assert.deepEqual(tree(dir), before, 'a plan takes no lock and changes no file')
    assert.equal(readFileSync(store.currentPath, 'utf8'), 'torn')

    assert.deepEqual(store.repair().actions, [
      're-published current -> 2',
      'removed transient .build-xyz.sqlite',
      'quarantined uncommitted 999-uncommitted.txn',
    ])
    assert.deepEqual(store.planRepair(), { actions: [], state: 'sealed' })
  } finally {
    cleanup()
  }
})

test('planRepair refuses whenever repair would', () => {
  const { store, cleanup } = storeAt(1)
  try {
    mkdirSync(store.publishLock)
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('live'))
    assert.throws(
      () => store.planRepair(),
      (error: unknown) => error instanceof FsqliteError && error.code === 'in-flight',
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
    assert.ok(res.actions.some((a) => a.includes('removed corrupt snapshot 2')))
    assert.equal(count(store), 1, 'v1 (the last clean head) is intact')
    // The envelope v2 published is archived but absent from v1's ledger, so repair returns
    // it to the pending tail instead of losing it with the corrupt head.
    assert.ok(res.actions.some((a) => a.startsWith('returned archived ')))
    assert.equal(res.state, 'live')
    assert.equal(store.reconcile().applied, 1)
    assert.equal(count(store), 2, 'the next reconcile refolds the v2 delta')
    assert.equal(store.validate().state, 'sealed')
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
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('live'))

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
    writeFileSync(join(store.publishLock, 'owner.json'), ownerRecord('dead'))
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
    // A successor takes the lock after repair's last snapshot scan (and heartbeat) but
    // before its first mutation: listing the transient directories is the plan's last
    // read-only step.
    const internal = store as unknown as { transientDirs: () => string[] }
    const transientDirs = internal.transientDirs.bind(store)
    internal.transientDirs = (): string[] => {
      writeFileSync(
        join(store.publishLock, 'owner.json'),
        JSON.stringify({ token: 'successor', pid: 1, host: 'other', at: Date.now() }),
      )
      return transientDirs()
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
    const grave = join(store.dir, 'publish.lock.deadbeef00.tmp')
    mkdirSync(grave)
    writeFileSync(join(grave, 'owner.json'), ownerRecord('broken'))
    store.repair()
    assert.equal(existsSync(fresh), false, 'repair removes fresh root transient')
    assert.equal(existsSync(grave), false, 'repair removes a lock moved aside by a crashed break')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

test('init journal and lease temps are surfaced, swept by gc, and removed by repair', () => {
  const { store, cleanup } = storeAt(1)
  try {
    // SQLite's journal for init's snapshot-0 temp, and a crashed readLease's lease temp.
    const debris = () => [
      join(store.snapDir, '000000000000.fsqlite.sqlite.deadbeef00.tmp-journal'),
      join(store.leaseDir, '000001762600000-deadbeef00.lease.abcdef0123.tmp'),
    ]
    const plant = (ageMs: number): void => {
      const at = new Date(Date.now() - ageMs)
      for (const path of debris()) {
        writeFileSync(path, 'x')
        utimesSync(path, at, at)
      }
    }
    plant(120_000)
    const validation = store.validate()
    assert.equal(validation.state, 'in-flight-capture')
    for (const path of debris()) {
      assert.ok(
        validation.issues.some((issue) => issue.includes(basename(path))),
        `validate names ${basename(path)}: ${JSON.stringify(validation.issues)}`,
      )
    }

    store.gc({ transientStaleMs: 60_000 })
    assert.deepEqual(debris().filter(existsSync), [], 'gc sweeps both stale transients')

    plant(0)
    store.repair()
    assert.deepEqual(debris().filter(existsSync), [], 'repair removes both transients')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})

/** An envelope dir a writer began but has not committed, `ageMs` after its last write. */
function uncommittedEnvelope(store: SnapshotStore, ageMs: number): string {
  const txn = '000001762600000000-000000000000-w-deadbeef00.txn'
  const txDir = join(store.txPending, txn)
  mkdirSync(txDir)
  writeFileSync(join(txDir, 'changeset.bin'), 'partial')
  writeFileSync(join(txDir, 'manifest.json'), '{}')
  const at = new Date(Date.now() - ageMs)
  utimesSync(txDir, at, at)
  return txn
}

test('repair keeps an envelope that commits between its check and its quarantine move', () => {
  const { store, cleanup } = storeAt(1)
  try {
    const txn = uncommittedEnvelope(store, 120_000)
    const move = (store as unknown as { move: (txns: string[], dest: string) => void }).move.bind(
      store,
    )
    Object.assign(store, {
      move: (txns: string[], dest: string): void => {
        writeFileSync(join(store.txPending, txn, 'COMMITTED'), '') // the writer finishes here
        move(txns, dest)
      },
    })

    const result = store.repair()

    assert.equal(existsSync(join(store.txPending, txn, 'COMMITTED')), true, 'still pending')
    assert.equal(existsSync(join(store.txPending, txn, 'QUARANTINE')), false)
    assert.equal(existsSync(join(store.txQuarantine, txn)), false)
    assert.ok(result.actions.some((action) => action.includes(`kept ${txn}`)))
  } finally {
    cleanup()
  }
})

test('repair leaves a fresh uncommitted envelope to its possibly live writer', () => {
  const { store, cleanup } = storeAt(1)
  try {
    const txn = uncommittedEnvelope(store, 0)

    const result = store.repair()

    assert.equal(existsSync(join(store.txPending, txn)), true)
    assert.equal(existsSync(join(store.txQuarantine, txn)), false)
    assert.equal(result.state, 'in-flight-capture', 'the capture in progress is still reported')
  } finally {
    cleanup()
  }
})

test('repair that loses publish.lock as it acquires it mutates nothing', () => {
  const { store, cleanup } = storeAt(1)
  try {
    copyFileSync(store.snapshotPath(1), store.snapshotPath(2)) // an orphan repair would remove
    // A successor's token lands in owner.json as repair takes the lock, so its first fence
    // check fails before any step.
    setOwnerWriterForTest((path) => {
      writeFileSync(path, JSON.stringify({ token: 'successor', pid: 1, host: 'other', at: 0 }))
    })
    assert.throws(
      () => store.repair(),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'retryable' &&
        error.message === 'repair lost ownership of publish.lock before mutation',
    )
    assert.equal(existsSync(store.snapshotPath(2)), true, 'the orphan remains for a fenced retry')
    assert.equal(readFileSync(store.currentPath, 'utf8'), '1')
  } finally {
    setOwnerWriterForTest(null)
    cleanup()
  }
})
