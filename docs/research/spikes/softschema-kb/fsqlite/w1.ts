// W1 full rebuild at one scale: the Python YAML pass, then the Node import into fsqlite,
// each as its own process so wall time and peak RSS are measured separately.
//
// Usage: node w1.ts --scale S0 [--routes direct,snapshot] [--batch 20000] [--work <dir>]
//
// Writes results/fsqlite/<scale>/w1.json. The `direct` store is kept at
// <work>/<scale>/store-direct for the later workflows.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  SPIKE_DIR,
  WORK_DIR,
  isMain,
  kbDirFor,
  nowMs,
  parseArgs,
  round,
  writeResult,
} from './common.ts'
import { buildFtsSidecar } from './fts.ts'
import { genericStore } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
export const UV_PYTHON = [
  'uv',
  'run',
  '-q',
  '--no-project',
  '--no-build',
  '--with',
  'pyyaml==6.0.3',
  '--exclude-newer',
  '2026-11-03',
  'python',
]
export const NODE = [process.execPath, '--disable-warning=ExperimentalWarning']

/** Run a command under measure.py; returns its measurement plus the command's stdout. */
export function measured(label: string, cmd: string[]): Record<string, unknown> {
  const proc = spawnSync('python3', [join(HERE, 'measure.py'), label, '--', ...cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 26,
  })
  const lines = proc.stdout.trim().split('\n')
  const measure = JSON.parse(lines.pop() ?? '{}') as Record<string, unknown>
  if (measure.exit !== 0) {
    throw new Error(`${label} failed: ${proc.stderr.slice(-2000)}`)
  }
  const out = lines.join('\n').trim()
  const stderrJson = proc.stderr
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop()
  return {
    ...measure,
    report: out
      ? (JSON.parse(out) as unknown)
      : stderrJson
        ? (JSON.parse(stderrJson) as unknown)
        : null,
  }
}

export function dirBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      total += statSync(join(entry.parentPath, entry.name)).size
    }
  }
  return total
}

/** Page-level breakdown of a snapshot by table and index, from the dbstat virtual table. */
export function sizeBreakdown(snapshot: string): Record<string, number> {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC')
      .all() as { name: string; bytes: number }[]
    return Object.fromEntries(rows.map((r) => [r.name, r.bytes]))
  } finally {
    db.close()
  }
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const routes = (flags.routes ?? 'direct,snapshot').split(',')
  const work = join(flags.work ?? WORK_DIR, scale)
  mkdirSync(work, { recursive: true })
  const kb = kbDirFor(scale)
  const rows = join(work, 'rows.jsonl')

  const validate = flags.validate === 'true' ? ['--validate'] : []
  const parse = measured('parse', [...UV_PYTHON, join(HERE, 'parse_kb.py'), kb, rows, ...validate])
  const result: Record<string, unknown> = {
    kb_bytes: dirBytes(kb),
    parse: {
      ...parse,
      parser: 'parse_kb.py: PyYAML CSafeLoader in a process pool, rows streamed in path order',
      validation:
        validate.length > 0
          ? 'stdlib schema check in the parse workers (report.validation)'
          : 'not run',
    },
    intermediate_bytes: statSync(rows).size,
  }
  for (const route of routes) {
    const store = join(work, `store-${route}`)
    const load = measured(`load-${route}`, [
      ...NODE,
      join(HERE, 'load.ts'),
      rows,
      store,
      '--route',
      route,
      '--batch',
      flags.batch ?? '20000',
    ])
    const report = load.report as Record<string, unknown>
    const snapshot = String(report.snapshot)
    const storeBytesBeforeGc = dirBytes(store)
    // Retain nothing older than the head: the import's empty snapshot 0, and for
    // SnapshotStore the archived envelopes stay (gc never prunes tx/applied).
    const handle = genericStore(store).init()
    const tGc = nowMs()
    const gc = handle.gc({ retain: 0 })
    const gcMs = nowMs() - tGc
    const entry: Record<string, unknown> = {
      ...load,
      arm: route === 'direct' ? 'DirectStore' : 'SnapshotStore',
      ingest_through_durable_seconds: round(
        Number(load.seconds) - Number((report.phases as Record<string, number>).decode_ms) / 1000,
      ),
      total_with_parse_seconds: round(Number(parse.seconds) + Number(load.seconds)),
      store_bytes_before_gc: storeBytesBeforeGc,
      gc: { retain: 0, ms: round(gcMs), ...gc },
      store_bytes: dirBytes(store),
      snapshot_bytes: statSync(snapshot).size,
      breakdown: route === 'direct' ? sizeBreakdown(snapshot) : undefined,
    }
    if (route === 'direct') {
      // The FTS5 search sidecar is part of making the store servable with indexed search.
      entry.fts_sidecar = buildFtsSidecar(snapshot, join(work, 'search-fts.sqlite'))
    }
    result[route] = entry
    if (route !== 'direct' && !flags.keep) {
      rmSync(store, { recursive: true, force: true })
    }
  }
  console.log(writeResult(scale, 'w1', result))
}

if (isMain(import.meta.url)) {
  main()
}
