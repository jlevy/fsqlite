import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import { validateLockOptions, withLock } from '../src/lock.ts'
import type { LockOptions } from '../src/lock.ts'
import { ownerRecord, SCHEMA, STORE_OPTS, tmpStore } from './fixture.ts'

test('invalid lock options fail before inspecting or changing a live publisher', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const direct = new DirectStore(dir, { schema: SCHEMA }).init()
    mkdirSync(store.publishLock)
    const ownerPath = join(store.publishLock, 'owner.json')
    const owner = ownerRecord('live-owner')
    writeFileSync(ownerPath, owner)
    const build = join(store.snapDir, '.build-live.sqlite')
    writeFileSync(build, 'live build')
    const invalid: LockOptions[] = [
      { staleMs: 0 },
      { staleMs: -1 },
      { staleMs: NaN },
      { staleMs: Infinity },
      { staleMs: 1.5 },
      { timeoutMs: 0 },
      { timeoutMs: NaN },
      { pollMs: 0 },
      { pollMs: -1 },
      { pollMs: NaN },
      { pollMs: Number.MAX_SAFE_INTEGER + 1 },
      { timeoutMs: 1, staleMs: 1 },
      { onStaleBreak: 'invalid' as unknown as NonNullable<LockOptions['onStaleBreak']> },
    ]
    for (const lockOpts of invalid) {
      for (const operation of [
        () => validateLockOptions(lockOpts),
        () => withLock(store.publishLock, () => assert.fail('must not acquire'), lockOpts),
        () => store.repair({ lockOpts }),
        () => store.planRepair({ lockOpts }),
        () => store.gc({ lockOpts }),
        () => store.reconcile({ lockOpts }),
        () => store.readLease({ lockOpts }),
        () => direct.write(() => assert.fail('must not invoke callback'), { lockOpts }),
      ]) {
        assert.throws(operation, TypeError)
      }
      assert.equal(readFileSync(ownerPath, 'utf8'), owner)
      assert.equal(readFileSync(build, 'utf8'), 'live build')
    }
  } finally {
    cleanup()
  }
})
