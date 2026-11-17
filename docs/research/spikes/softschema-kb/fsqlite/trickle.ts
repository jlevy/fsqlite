// C18 trickle writes: batches of 1, 10 and 100 records through each fsqlite arm, and a
// sustained run of one-record envelopes with a concurrent reconciler, where the
// copy-per-generation floor dominates.
//
// Usage: node trickle.ts <base-store> --scale S0 --delta <delta-dir> [--seconds 20]
//        [--reps 3] [--work <dir>]
//
// Records come from a W2 delta batch (new and updated records with their edges). Every
// publish is followed by gc({ retain: 0 }), the minimum the run needs, since readers hold
// read leases on any version they still use. Writes results/fsqlite/<scale>/w2-trickle.json.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DirectStore } from './fsq.ts'
import {
  SPIKE_DIR,
  WORK_DIR,
  cloneStore,
  isMain,
  nowMs,
  parseArgs,
  percentile,
  round,
  writeResult,
} from './common.ts'
import type { KbRow, NodeRow } from './common.ts'
import { buildFtsSidecar } from './fts.ts'
import { GENERIC_SCHEMA_VERSION, GenericLoader, genericDdl } from './mapping.ts'
import { NODE, UV_PYTHON } from './w1.ts'
import { readUnits } from './w2_worker.ts'
import { genericStore } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
const LOCK = { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } }

function median(values: number[]): number {
  return round(
    percentile(
      [...values].sort((a, b) => a - b),
      50,
    ),
  )
}

function applyUnits(nodes: NodeRow[], units: KbRow[][]) {
  return (db: DatabaseSync): void => {
    const loader = new GenericLoader(db)
    for (const node of nodes) {
      loader.add(node)
    }
    for (const row of units.flat()) {
      loader.add(row)
    }
  }
}

function batches(base: string, rows: string, work: string, reps: number, sidecar: string) {
  const { nodes, units } = readUnits(rows)
  const dir = join(work, 'store')
  cloneStore(base, dir)
  const snap = genericStore(dir).init()
  const direct = new DirectStore(dir, {
    schema: genericDdl(),
    schemaVersion: GENERIC_SCHEMA_VERSION,
  })
  let next = 0
  const take = (n: number): KbRow[][] => {
    const out = units.slice(next, next + n)
    next += n
    return out
  }
  const out: Record<string, unknown> = {}
  for (const size of [1, 10, 100]) {
    for (const arm of ['SnapshotStore', 'DirectStore'] as const) {
      const runs: Record<string, number>[] = []
      for (let r = 0; r < reps; r++) {
        const batch = take(size)
        if (batch.length < size) {
          break
        }
        const t0 = nowMs()
        let captureMs = 0
        let reconcileMs = 0
        if (arm === 'SnapshotStore') {
          snap.write('trickle', applyUnits(nodes, batch))
          captureMs = nowMs() - t0
          snap.reconcile(LOCK)
          reconcileMs = nowMs() - t0 - captureMs
        } else {
          direct.write(applyUnits(nodes, batch), LOCK)
        }
        const visible = nowMs() - t0
        const head = snap.snapshotPath(snap.currentVersion())
        const fts = buildFtsSidecar(head, sidecar)
        const tGc = nowMs()
        snap.gc({ retain: 0 })
        runs.push({
          capture_ms: round(captureMs),
          reconcile_ms: round(reconcileMs),
          visible_ms: round(visible),
          fts_rebuild_ms: fts.build_ms ?? 0,
          gc_ms: round(nowMs() - tGc),
        })
      }
      const stat = (k: string): number => median(runs.map((x) => x[k] ?? Number.NaN))
      out[`${arm}.${size}`] = {
        arm,
        records: size,
        reps: runs.length,
        capture_ms: arm === 'SnapshotStore' ? stat('capture_ms') : null,
        reconcile_ms: arm === 'SnapshotStore' ? stat('reconcile_ms') : null,
        visible_ms_median: stat('visible_ms'),
        records_per_s: round((size * 1000) / stat('visible_ms'), 2),
        fts_rebuild_ms_median: stat('fts_rebuild_ms'),
        gc_retain0_ms_median: stat('gc_ms'),
        runs,
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
  return out
}

async function sustained(base: string, rows: string, work: string, seconds: number) {
  const dir = join(work, 'sustained')
  cloneStore(base, dir)
  genericStore(dir).init()
  const stop = join(work, 'stop')
  rmSync(stop, { force: true })
  const collect = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(NODE[0]!, [...NODE.slice(1), join(HERE, 'w2_worker.ts'), ...args], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', reject)
      child.on('exit', () => resolve(out))
    })
  const reconciler = collect(['reconciler', dir, stop, '0'])
  const started = Date.now()
  const writerOut = await collect([
    'trickle-writer',
    dir,
    rows,
    'trickle',
    String(started + seconds * 1000),
  ])
  writeFileSync(stop, '')
  const recOut = await reconciler
  const w = JSON.parse(writerOut) as { captures: { tx: string; start: number; end: number }[] }
  const r = JSON.parse(recOut) as {
    rounds: { pending: string[]; published: number; reconcile_ms: number; gc_ms: number }[]
  }
  const publishedAt = new Map<string, number>()
  for (const round_ of r.rounds) {
    for (const tx of round_.pending) {
      publishedAt.set(tx, round_.published)
    }
  }
  const delays = w.captures
    .map((c) => (publishedAt.get(c.tx) ?? Number.NaN) - c.start)
    .filter((d) => !Number.isNaN(d))
    .sort((a, b) => a - b)
  const window = (w.captures.at(-1)?.end ?? started) - started
  rmSync(dir, { recursive: true, force: true })
  return {
    seconds,
    writers: 1,
    records_captured: w.captures.length,
    capture_records_per_s: round((w.captures.length * 1000) / window, 2),
    capture_ms_median: median(w.captures.map((c) => c.end - c.start)),
    reconciles: r.rounds.length,
    records_per_reconcile_median: median(r.rounds.map((x) => x.pending.length)),
    reconcile_ms_median: median(r.rounds.map((x) => x.reconcile_ms)),
    gc_retain0_ms_median: median(r.rounds.map((x) => x.gc_ms)),
    visibility_delay_ms: {
      p50: round(percentile(delays, 50)),
      p95: round(percentile(delays, 95)),
      max: round(delays.at(-1) ?? Number.NaN),
    },
    note: 'one writer process capturing one-record envelopes; one reconciler looping reconcile then gc',
  }
}

async function main(): Promise<void> {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [base] = args
  const scale = flags.scale ?? 'S0'
  if (!base || !flags.delta) {
    throw new Error('usage: trickle.ts <base-store> --scale S0 --delta <delta-dir>')
  }
  const work = join(flags.work ?? WORK_DIR, scale, 'trickle')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const rows = join(work, 'delta.jsonl')
  const parse = spawnSync(UV_PYTHON[0]!, [
    ...UV_PYTHON.slice(1),
    join(HERE, 'parse_kb.py'),
    flags.delta,
    rows,
    '--delta',
  ])
  if (parse.status !== 0) {
    throw new Error(`parse failed: ${parse.stderr.toString().slice(-500)}`)
  }
  const result = {
    workflow: 'W2 trickle (C18)',
    delta: flags.delta,
    gc: 'gc({ retain: 0 }) after every publish',
    batches: batches(base, rows, work, Number(flags.reps ?? 3), join(work, 'search-fts.sqlite')),
    sustained: await sustained(base, rows, work, Number(flags.seconds ?? 20)),
  }
  rmSync(work, { recursive: true, force: true })
  console.log(writeResult(scale, 'w2-trickle', result))
}

if (isMain(import.meta.url)) {
  await main()
}
