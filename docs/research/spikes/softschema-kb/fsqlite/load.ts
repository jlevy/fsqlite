// W1 full rebuild: load one intermediate JSONL file into a new fsqlite store.
//
// Usage: node load.ts <rows.jsonl> <store-dir> [--route direct|snapshot] [--batch N]
//
// `direct` runs init() with the generic DDL, then one DirectStore.write that streams every
// row in a single transaction, checks the counts against `_graph/stats.json`, and only
// then lets fsqlite publish. `snapshot` captures SnapshotStore envelopes of `--batch` rows
// each and folds them with one reconcile. Prints one JSON report on stdout.

import { rmSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { DirectStore, SnapshotStore } from './fsq.ts'
import { forEachRowSync, isMain, maxRssMiB, nowMs, parseArgs, round } from './common.ts'
import type { KbRow } from './common.ts'
import { GENERIC_POLICY, GENERIC_SCHEMA_VERSION, GenericLoader, genericDdl } from './mapping.ts'

/** Compare loaded counts with the export's own `stats.json`, as paraverse's loader does. */
export function countProblems(db: DatabaseSync): string[] {
  const row = db.prepare("SELECT text FROM kb_file WHERE path = '_graph/stats.json'").get() as
    { text: string } | undefined
  if (!row) {
    return ['no _graph/stats.json']
  }
  const stats = JSON.parse(row.text) as {
    nodes: Record<string, number>
    edges: Record<string, number>
  }
  const problems: string[] = []
  const compare = (label: string, expected: Record<string, number>, sql: string): void => {
    const actual = new Map(
      (db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]),
    )
    for (const key of new Set([...Object.keys(expected), ...actual.keys()])) {
      if ((expected[key] ?? 0) !== (actual.get(key) ?? 0)) {
        problems.push(
          `${label}.${key}: expected ${expected[key] ?? 0}, loaded ${actual.get(key) ?? 0}`,
        )
      }
    }
  }
  compare('nodes', stats.nodes, 'SELECT kind AS k, count(*) AS n FROM entity GROUP BY kind')
  compare('edges', stats.edges, 'SELECT relation AS k, count(*) AS n FROM edge GROUP BY relation')
  return problems
}

/** Larger page cache for bulk work; a connection setting, not a schema change. */
const BULK_PRAGMAS = 'PRAGMA cache_size = -262144;'

export function loadDirect(jsonl: string, dir: string): Record<string, unknown> {
  const t0 = nowMs()
  const store = new DirectStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
  }).init()
  const tInit = nowMs()
  let counts: GenericLoader['counts'] | undefined
  let loadMs = 0
  let checkMs = 0
  const version = store.write(
    (db) => {
      db.exec(BULK_PRAGMAS)
      const t = nowMs()
      const loader = new GenericLoader(db, true)
      forEachRowSync(jsonl, (row) => loader.add(row))
      counts = loader.counts
      const t2 = nowMs()
      loadMs = t2 - t
      const problems = countProblems(db)
      checkMs = nowMs() - t2
      if (problems.length > 0) {
        throw new Error(`load does not match stats.json: ${problems.slice(0, 5).join('; ')}`)
      }
    },
    { lockOpts: { staleMs: 600_000, timeoutMs: 600_001 } },
  )
  const tWrite = nowMs()
  return {
    route: 'direct',
    version,
    counts,
    init_ms: round(tInit - t0),
    callback_load_ms: round(loadMs),
    callback_check_ms: round(checkMs),
    write_total_ms: round(tWrite - tInit),
    publish_overhead_ms: round(tWrite - tInit - loadMs - checkMs),
    total_ms: round(tWrite - t0),
    snapshot: store.snapshotPath(version),
  }
}

export function loadSnapshot(jsonl: string, dir: string, batch: number): Record<string, unknown> {
  const t0 = nowMs()
  const store = new SnapshotStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
    conflictPolicy: GENERIC_POLICY,
  }).init()
  const tInit = nowMs()
  // Rows are buffered per batch because a capture callback must run synchronously.
  let pending: KbRow[] = []
  let captures = 0
  let captureMs = 0
  const counts = { schema: 0, file: 0, doc: 0, entity: 0, edge: 0 }
  const flush = (): void => {
    if (pending.length === 0) {
      return
    }
    const rows = pending
    pending = []
    const t = nowMs()
    store.write(`import-${captures}`, (db) => {
      db.exec(BULK_PRAGMAS)
      const loader = new GenericLoader(db, true)
      for (const row of rows) {
        loader.add(row)
      }
      for (const [k, v] of Object.entries(loader.counts)) {
        counts[k as keyof typeof counts] += v
      }
    })
    captureMs += nowMs() - t
    captures++
  }
  forEachRowSync(jsonl, (row) => {
    pending.push(row)
    if (pending.length >= batch) {
      flush()
    }
  })
  flush()
  const tCaptured = nowMs()
  const result = store.reconcile({ lockOpts: { staleMs: 600_000, timeoutMs: 600_001 } })
  const tReconciled = nowMs()
  const problems = store.read((db) => countProblems(db))
  return {
    route: 'snapshot',
    batch,
    captures,
    counts,
    reconcile: result,
    init_ms: round(tInit - t0),
    capture_ms: round(captureMs),
    read_and_capture_ms: round(tCaptured - tInit),
    reconcile_ms: round(tReconciled - tCaptured),
    total_ms: round(tReconciled - t0),
    count_problems: problems,
    snapshot: store.snapshotPath(result.published),
  }
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [jsonl, dir] = args
  if (!jsonl || !dir) {
    throw new Error('usage: load.ts <rows.jsonl> <store-dir> [--route direct|snapshot] [--batch N]')
  }
  rmSync(dir, { recursive: true, force: true })
  const route = flags.route ?? 'direct'
  const report =
    route === 'snapshot'
      ? loadSnapshot(jsonl, dir, Number(flags.batch ?? 20000))
      : loadDirect(jsonl, dir)
  const snapshot = String(report.snapshot)
  console.log(
    JSON.stringify({
      ...report,
      snapshot_bytes: statSync(snapshot).size,
      max_rss_mib: maxRssMiB(),
    }),
  )
}

if (isMain(import.meta.url)) {
  main()
}
