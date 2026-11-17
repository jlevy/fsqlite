// W1 full rebuild: load one intermediate JSONL file into a new fsqlite store.
//
// Usage: node load.ts <rows.jsonl> <store-dir> [--route direct|snapshot] [--batch N]
//
// `direct` runs init() with the generic DDL, then one DirectStore.write that streams every
// row in a single transaction, checks the counts against `_graph/stats.json`, and only
// then lets fsqlite publish. `snapshot` captures SnapshotStore envelopes of `--batch` rows
// each and folds them with one reconcile. Prints one JSON report on stdout.

import { rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DirectStore, SnapshotStore } from './fsq.ts'
import { forEachLineSync, isMain, maxRssMiB, nowMs, parseArgs, round } from './common.ts'
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
export const BULK_PRAGMAS = 'PRAGMA cache_size = -262144;'
export const IMPORT_LOCK = { staleMs: 600_000, timeoutMs: 600_001 }

/** Configuration every W1 result records (C17). */
export const LOAD_CONFIG = {
  bulk_pragmas: BULK_PRAGMAS,
  build_journal_mode: 'DELETE (fsqlite builds and publishes in rollback-journal mode)',
  build_synchronous:
    'DirectStore FULL; SnapshotStore working copies and reconcile builds OFF until the publish fsync',
  lock_options: IMPORT_LOCK,
  gc: 'none during the import; w1.ts then runs gc({ retain: 0 }) and times it',
}

/**
 * Stream the rows into `db`, timing three phases: decode (JSON.parse of each intermediate
 * line), transform (derived labels, promoted fields, search text), and ingest (SQLite
 * inserts with index maintenance; indexes exist from init(), since DDL is fixed then).
 */
function streamRows(rows: Iterable<KbRow> | string, loader: GenericLoader): Record<string, number> {
  let decodeMs = 0
  let addMs = 0
  const add = (row: KbRow): void => {
    const t = nowMs()
    loader.add(row)
    addMs += nowMs() - t
  }
  if (typeof rows === 'string') {
    forEachLineSync(rows, (line) => {
      const t = nowMs()
      const row = JSON.parse(line) as KbRow
      decodeMs += nowMs() - t
      add(row)
    })
  } else {
    for (const row of rows) {
      add(row)
    }
  }
  return {
    decode_ms: round(decodeMs),
    transform_ms: round(loader.transformMs),
    ingest_ms: round(addMs - loader.transformMs),
  }
}

/** A warm quick_check of the published file, to split publish into verify and durable. */
function quickCheckMs(snapshot: string): number {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  try {
    const t = nowMs()
    db.prepare('PRAGMA quick_check').all()
    return round(nowMs() - t)
  } finally {
    db.close()
  }
}

export function loadDirect(jsonl: string, dir: string): Record<string, unknown> {
  const t0 = nowMs()
  const store = new DirectStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
  }).init()
  const tInit = nowMs()
  let counts: GenericLoader['counts'] | undefined
  let phases: Record<string, number> = {}
  let callbackMs = 0
  let verifyMs = 0
  const version = store.write(
    (db) => {
      const t = nowMs()
      db.exec(BULK_PRAGMAS)
      const loader = new GenericLoader(db, true)
      phases = streamRows(jsonl, loader)
      counts = loader.counts
      const t2 = nowMs()
      const problems = countProblems(db)
      verifyMs = nowMs() - t2
      callbackMs = nowMs() - t
      if (problems.length > 0) {
        throw new Error(`load does not match stats.json: ${problems.slice(0, 5).join('; ')}`)
      }
    },
    { lockOpts: IMPORT_LOCK },
  )
  const tWrite = nowMs()
  const snapshot = store.snapshotPath(version)
  const publishMs = tWrite - tInit - callbackMs
  const qc = quickCheckMs(snapshot)
  return {
    arm: 'DirectStore',
    route: 'init() with the DDL, then one DirectStore.write streaming every row',
    version,
    counts,
    phases: {
      init_ddl_ms: round(tInit - t0),
      ...phases,
      verify_counts_ms: round(verifyMs),
      publish_ms: round(publishMs),
      publish_note:
        'COMMIT, quick_check, foreign_key_check, fsync, no-replace link, pointer swap, directory fsyncs',
      quick_check_warm_ms: qc,
      ingest_through_durable_ms: round(tWrite - t0 - (phases.decode_ms ?? 0)),
    },
    total_ms: round(tWrite - t0),
    validation: 'softschema validation not run (as in paraverse default load)',
    config: LOAD_CONFIG,
    snapshot,
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
  let decodeMs = 0
  const totals = { transform_ms: 0, ingest_ms: 0 }
  const counts: Record<string, number> = {}
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
      const p = streamRows(rows, loader)
      totals.transform_ms += p.transform_ms ?? 0
      totals.ingest_ms += p.ingest_ms ?? 0
      for (const [k, v] of Object.entries(loader.counts)) {
        counts[k] = (counts[k] ?? 0) + v
      }
    })
    captureMs += nowMs() - t
    captures++
  }
  forEachLineSync(jsonl, (line) => {
    const t = nowMs()
    pending.push(JSON.parse(line) as KbRow)
    decodeMs += nowMs() - t
    if (pending.length >= batch) {
      flush()
    }
  })
  flush()
  const tCaptured = nowMs()
  const result = store.reconcile({ lockOpts: IMPORT_LOCK })
  const tReconciled = nowMs()
  const problems = store.read((db) => countProblems(db))
  const snapshot = store.snapshotPath(result.published)
  return {
    arm: 'SnapshotStore',
    route: `init(), ${captures} envelopes of ${batch} rows, one reconcile`,
    batch,
    captures,
    counts,
    reconcile: result,
    phases: {
      init_ddl_ms: round(tInit - t0),
      decode_ms: round(decodeMs),
      transform_ms: round(totals.transform_ms),
      ingest_ms: round(totals.ingest_ms),
      capture_overhead_ms: round(captureMs - totals.transform_ms - totals.ingest_ms),
      capture_note: 'per envelope: copy the head, session changeset, envelope files',
      reconcile_ms: round(tReconciled - tCaptured),
      reconcile_note: 'copy head, apply changesets, quick_check, fsync, publish',
      quick_check_warm_ms: quickCheckMs(snapshot),
      ingest_through_durable_ms: round(tReconciled - t0 - decodeMs),
    },
    total_ms: round(tReconciled - t0),
    count_problems: problems,
    validation: 'softschema validation not run',
    config: LOAD_CONFIG,
    snapshot,
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
