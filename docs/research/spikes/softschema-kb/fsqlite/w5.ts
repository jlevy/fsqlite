// W5 export round trip: export the published snapshot back to the KB layout with Python's
// standard sqlite3 module, compare it with the source KB, then reload the export into a
// new store and check that every W3 query returns the same result.
//
// Usage: node w5.ts --scale S0 [--work <dir>]

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RESULTS_DIR, SPIKE_DIR, WORK_DIR, isMain, kbDirFor, parseArgs, writeResult } from './common.ts'
import { NODE, UV_PYTHON, measured } from './w1.ts'
import { KbQueries } from './queries.ts'
import { genericStore, openReader, queryInstances } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const work = join(flags.work ?? WORK_DIR, scale)
  const store = join(work, 'store-direct')
  const out = join(work, 'w5-export')
  const exported = measured('export', [
    ...UV_PYTHON,
    join(HERE, 'export_kb.py'),
    store,
    out,
    '--compare',
    kbDirFor(scale),
  ])

  // Reload the export through the same W1 path and rerun W3 on it.
  const rows = join(work, 'w5-rows.jsonl')
  const reloadStore = join(work, 'w5-reload')
  const parse = measured('parse-export', [...UV_PYTHON, join(HERE, 'parse_kb.py'), out, rows])
  const load = measured('load-export', [...NODE, join(HERE, 'load.ts'), rows, reloadStore])
  const reference = JSON.parse(readFileSync(join(RESULTS_DIR, scale, 'w3.json'), 'utf8')) as {
    queries: { name: string; result: unknown }[]
  }
  const expected = new Map(reference.queries.map((q) => [q.name, JSON.stringify(q.result)]))
  const handle = genericStore(reloadStore).init()
  const lease = handle.readLease()
  const db = openReader(handle.snapshotPath(lease.version))
  const queries = new KbQueries(db)
  const mismatches: string[] = []
  let checked = 0
  for (const q of queryInstances(scale)) {
    const result = JSON.stringify(queries.run(q.category, q.params))
    checked++
    // Paths compare on hops: several shortest paths can exist.
    const same =
      q.category === 'path'
        ? JSON.parse(result).hops === JSON.parse(expected.get(q.name) ?? '{}').hops
        : result === expected.get(q.name)
    if (!same) {
      mismatches.push(q.name)
    }
  }
  db.close()
  lease.release()
  rmSync(reloadStore, { recursive: true, force: true })
  rmSync(rows, { force: true })
  rmSync(out, { recursive: true, force: true })
  console.log(
    writeResult(scale, 'w5', {
      workflow: 'W5',
      export: exported,
      reload: {
        parse_seconds: parse.seconds,
        load_seconds: load.seconds,
        w3_queries_checked: checked,
        w3_mismatches: mismatches,
      },
    }),
  )
}

if (isMain(import.meta.url)) {
  main()
}
