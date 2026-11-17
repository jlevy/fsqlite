// W3: run every harness/queries.json query against a published snapshot, once cold and
// then 50 times warm, and write results/fsqlite/<scale>/w3.json in the harness's form.
//
// Usage: node w3.ts <store-dir> --scale S0 [--fts <sidecar.sqlite>] [--path-cte]
//        [--only <category>] [--timeout-ms N] [--warm 50] [--name w3] [--out <file>]
//
// The reader pins the head with readLease() and opens that snapshot read-only, the way a
// UI server would hold one connection per published version. "Cold" means a new
// connection with an empty SQLite page cache, after the snapshot (and sidecar) pages were
// dropped from the OS page cache with posix_fadvise. Every result stores the
// EXPLAIN QUERY PLAN of each statement the query ran. With --timeout-ms each query runs
// in its own child process, and one that overruns is recorded as a timeout.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from './fsq.ts'
import {
  SPIKE_DIR,
  evictFromPageCache,
  isMain,
  nowMs,
  parseArgs,
  percentile,
  readOnlyUri,
  round,
  writeResult,
} from './common.ts'
import { GENERIC_POLICY, GENERIC_SCHEMA_VERSION, genericDdl } from './mapping.ts'
import { buildFtsSidecar } from './fts.ts'
import { KbQueries } from './queries.ts'
import type { Params, QueryOptions } from './queries.ts'

export const READER_PRAGMAS = 'PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;'

export interface QueryInstance {
  name: string
  category: string
  params: Params
}

export interface W3Options extends QueryOptions {
  ftsPath?: string
  warm?: number
  only?: string
  timeoutMs?: number
}

export function queryInstances(scale: string): QueryInstance[] {
  const catalog = JSON.parse(readFileSync(join(SPIKE_DIR, 'harness', 'queries.json'), 'utf8')) as {
    queries: { name: string; category: string; params: Record<string, Params> }[]
  }
  return catalog.queries.flatMap((q) => {
    const params = q.params[scale]
    return params ? [{ name: q.name, category: q.category, params }] : []
  })
}

export function genericStore(dir: string): SnapshotStore {
  return new SnapshotStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
    conflictPolicy: GENERIC_POLICY,
  })
}

/** A serving connection on one snapshot, optionally with the FTS sidecar attached. */
export function openReader(snapshot: string, fts?: string): DatabaseSync {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  db.exec(READER_PRAGMAS)
  if (fts) {
    db.exec(`ATTACH '${readOnlyUri(fts)}' AS fts`)
  }
  return db
}

/** The SQLite settings a result depends on, read from the file and the reader. */
export function sqliteConfig(snapshot: string): Record<string, unknown> {
  const db = openReader(snapshot)
  try {
    const one = (pragma: string): unknown => Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0]
    return {
      page_size: one('page_size'),
      page_count: one('page_count'),
      journal_mode: one('journal_mode'),
      reader_cache_size: one('cache_size'),
      reader_mmap_size: one('mmap_size'),
      sqlite_version: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      node: process.version,
    }
  } finally {
    db.close()
  }
}

/** One query instance: cold run on a fresh connection, warm runs, and its plans. */
export function measureQuery(
  snapshot: string,
  q: QueryInstance,
  opts: W3Options,
): Record<string, unknown> {
  const warmRuns = opts.warm ?? 50
  const evicted = evictFromPageCache(snapshot)
  if (opts.ftsPath) {
    evictFromPageCache(opts.ftsPath)
  }
  const t0 = nowMs()
  const db = openReader(snapshot, opts.ftsPath)
  const queries = new KbQueries(db, opts)
  const tOpen = nowMs()
  queries.trace = new Set()
  const result = queries.run(q.category, q.params)
  const coldMs = nowMs() - t0
  const traced = queries.trace
  queries.trace = null
  const warm: number[] = []
  for (let i = 0; i < warmRuns; i++) {
    const t = nowMs()
    const again = queries.run(q.category, q.params)
    warm.push(round(nowMs() - t, 4))
    if (i === 0 && JSON.stringify(again) !== JSON.stringify(result)) {
      throw new Error(`${q.name}: warm result differs from cold`)
    }
  }
  const plans = queries.plans(traced)
  db.close()
  const sorted = [...warm].sort((x, y) => x - y)
  return {
    name: q.name,
    category: q.category,
    params: q.params,
    result,
    timings: {
      cold_ms: round(coldMs, 4),
      cold_open_ms: round(tOpen - t0, 4),
      cold_evicted: evicted,
      warm_ms: warm,
      p50_ms: round(percentile(sorted, 50), 4),
      p95_ms: round(percentile(sorted, 95), 4),
    },
    plans,
  }
}

/** Run a query in a child process, so one that overruns can be stopped and recorded. */
function measureInChild(snapshot: string, scale: string, q: QueryInstance, opts: W3Options) {
  const args = [
    '--disable-warning=ExperimentalWarning',
    join(SPIKE_DIR, 'fsqlite', 'w3.ts'),
    '--child',
    snapshot,
    '--scale',
    scale,
    '--query',
    q.name,
    '--warm',
    String(opts.warm ?? 50),
  ]
  if (opts.pathCte) {
    args.push('--path-cte')
  }
  if (opts.ftsPath) {
    args.push('--fts-attach', opts.ftsPath)
  }
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 28,
  })
  if (r.error || r.status !== 0) {
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    return {
      name: q.name,
      category: q.category,
      params: q.params,
      result: null,
      timings: { timed_out: timedOut, timeout_ms: opts.timeoutMs, error: timedOut ? null : r.stderr.slice(-500) },
    }
  }
  return JSON.parse(r.stdout) as Record<string, unknown>
}

/** Every query instance against one snapshot, the shape harness/compare.py reads. */
export function runOnSnapshot(snapshot: string, scale: string, opts: W3Options) {
  const results = []
  for (const q of queryInstances(scale)) {
    if (opts.only && q.category !== opts.only) {
      continue
    }
    results.push(
      opts.timeoutMs ? measureInChild(snapshot, scale, q, opts) : measureQuery(snapshot, q, opts),
    )
  }
  return {
    options: {
      search: opts.ftsPath ? 'fts5-trigram-sidecar (MATCH phrase)' : 'search_text substring scan',
      path: opts.pathCte ? 'recursive CTE (in-engine)' : 'bidirectional BFS (application-side, shared)',
      warm_runs: opts.warm ?? 50,
      timeout_ms: opts.timeoutMs ?? null,
      reader_pragmas: READER_PRAGMAS,
      cold: 'new connection, snapshot evicted from the OS page cache with posix_fadvise',
    },
    config: sqliteConfig(snapshot),
    snapshot,
    queries: results,
  }
}

export function runW3(dir: string, scale: string, opts: W3Options): Record<string, unknown> {
  const store = genericStore(dir).init()
  const lease = store.readLease()
  try {
    return {
      workflow: 'W3',
      arm: 'fsqlite (published snapshot, held read connection)',
      software: { fsqlite_api: 'packages/fsqlite/src/index.ts', mapping: 'generic (a)' },
      store: dir,
      version: lease.version,
      ...runOnSnapshot(store.snapshotPath(lease.version), scale, opts),
    }
  } finally {
    lease.release()
  }
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const opts: W3Options = {
    warm: Number(flags.warm ?? 50),
    pathCte: flags['path-cte'] === 'true',
  }
  if (flags.only) {
    opts.only = flags.only
  }
  if (flags['timeout-ms']) {
    opts.timeoutMs = Number(flags['timeout-ms'])
  }
  if (flags.child) {
    // One query in a child process: print its measured entry.
    if (flags['fts-attach']) {
      opts.fts = true
      opts.ftsPath = flags['fts-attach']
    }
    const q = queryInstances(scale).find((i) => i.name === flags.query)
    if (!q) {
      throw new Error(`unknown query ${String(flags.query)}`)
    }
    process.stdout.write(JSON.stringify(measureQuery(flags.child, q, opts)))
    return
  }
  const [dir] = args
  if (!dir) {
    throw new Error('usage: w3.ts <store-dir> --scale S0 [--fts sidecar] [--path-cte]')
  }
  let ftsBuild: Record<string, number> | undefined
  if (flags.fts) {
    opts.fts = true
    opts.ftsPath = flags.fts
    // The sidecar is rebuilt from the published head, as a publisher would after reconcile.
    const store = genericStore(dir).init()
    ftsBuild = buildFtsSidecar(store.snapshotPath(store.currentVersion()), flags.fts)
  }
  const report = { ...runW3(dir, scale, opts), ...(ftsBuild ? { fts_sidecar: ftsBuild } : {}) }
  if (flags.out) {
    writeFileSync(flags.out, `${JSON.stringify({ scale, ...report }, null, 2)}\n`)
    console.log(flags.out)
  } else {
    console.log(writeResult(scale, flags.name ?? 'w3', report))
  }
}

if (isMain(import.meta.url)) {
  main()
}
