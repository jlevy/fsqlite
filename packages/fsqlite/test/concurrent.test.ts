// Multi-process concurrency: the heart of the package. Real child processes (not
// threads) write, reconcile, and read one store at once, proving:
//   - N lock-free writers lose zero committed tx after reconcile
//   - racing reconcilers publish exactly-once and leave an integrity-clean head
//   - readers during concurrent publishes never see a torn/regressing snapshot

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore, DirectStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'
import { runSync, runAsync } from './spawn.ts'

const count = (store: SnapshotStore, table = 'artifacts'): number =>
  store.read((db) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c)

interface WriterResult {
  writerId: string
  written: number
}
interface ReconcilerResult {
  pid: number
  totalApplied: number
  passes: number
}
interface ReaderResult {
  pid: number
  reads: number
  last: number
  torn: boolean
}

test('N concurrent writer processes lose zero committed tx after reconcile', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    const WRITERS = 6
    const PER = 10
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) => runAsync<WriterResult>('writer.ts', [dir, `w${i}`, String(PER)])),
    )
    const totalWritten = results.reduce((s, r) => s + r.written, 0)
    assert.equal(totalWritten, WRITERS * PER, 'every writer committed all its envelopes')

    const store = new SnapshotStore(dir, STORE_OPTS)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 50) store.reconcile()
    assert.equal(count(store), WRITERS * PER, 'reconcile folded in every committed tx — zero loss')
    assert.notEqual(store.validate().state, 'corrupt')
  } finally {
    cleanup()
  }
})

test('racing reconciler processes publish exactly-once with an integrity-clean head', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    const WRITERS = 5
    const PER = 8
    for (let i = 0; i < WRITERS; i++) runSync<WriterResult>('writer.ts', [dir, `w${i}`, String(PER)])

    const RECONCILERS = 4
    const results = await Promise.all(
      Array.from({ length: RECONCILERS }, () => runAsync<ReconcilerResult>('reconciler.ts', [dir, '100'])),
    )
    const store = new SnapshotStore(dir, STORE_OPTS)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 50) store.reconcile()

    assert.equal(count(store), WRITERS * PER, 'exactly-once: no tx lost, none double-applied')
    assert.equal(count(store, 'applied_tx'), WRITERS * PER, 'ledger has exactly one row per tx')
    assert.notEqual(store.validate().state, 'corrupt')
    const totalApplied = results.reduce((s, r) => s + r.totalApplied, 0)
    assert.ok(totalApplied >= WRITERS * PER)
  } finally {
    cleanup()
  }
})

test('readers during concurrent publishes never see a torn or regressing snapshot', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    for (let i = 0; i < 5; i++) runSync<WriterResult>('writer.ts', [dir, `w${i}`, '8'])

    const readers = Array.from({ length: 3 }, () => runAsync<ReaderResult>('reader.ts', [dir, '300']))
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 200) {
      store.reconcile()
      await new Promise((r) => setTimeout(r, 2))
    }
    const results = await Promise.all(readers)
    for (const r of results) {
      assert.equal(r.torn, false, `reader ${r.pid} saw a regressing snapshot count`)
      assert.ok(r.reads > 0)
    }
  } finally {
    cleanup()
  }
})

test('N concurrent direct-writer processes serialize via the lock with zero loss', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    new DirectStore(dir, STORE_OPTS).init()
    const WRITERS = 5
    const PER = 6
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) => runAsync<WriterResult>('direct-writer.ts', [dir, `d${i}`, String(PER)])),
    )
    const total = results.reduce((s, r) => s + r.written, 0)
    assert.equal(total, WRITERS * PER)
    const store = new SnapshotStore(dir, STORE_OPTS)
    assert.equal(count(store), WRITERS * PER, 'every direct write published exactly once — serialized, zero loss')
    assert.equal(store.currentVersion(), WRITERS * PER, 'one published version per direct write')
    assert.notEqual(store.validate().state, 'corrupt')
  } finally {
    cleanup()
  }
})
