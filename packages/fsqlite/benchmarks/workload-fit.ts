import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import type { StoreOptions } from '../src/types.ts'
import {
  BENCHMARK_SCHEMA_VERSION,
  MEASURED_CAPTURES,
  MEDIAN_PERCENTILE,
  P95_PERCENTILE,
  ROW_BYTES,
  WARMUP_CAPTURES,
  benchmarkEnvironment,
  elapsedMs,
  percentile,
} from './common.ts'

const WRITES_PER_AGENT = 5
const ROWS_PER_WRITE = 2
const TABLE_COUNTS = [1, 10, 50, 100, 250] as const
const AGENT_SCENARIOS = [
  { seedRows: 500, agentCounts: [1, 4, 8, 16] },
  { seedRows: 5500, agentCounts: [1, 4, 8] },
] as const
const blob = 'x'.repeat(ROW_BYTES)

const agentOptions: StoreOptions = {
  schema: 'CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);',
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  conflictPolicy: { '*': 'strict' },
}

function snapshotBytes(store: SnapshotStore): number {
  return statSync(store.snapshotPath(store.currentVersion())).size
}

function tableSchema(tableCount: number): string {
  return Array.from(
    { length: tableCount },
    (_, index) => `CREATE TABLE t${index} (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`,
  ).join('\n')
}

function measureTableCount(root: string, tableCount: number): Record<string, number> {
  const options: StoreOptions = {
    schema: tableSchema(tableCount),
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    conflictPolicy: { '*': 'strict' },
  }
  const store = new SnapshotStore(join(root, `tables-${tableCount}`), options).init()
  let sequence = 0
  const capture = (): number => {
    const started = process.hrtime.bigint()
    store.write('table-benchmark', (db) =>
      db.prepare('INSERT INTO t0 VALUES (?, ?)').run(`row-${sequence++}`, blob),
    )
    return elapsedMs(started)
  }
  for (let index = 0; index < WARMUP_CAPTURES; index++) {
    capture()
  }
  const samples: number[] = []
  for (let index = 0; index < MEASURED_CAPTURES; index++) {
    samples.push(capture())
  }
  return {
    tables: tableCount,
    snapshotBytes: snapshotBytes(store),
    medianCaptureMs: percentile(samples, MEDIAN_PERCENTILE),
    p95CaptureMs: percentile(samples, P95_PERCENTILE),
  }
}

function seedAgentHead(dir: string, rows: number): SnapshotStore {
  const store = new SnapshotStore(dir, agentOptions).init()
  new DirectStore(dir, agentOptions).write((db) => {
    const insert = db.prepare('INSERT INTO artifacts VALUES (?, ?)')
    for (let index = 0; index < rows; index++) {
      insert.run(`seed-${index}`, blob)
    }
  })
  return store
}

function runAgent(dir: string, agentIndex: number): void {
  const store = new SnapshotStore(dir, agentOptions)
  for (let writeIndex = 0; writeIndex < WRITES_PER_AGENT; writeIndex++) {
    store.write(`agent-${agentIndex}`, (db) => {
      const insert = db.prepare('INSERT INTO artifacts VALUES (?, ?)')
      for (let rowIndex = 0; rowIndex < ROWS_PER_WRITE; rowIndex++) {
        insert.run(`agent-${agentIndex}-${writeIndex}-${rowIndex}`, blob)
      }
    })
  }
}

function spawnAgent(dir: string, agentIndex: number): Promise<void> {
  const script = fileURLToPath(import.meta.url)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--agent', dir, String(agentIndex)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`agent ${agentIndex} exited with code ${String(code)}, signal ${signal}`))
    })
  })
}

async function measureAgents(
  root: string,
  rows: number,
  agents: number,
): Promise<Record<string, number>> {
  const dir = join(root, `agents-${rows}-${agents}`)
  const store = seedAgentHead(dir, rows)
  const bytes = snapshotBytes(store)
  const captureStarted = process.hrtime.bigint()
  await Promise.all(Array.from({ length: agents }, (_, index) => spawnAgent(dir, index)))
  const captureWallMs = elapsedMs(captureStarted)
  const pending = store.pendingTxns().length
  const reconcileStarted = process.hrtime.bigint()
  const result = store.reconcile()
  const reconcileMs = elapsedMs(reconcileStarted)
  return {
    seedRows: rows,
    snapshotBytes: bytes,
    agents,
    writes: agents * WRITES_PER_AGENT,
    pending,
    applied: result.applied,
    captureWallMs,
    reconcileMs,
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'fsqlite-workload-fit-'))
  try {
    const tableCounts = TABLE_COUNTS.map((count) => measureTableCount(root, count))
    const agentRuns: Record<string, number>[] = []
    for (const { seedRows, agentCounts } of AGENT_SCENARIOS) {
      for (const agents of agentCounts) {
        agentRuns.push(await measureAgents(root, seedRows, agents))
      }
    }
    console.log(
      JSON.stringify(
        {
          environment: benchmarkEnvironment(),
          tableCountMethod: {
            rowBytes: ROW_BYTES,
            warmups: WARMUP_CAPTURES,
            captures: MEASURED_CAPTURES,
            reconciliation: false,
          },
          agentMethod: {
            rowBytes: ROW_BYTES,
            rowsPerWrite: ROWS_PER_WRITE,
            writesPerAgent: WRITES_PER_AGENT,
          },
          tableCounts,
          agentRuns,
        },
        null,
        2,
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--agent') {
  const dir = process.argv[3]
  const agentIndex = Number(process.argv[4])
  if (dir === undefined || !Number.isSafeInteger(agentIndex) || agentIndex < 0) {
    throw new Error('usage: workload-fit.ts --agent <store-dir> <non-negative-agent-index>')
  }
  runAgent(dir, agentIndex)
} else {
  await main()
}
