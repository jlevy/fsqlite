// W2 on round-2 batches (softschema-kb-delta/v2): each batch applied by one writer in
// ops.jsonl line order, through SnapshotStore (capture, reconcile) and DirectStore, on a
// fresh clone of the W1 store; the p05 state checked against the oracle; the trickle
// batches repeated; and the batch with one schema-invalid record.
//
// Usage: node w2v2.ts <base-store> --scale S1-r2 [--reps 3] [--work <dir>]
//
// The 4-writer runs with a concurrent reader are w2.ts (it reads v2 batches at -r2
// scales). Writes results/fsqlite/<scale>/w2-v2.json.

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore } from './fsq.ts'
import {
  CORPORA_DIR,
  RESULTS_DIR,
  SPIKE_DIR,
  WORK_DIR,
  cloneStore,
  forEachRowSync,
  isMain,
  kbDirFor,
  nowMs,
  parseArgs,
  percentile,
  round,
  writeResult,
} from './common.ts'
import { buildFtsSidecar } from './fts.ts'
import { GENERIC_SCHEMA_VERSION, GenericLoader, genericDdl } from './mapping.ts'
import type { DatabaseSync } from 'node:sqlite'
import { UV_PYTHON } from './w1.ts'
import { checkAgainstExpected } from './w2.ts'
import { genericStore } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
const LOCK = { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } }
const BATCHES = ['p01', 'p05', 'p20', 't0001', 't0010', 't0100', 't0010-invalid']

function parseBatch(batchDir: string, baseKb: string, out: string, validate = true) {
  const args = [join(HERE, 'parse_kb.py'), batchDir, out, '--delta2', baseKb]
  if (!validate) {
    args.push('--no-validate')
  }
  const t = nowMs()
  const r = spawnSync(UV_PYTHON[0]!, [...UV_PYTHON.slice(1), ...args], { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`parse of ${batchDir} failed: ${r.stderr.slice(-500)}`)
  }
  const report = JSON.parse(
    r.stderr
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .pop() ?? '{}',
  )
  return { wall_ms: round(nowMs() - t), ...(report as Record<string, unknown>) }
}

function applyAll(rows: string) {
  return (db: DatabaseSync): void => {
    const loader = new GenericLoader(db)
    forEachRowSync(rows, (row) => loader.add(row))
  }
}

/** One batch through one arm on a fresh clone; returns timings and the clone's head. */
function applyOnce(base: string, rows: string, dir: string, arm: 'SnapshotStore' | 'DirectStore') {
  cloneStore(base, dir)
  const snap = genericStore(dir).init()
  const t0 = nowMs()
  const out: Record<string, number | string | null> = { arm }
  if (arm === 'SnapshotStore') {
    const tx = snap.write('v2', applyAll(rows))
    out.capture_ms = round(nowMs() - t0)
    out.envelope_bytes = tx
      ? statSync(join(dir, 'tx', 'pending', `${tx}.txn`, 'changeset.bin')).size
      : 0
    const t1 = nowMs()
    const r = snap.reconcile(LOCK)
    out.reconcile_ms = round(nowMs() - t1)
    out.quarantined_envelopes = r.quarantined
  } else {
    new DirectStore(dir, { schema: genericDdl(), schemaVersion: GENERIC_SCHEMA_VERSION }).write(
      applyAll(rows),
      LOCK,
    )
  }
  out.visible_ms = round(nowMs() - t0)
  const head = snap.snapshotPath(snap.currentVersion())
  out.fts_rebuild_ms = buildFtsSidecar(head, join(dir, 'search-fts.sqlite')).build_ms ?? null
  const tGc = nowMs()
  snap.gc({ retain: 0 })
  out.gc_retain0_ms = round(nowMs() - tGc)
  return { out, head, snap }
}

function median(values: number[]): number {
  return round(
    percentile(
      [...values].sort((a, b) => a - b),
      50,
    ),
  )
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [base] = args
  const scale = flags.scale ?? 'S1-r2'
  if (!base) {
    throw new Error('usage: w2v2.ts <base-store> --scale S1-r2')
  }
  const reps = Number(flags.reps ?? 3)
  const baseKb = kbDirFor(scale)
  const deltas = join(CORPORA_DIR, scale, 'deltas')
  const work = join(flags.work ?? WORK_DIR, scale, 'w2v2')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const results: Record<string, unknown> = {}
  for (const name of BATCHES) {
    const batchDir = join(deltas, name)
    const rows = join(work, `${name}.jsonl`)
    const parse = parseBatch(batchDir, baseKb, rows)
    const trickle = name.startsWith('t')
    const arms: Record<string, unknown> = {}
    for (const arm of ['SnapshotStore', 'DirectStore'] as const) {
      const runs: Record<string, number | string | null>[] = []
      for (let r = 0; r < (trickle ? reps : 1); r++) {
        const dir = join(work, `${name}-${arm}`)
        const { out, head, snap } = applyOnce(base, rows, dir, arm)
        if (r === 0 && arm === 'SnapshotStore') {
          const counts = snap.read((db) => ({
            entities: (db.prepare('SELECT count(*) AS n FROM entity').get() as { n: number }).n,
            edges: (db.prepare('SELECT count(*) AS n FROM edge').get() as { n: number }).n,
            quarantine: db.prepare('SELECT path, id, reason, op FROM quarantine').all(),
          }))
          out.state = JSON.stringify(counts)
          if (name === 'p05') {
            const check = checkAgainstExpected(
              head,
              scale,
              join(SPIKE_DIR, 'harness', 'expected', `${scale}-p05`, 'w3.json'),
              join(RESULTS_DIR, scale, 'w3-after-p05.json'),
            )
            out.w3_check_against_reference = JSON.stringify(check)
          }
        }
        runs.push(out)
        rmSync(dir, { recursive: true, force: true })
      }
      const stat = (k: string): number | null =>
        runs.every((x) => typeof x[k] === 'number') ? median(runs.map((x) => Number(x[k]))) : null
      arms[arm] = {
        reps: runs.length,
        capture_ms: stat('capture_ms'),
        reconcile_ms: stat('reconcile_ms'),
        visible_ms: stat('visible_ms'),
        fts_rebuild_ms: stat('fts_rebuild_ms'),
        gc_retain0_ms: stat('gc_retain0_ms'),
        runs,
      }
    }
    const entry: Record<string, unknown> = { parse, arms }
    if (name === 't0010-invalid') {
      // Without the check, nothing in fsqlite or SQLite refuses the record.
      const loose = join(work, 'invalid-unvalidated.jsonl')
      parseBatch(batchDir, baseKb, loose, false)
      const dir = join(work, 'invalid-unvalidated')
      const { snap } = applyOnce(base, loose, dir, 'SnapshotStore')
      const invalidId = (parse as { quarantined?: { id: string }[] }).quarantined?.[0]?.id ?? ''
      entry.without_validation = snap.read((db) => ({
        invalid_record_loaded:
          db.prepare('SELECT 1 FROM entity WHERE id = ?').get(invalidId) !== undefined,
        quarantine_rows: (db.prepare('SELECT count(*) AS n FROM quarantine').get() as { n: number })
          .n,
      }))
      rmSync(dir, { recursive: true, force: true })
    }
    results[name] = entry
    rmSync(rows, { force: true })
    console.error(JSON.stringify({ batch: name, done: true }))
  }
  rmSync(work, { recursive: true, force: true })
  console.log(
    writeResult(scale, 'w2-v2', {
      workflow: 'W2 v2 batches, one writer in line order (both arms)',
      base_store: base,
      deltas,
      gc: 'gc({ retain: 0 }) after each publish',
      results,
    }),
  )
}

if (isMain(import.meta.url)) {
  main()
}
