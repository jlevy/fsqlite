// Crash-recovery: kill reconcile at every publish step and prove recovery to
// exactly-once. The guarantees under test are R1 (never lose a published snapshot) and
// exactly once through the applied_tx ledger and atomic pointer swap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { SnapshotStore } from '../src/index.ts'
import { setReconcileCrashForTest } from '../src/snapshotStore.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const count = (store: SnapshotStore): number =>
  store.read((db) => (db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number }).c)

function storeWith(n: number) {
  const { dir, cleanup } = tmpStore()
  const store = new SnapshotStore(dir, STORE_OPTS).init()
  for (let i = 0; i < n; i++) {
    store.write('A', (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`a${i}`, 'A', 't')
    })
  }
  return { store, dir, cleanup }
}

for (const crashAt of ['after-build', 'after-snapshot', 'after-pointer'] as const) {
  test(`crash ${crashAt} then recover → exactly-once, no loss`, () => {
    const { store, cleanup } = storeWith(3)
    try {
      const before = store.currentVersion()
      setReconcileCrashForTest(crashAt)
      assert.throws(() => store.reconcile(), /CRASH/)
      setReconcileCrashForTest(null)

      const afterCrash = store.currentVersion()
      if (crashAt === 'after-pointer') {
        assert.equal(afterCrash, before + 1)
      } else {
        assert.equal(afterCrash, before, 'a crash before the pointer swap leaves current intact')
      }
      if (crashAt === 'after-snapshot') {
        assert.throws(() => store.reconcile(), /already exists ahead of current/)
        store.repair() // the fixture has no live clients; classify the orphan explicitly
      }

      store.reconcile()
      assert.equal(count(store), 3, 'all 3 tx present exactly once after recovery')
      assert.deepEqual(store.pendingTxns(), [], 'pending tail drained')
      // A crash runs no cleanup, so only the after-build crash leaves its build behind.
      assert.equal(
        store.validate().state,
        crashAt === 'after-build' ? 'in-flight-capture' : 'sealed',
      )
    } finally {
      setReconcileCrashForTest(null)
      cleanup()
    }
  })
}

test('an orphan snapshot ahead of the pointer blocks publication until explicit repair', () => {
  const { store, cleanup } = storeWith(2)
  try {
    try {
      setReconcileCrashForTest('after-snapshot')
      assert.throws(() => store.reconcile(), /CRASH after-snapshot/)
    } finally {
      setReconcileCrashForTest(null)
    }
    const cur = store.currentVersion()
    assert.ok(
      existsSync(store.snapshotPath(cur + 1)),
      'orphan snapshot ahead of pointer exists after the crash',
    )
    assert.equal(store.validate().state, 'in-flight-capture')
    assert.throws(() => store.reconcile(), /already exists ahead of current/)
    assert.ok(existsSync(store.snapshotPath(cur + 1)), 'failed publication preserved evidence')
    store.repair()
    store.reconcile()
    store.gc({ retain: 0 })
    const ahead = readdirSync(store.snapDir)
      .map((f) => /^(\d+)\.fsqlite\.sqlite$/.exec(f)?.[1])
      .filter((x): x is string => Boolean(x))
      .map(Number)
      .filter((v) => v > store.currentVersion())
    assert.equal(ahead.length, 0, 'no snapshot ahead of the pointer after recovery and gc')
  } finally {
    cleanup()
  }
})
