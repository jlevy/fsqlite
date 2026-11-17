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
import { DirectStore } from './fsq.ts'
import type { ReadLease } from './fsq.ts'
import { forEachRowSync, maxRssMiB, nowMs, round } from './common.ts'
import type { KbRow, NodeRow } from './common.ts'
import { GENERIC_SCHEMA_VERSION, GenericLoader, genericDdl } from './mapping.ts'
import { KbQueries } from './queries.ts'
import { genericStore, openReader, queryInstances } from './w3.ts'

function writer(
  dir: string,
  rowsPath: string,
  writerId: string,
  envelopes: number,
  strategy: string,
) {
  const nodes: NodeRow[] = []
  const units: KbRow[][] = []
  forEachRowSync(rowsPath, (row) => {
    if (row.t === 'node') {
      nodes.push(row)
    } else if (row.t === 'doc' || units.length === 0) {
      units.push([row])
    } else {
      units[units.length - 1]?.push(row)
    }
  })
  const perEnvelope = Math.max(1, Math.ceil(units.length / envelopes))
  const snapshot = genericStore(dir)
  const direct = new DirectStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
  })
  const captures: { ms: number; units: number; version?: number; tx?: string | null }[] = []
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
      captures.push({ ms: round(nowMs() - t), units: batch.length, version })
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

const [role, ...rest] = process.argv.slice(2)
if (role === 'writer') {
  const [dir, rows, id, envelopes, strategy] = rest
  writer(dir!, rows!, id!, Number(envelopes), strategy ?? 'snapshot')
} else if (role === 'reader') {
  const [dir, scale, out, stop] = rest
  reader(dir!, scale!, out!, stop!)
} else {
  throw new Error('usage: w2_worker.ts writer|reader ...')
}
