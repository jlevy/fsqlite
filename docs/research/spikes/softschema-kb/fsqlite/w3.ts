// W3: run every harness/queries.json query against a published snapshot, once cold and
// then 50 times warm, and write results/fsqlite/<scale>/w3.json in the harness's form.
//
// Usage: node w3.ts <store-dir> --scale S0 [--fts <sidecar.sqlite>] [--path-cte]
//        [--warm 50] [--out <file>]
//
// The reader pins the head with readLease() and opens that snapshot read-only, the way a
// UI server would hold one connection per published version. "Cold" means a new
// connection with an empty SQLite page cache, after the snapshot (and sidecar) pages were
// dropped from the OS page cache with posix_fadvise.

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
import { KbQueries } from './queries.ts'
import type { Params, QueryOptions } from './queries.ts'

export const READER_PRAGMAS = 'PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;'

export interface QueryInstance {
  name: string
  category: string
  params: Params
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

export function runW3(
  dir: string,
  scale: string,
  opts: QueryOptions & { ftsPath?: string; warm?: number },
): Record<string, unknown> {
  const store = genericStore(dir).init()
  const lease = store.readLease()
  const snapshot = store.snapshotPath(lease.version)
  const warmRuns = opts.warm ?? 50
  const results = []
  let evicted = true
  try {
    for (const q of queryInstances(scale)) {
      evicted = evictFromPageCache(snapshot) && evicted
      if (opts.ftsPath) {
        evictFromPageCache(opts.ftsPath)
      }
      const t0 = nowMs()
      const db = openReader(snapshot, opts.ftsPath)
      const queries = new KbQueries(db, opts)
      const tOpen = nowMs()
      const result = queries.run(q.category, q.params)
      const coldMs = nowMs() - t0
      const warm: number[] = []
      for (let i = 0; i < warmRuns; i++) {
        const t = nowMs()
        const again = queries.run(q.category, q.params)
        warm.push(round(nowMs() - t, 4))
        if (i === 0 && JSON.stringify(again) !== JSON.stringify(result)) {
          throw new Error(`${q.name}: warm result differs from cold`)
        }
      }
      db.close()
      const sorted = [...warm].sort((x, y) => x - y)
      results.push({
        name: q.name,
        category: q.category,
        params: q.params,
        result,
        timings: {
          cold_ms: round(coldMs, 4),
          cold_open_ms: round(tOpen - t0, 4),
          warm_ms: warm,
          p50_ms: round(percentile(sorted, 50), 4),
          p95_ms: round(percentile(sorted, 95), 4),
        },
      })
    }
  } finally {
    lease.release()
  }
  return {
    workflow: 'W3',
    software: { fsqlite_api: 'packages/fsqlite/src/index.ts', mapping: 'generic' },
    options: {
      search: opts.ftsPath ? 'fts5-trigram-sidecar' : 'search_text-scan',
      path: opts.pathCte ? 'recursive-cte' : 'bidirectional-bfs',
      warm_runs: warmRuns,
      reader_pragmas: READER_PRAGMAS,
      cold: evicted ? 'new connection, snapshot evicted with posix_fadvise' : 'new connection',
    },
    store: dir,
    snapshot,
    version: lease.version,
    queries: results,
  }
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [dir] = args
  const scale = flags.scale ?? 'S0'
  if (!dir) {
    throw new Error('usage: w3.ts <store-dir> --scale S0 [--fts sidecar] [--path-cte]')
  }
  const opts: QueryOptions & { ftsPath?: string; warm?: number } = {
    warm: Number(flags.warm ?? 50),
    pathCte: flags['path-cte'] === 'true',
  }
  if (flags.fts) {
    opts.fts = true
    opts.ftsPath = flags.fts
  }
  const report = runW3(dir, scale, opts)
  if (flags.out) {
    writeFileSync(flags.out, `${JSON.stringify({ scale, ...report }, null, 2)}\n`)
    console.log(flags.out)
  } else {
    console.log(writeResult(scale, 'w3', report))
  }
}

if (isMain(import.meta.url)) {
  main()
}
