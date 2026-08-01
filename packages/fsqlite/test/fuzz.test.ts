// Randomized multi-process chaos. Unlike concurrent.test.ts (which seeds tx then races
// reconcilers), this runs writers, reconcilers, and readers ALL AT ONCE with randomized
// counts and staggered starts: the realistic contention where a reconciler publishes
// while writers are still dropping envelopes. Invariants after draining: zero loss, no
// double-apply, integrity-clean head, readers never torn.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'
import { runAsync } from './spawn.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const rnd = (a: number, b: number): number => a + Math.floor(Math.random() * (b - a + 1))
const count = (s: SnapshotStore, table: string): number =>
  s.read((db) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c)

interface ReaderResult {
  torn: boolean
}

// The jobs array mixes writer/reconciler/reader results; only reader results carry `torn`.
const isReaderResult = (r: unknown): r is ReaderResult => typeof (r as { torn?: unknown }).torn === 'boolean'

test('chaos: concurrent writers + reconcilers + readers converge with zero loss and integrity', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()

    const WRITERS = rnd(4, 7)
    const PER = rnd(5, 10)
    const RECONCILERS = rnd(2, 4)
    const READERS = rnd(2, 3)
    const expected = WRITERS * PER

    const jobs: Promise<unknown>[] = []
    // Writers + readers start immediately.
    for (let i = 0; i < WRITERS; i++) jobs.push(runAsync('writer.ts', [dir, `w${i}`, String(PER)]))
    for (let i = 0; i < READERS; i++) jobs.push(runAsync<ReaderResult>('reader.ts', [dir, '400']))
    // Reconcilers start staggered so some publish WHILE writers are still going.
    for (let i = 0; i < RECONCILERS; i++) {
      jobs.push(sleep(rnd(5, 60)).then(() => runAsync('reconciler.ts', [dir, '200'])))
    }
    const results = await Promise.all(jobs)

    // Drain stragglers (writers that committed after the last reconcile pass).
    const store = new SnapshotStore(dir, STORE_OPTS)
    let guard = 0
    while (store.pendingTxns().length > 0 && guard++ < 80) store.reconcile()

    assert.equal(count(store, 'artifacts'), expected, `zero loss under chaos (writers=${WRITERS} per=${PER})`)
    assert.equal(count(store, 'applied_tx'), expected, 'no double-apply: one ledger row per tx')
    assert.notEqual(store.validate().state, 'corrupt')
    for (const r of results) {
      if (isReaderResult(r)) assert.equal(r.torn, false, 'a reader saw a torn/regressing snapshot')
    }
  } finally {
    cleanup()
  }
})
