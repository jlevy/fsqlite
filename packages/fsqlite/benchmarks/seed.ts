import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const SMALL_HEAD_ROWS = 500
const LARGE_HEAD_ADDITIONAL_ROWS = 5000

const options: StoreOptions = {
  schema:
    'CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, title TEXT, updated_at TEXT NOT NULL);',
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  conflictPolicy: { artifacts: 'lww', '*': 'strict' },
}

const dir = mkdtempSync(join(tmpdir(), 'fsqlite-seed-benchmark-'))
try {
  const store = new SnapshotStore(dir, options).init()
  const direct = new DirectStore(dir, options)
  const blob = 'x'.repeat(ROW_BYTES)
  let sequence = 0
  const grow = (rows: number): void => {
    direct.write((db) => {
      const insert = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
      for (let index = 0; index < rows; index++) {
        insert.run(`grow-${sequence++}`, blob, 't')
      }
    })
  }
  const capture = (): number => {
    const started = process.hrtime.bigint()
    store.write('benchmark', (db) =>
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`write-${sequence++}`, blob, 't'),
    )
    return elapsedMs(started)
  }
  const measure = (warmups: number, iterations: number): number[] => {
    for (let index = 0; index < warmups; index++) {
      capture()
    }
    const samples: number[] = []
    for (let index = 0; index < iterations; index++) {
      samples.push(capture())
    }
    return samples
  }
  const summarize = (samples: number[]): { medianMs: number; p95Ms: number } => ({
    medianMs: percentile(samples, MEDIAN_PERCENTILE),
    p95Ms: percentile(samples, P95_PERCENTILE),
  })

  grow(SMALL_HEAD_ROWS)
  const snapshotSmallBytes = statSync(store.snapshotPath(store.currentVersion())).size
  const snapshotSmall = summarize(measure(WARMUP_CAPTURES, MEASURED_CAPTURES))
  grow(LARGE_HEAD_ADDITIONAL_ROWS)
  const snapshotLargeBytes = statSync(store.snapshotPath(store.currentVersion())).size
  const snapshotLarge = summarize(measure(WARMUP_CAPTURES, MEASURED_CAPTURES))
  console.log(
    JSON.stringify(
      {
        environment: benchmarkEnvironment(),
        method: {
          rowBytes: blob.length,
          warmups: WARMUP_CAPTURES,
          captures: MEASURED_CAPTURES,
        },
        snapshots: [
          { rows: SMALL_HEAD_ROWS, bytes: snapshotSmallBytes, ...snapshotSmall },
          {
            rows: SMALL_HEAD_ROWS + LARGE_HEAD_ADDITIONAL_ROWS,
            bytes: snapshotLargeBytes,
            ...snapshotLarge,
          },
        ],
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
