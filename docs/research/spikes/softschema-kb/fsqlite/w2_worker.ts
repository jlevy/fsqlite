// W2 child processes: a writer that captures a share of a delta batch as envelopes, and a
// reader that runs the W3 queries in a loop and follows each newly published version.
//
//   node w2_worker.ts writer <store> <rows.jsonl> <writer-id> <envelopes> <strategy>
//   node w2_worker.ts reader <store> <scale> <out.json> <stop-file>
//
// The writer prints one JSON report. Strategy `snapshot` captures SnapshotStore envelopes
// (published later by reconcile); `direct` publishes each envelope with DirectStore.write.

import { existsSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { DirectStore, FsqliteError } from './fsq.ts'
import type { ReadLease } from './fsq.ts'
import { forEachRowSync, isMain, maxRssMiB, nowMs, round } from './common.ts'
import type { KbRow, NodeRow } from './common.ts'
import { GENERIC_SCHEMA_VERSION, GenericLoader, genericDdl } from './mapping.ts'
import { KbQueries } from './queries.ts'
import { genericStore, openReader, queryInstances } from './w3.ts'

/** gc refuses, retryably, when a peer publishes during it; try again a few times. */
export function gcWithRetry(gc: () => unknown, attempts = 10): number {
  for (let i = 0; ; i++) {
    try {
      gc()
      return i
    } catch (error) {
      if (!(error instanceof FsqliteError) || error.code !== 'retryable' || i + 1 >= attempts) {
        throw error
      }
    }
  }
}

function writer(
  dir: string,
  rowsPath: string,
  writerId: string,
  envelopes: number,
  strategy: string,
) {
  const nodes: NodeRow[] = []
  const units: KbRow[][] = []
  let prev = ''
  forEachRowSync(rowsPath, (row) => {
    if (row.t === 'node') {
      nodes.push(row)
      return
    }
    // A v2 unit starts at its op (or invalid) row; a v1 unit at its doc row.
    const starts =
      row.t === 'op' ||
      row.t === 'invalid' ||
      (row.t === 'doc' && prev !== 'op') ||
      units.length === 0
    if (starts) {
      units.push([row])
    } else {
      units[units.length - 1]?.push(row)
    }
    prev = row.t
  })
  const perEnvelope = Math.max(1, Math.ceil(units.length / envelopes))
  const snapshot = genericStore(dir)
  const direct = new DirectStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
  })
  const captures: {
    ms: number
    units: number
    version?: number
    tx?: string | null
    gc_ms?: number
    gcRetries?: number | string
  }[] = []
  const t0 = nowMs()
  for (let i = 0; i < units.length; i += perEnvelope) {
    const batch = units.slice(i, i + perEnvelope)
    const apply = (db: DatabaseSync): void => {
      const loader = new GenericLoader(db)
      for (const node of nodes) {
        loader.add(node)
      }
      for (const row of batch.flat()) {
        loader.add(row)
      }
    }
    const t = nowMs()
    if (strategy === 'direct') {
      const version = direct.write(apply, { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
      const ms = round(nowMs() - t)
      // Each DirectStore write publishes a full generation; collect the old ones (readers
      // keep theirs through read leases), or disk grows by one head per write.
      // Best effort: under contention gc keeps refusing, because a peer moves `current`
      // during its full integrity check. A later gc collects whatever this one left.
      const tGc = nowMs()
      let gcRetries: number | string
      try {
        gcRetries = gcWithRetry(
          () => direct.gc({ retain: 0, lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } }),
          3,
        )
      } catch (error) {
        if (!(error instanceof FsqliteError) || error.code !== 'retryable') {
          throw error
        }
        gcRetries = 'refused 3 times'
      }
      captures.push({ ms, units: batch.length, version, gc_ms: round(nowMs() - tGc), gcRetries })
    } else {
      const tx = snapshot.write(writerId, apply)
      captures.push({ ms: round(nowMs() - t), units: batch.length, tx })
    }
  }
  console.log(
    JSON.stringify({
      writer: writerId,
      strategy,
      units: units.length,
      envelopes: captures.length,
      total_ms: round(nowMs() - t0),
      captures,
      started_at: Date.now() - (nowMs() - t0),
      max_rss_mib: maxRssMiB(),
    }),
  )
}

function reader(dir: string, scale: string, outPath: string, stopFile: string) {
  const store = genericStore(dir)
  const instances = queryInstances(scale)
  const samples: [number, number, string][] = []
  const versions: { version: number; seen_at: number; open_ms: number }[] = []
  const errors: { at: number; query: string; message: string }[] = []
  let lease: ReadLease | null = null
  let db: DatabaseSync | null = null
  let queries: KbQueries | null = null
  let current = -1
  let i = 0
  writeFileSync(`${outPath}.ready`, '')
  while (!existsSync(stopFile)) {
    try {
      const v = store.currentVersion()
      if (v !== current) {
        const t = nowMs()
        const next = store.readLease()
        db?.close()
        lease?.release()
        lease = next
        db = openReader(store.snapshotPath(next.version))
        queries = new KbQueries(db)
        current = next.version
        versions.push({ version: current, seen_at: Date.now(), open_ms: round(nowMs() - t) })
      }
    } catch (error) {
      errors.push({ at: Date.now(), query: '(open)', message: String(error) })
      continue
    }
    const q = instances[i++ % instances.length]
    if (!q || !queries) {
      continue
    }
    const t = nowMs()
    try {
      queries.run(q.category, q.params)
      samples.push([Date.now(), round(nowMs() - t, 4), q.name])
    } catch (error) {
      errors.push({ at: Date.now(), query: q.name, message: String(error) })
    }
  }
  db?.close()
  lease?.release()
  writeFileSync(outPath, JSON.stringify({ samples, versions, errors, max_rss_mib: maxRssMiB() }))
}

/** Group rows into units: each doc row starts a unit; node rows are shared by all units. */
export function readUnits(rowsPath: string): { nodes: NodeRow[]; units: KbRow[][] } {
  const nodes: NodeRow[] = []
  const units: KbRow[][] = []
  let prev = ''
  forEachRowSync(rowsPath, (row) => {
    if (row.t === 'node') {
      nodes.push(row)
      return
    }
    // A v2 unit starts at its op (or invalid) row; a v1 unit at its doc row.
    const starts =
      row.t === 'op' ||
      row.t === 'invalid' ||
      (row.t === 'doc' && prev !== 'op') ||
      units.length === 0
    if (starts) {
      units.push([row])
    } else {
      units[units.length - 1]?.push(row)
    }
    prev = row.t
  })
  return { nodes, units }
}

/** Sustained trickle: capture one-record envelopes until the deadline. */
function trickleWriter(dir: string, rowsPath: string, writerId: string, deadline: number) {
  const { nodes, units } = readUnits(rowsPath)
  const store = genericStore(dir)
  const captures: { tx: string | null; start: number; end: number }[] = []
  for (const unit of units) {
    if (Date.now() >= deadline) {
      break
    }
    const start = Date.now()
    const tx = store.write(writerId, (db) => {
      const loader = new GenericLoader(db)
      for (const node of nodes) {
        loader.add(node)
      }
      for (const row of unit) {
        loader.add(row)
      }
    })
    captures.push({ tx, start, end: Date.now() })
  }
  console.log(JSON.stringify({ writer: writerId, captures, max_rss_mib: maxRssMiB() }))
}

/** Reconcile whatever is pending, then gc with the given retention, until told to stop. */
function reconciler(dir: string, stopFile: string, retain: number) {
  const store = genericStore(dir)
  const rounds: Record<string, unknown>[] = []
  for (;;) {
    const pending = store.pendingTxns().map((t) => t.replace(/\.txn$/, ''))
    if (pending.length === 0) {
      if (existsSync(stopFile)) {
        break
      }
      const until = Date.now() + 5
      while (Date.now() < until) {
        // A short spin keeps this loop synchronous; the writer runs in its own process.
      }
      continue
    }
    const start = Date.now()
    const result = store.reconcile({ lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
    const published = Date.now()
    let gc = { removed: 0, integrityChecked: false }
    gcWithRetry(() => (gc = store.gc({ retain })))
    rounds.push({
      pending,
      start,
      published,
      reconcile_ms: published - start,
      gc_ms: Date.now() - published,
      gc_removed: gc.removed,
      gc_integrity_checked: gc.integrityChecked,
      version: result.published,
      applied: result.applied,
    })
  }
  console.log(JSON.stringify({ rounds, max_rss_mib: maxRssMiB() }))
}

if (isMain(import.meta.url)) {
  const [role, ...rest] = process.argv.slice(2)
  if (role === 'writer') {
    const [dir, rows, id, envelopes, strategy] = rest
    writer(dir!, rows!, id!, Number(envelopes), strategy ?? 'snapshot')
  } else if (role === 'reader') {
    const [dir, scale, out, stop] = rest
    reader(dir!, scale!, out!, stop!)
  } else if (role === 'trickle-writer') {
    const [dir, rows, id, deadline] = rest
    trickleWriter(dir!, rows!, id!, Number(deadline))
  } else if (role === 'reconciler') {
    const [dir, stop, retain] = rest
    reconciler(dir!, stop!, Number(retain ?? 0))
  } else if (role !== undefined) {
    throw new Error('usage: w2_worker.ts writer|reader|trickle-writer|reconciler ...')
  }
}
