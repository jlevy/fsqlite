// Multi-process concurrency: the heart of the package. Real child processes (not
// threads) write, reconcile, and read one store at once, proving:
//   - N lock-free writers lose zero committed tx after reconcile
//   - racing reconcilers publish exactly-once and leave an integrity-clean head
//   - readers during concurrent publishes never see a torn/regressing snapshot

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
  errors: number
  firstError: string | null
  distinct: number
}

/** How long the readers may take to start before the test fails instead of hanging. */
const READERS_READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 10

/** Wait until `ready()` holds, failing after a bound rather than hanging the suite. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + READERS_READY_TIMEOUT_MS
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await delay(READY_POLL_MS)
  }
}

test('N concurrent writer processes lose zero committed tx after reconcile', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    const WRITERS = 6
    const PER = 10
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        runAsync<WriterResult>('writer.ts', [dir, `w${i}`, String(PER)]),
      ),
    )
    const totalWritten = results.reduce((s, r) => s + r.written, 0)
    assert.equal(totalWritten, WRITERS * PER, 'every writer committed all its envelopes')

    const store = new SnapshotStore(dir, STORE_OPTS)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 50) {
      store.reconcile()
    }
    assert.equal(count(store), WRITERS * PER, 'reconcile folded in every committed tx without loss')
    assert.equal(store.validate().state, 'sealed')
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
    for (let i = 0; i < WRITERS; i++) {
      runSync<WriterResult>('writer.ts', [dir, `w${i}`, String(PER)])
    }

    const RECONCILERS = 4
    const results = await Promise.all(
      Array.from({ length: RECONCILERS }, () =>
        runAsync<ReconcilerResult>('reconciler.ts', [dir, '100']),
      ),
    )
    const store = new SnapshotStore(dir, STORE_OPTS)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 50) {
      store.reconcile()
    }

    assert.equal(count(store), WRITERS * PER, 'exactly-once: no tx lost, none double-applied')
    assert.equal(count(store, 'applied_tx'), WRITERS * PER, 'ledger has exactly one row per tx')
    assert.equal(store.validate().state, 'sealed')
    const totalApplied = results.reduce((s, r) => s + r.totalApplied, 0)
    assert.ok(totalApplied >= WRITERS * PER)
  } finally {
    cleanup()
  }
})

test('readers during concurrent publishes never fail, tear, or regress', async () => {
  const { dir, cleanup } = tmpStore()
  const control = mkdtempSync(join(tmpdir(), 'fsqlite-readers-'))
  try {
    const store = new SnapshotStore(dir, STORE_OPTS).init()
    const READERS = 3
    const PUBLISHES = 25
    const readers = Array.from({ length: READERS }, () =>
      runAsync<ReaderResult>('reader.ts', [dir, '20000', control]),
    )
    // Publish only once every reader is polling, one envelope per reconcile, so each
    // reader overlaps many pointer swaps.
    await waitUntil(
      () => readdirSync(control).filter((f) => f.startsWith('ready-')).length === READERS,
      'every reader to start',
    )
    for (let i = 0; i < PUBLISHES; i++) {
      store.write('w', (db) =>
        db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(`pub-${i}`, 'P', 't'),
      )
      assert.equal(store.reconcile().applied, 1)
      await delay(0) // let the readers run between publishes
    }
    writeFileSync(join(control, 'stop'), '')
    const results = await Promise.all(readers)

    assert.equal(store.currentVersion(), PUBLISHES)
    for (const r of results) {
      assert.equal(r.errors, 0, `reader ${r.pid} failed a read: ${r.firstError ?? ''}`)
      assert.equal(r.torn, false, `reader ${r.pid} saw a regressing snapshot count`)
      assert.equal(r.last, PUBLISHES, `reader ${r.pid} read the final publish`)
      assert.ok(r.distinct >= 2, `reader ${r.pid} observed ${r.distinct} published version(s)`)
    }
  } finally {
    rmSync(control, { recursive: true, force: true })
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
      Array.from({ length: WRITERS }, (_, i) =>
        runAsync<WriterResult>('direct-writer.ts', [dir, `d${i}`, String(PER)]),
      ),
    )
    const total = results.reduce((s, r) => s + r.written, 0)
    assert.equal(total, WRITERS * PER)
    const store = new SnapshotStore(dir, STORE_OPTS)
    assert.equal(
      count(store),
      WRITERS * PER,
      'every direct write published exactly once without loss',
    )
    assert.equal(store.currentVersion(), WRITERS * PER, 'one published version per direct write')
    assert.equal(store.validate().state, 'sealed')
  } finally {
    cleanup()
  }
})
