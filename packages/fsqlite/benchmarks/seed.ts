import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import type { StoreOptions } from '../src/types.ts'

const BENCHMARK_SCHEMA_VERSION = 1
const ROW_BYTES = 2048
const SMALL_HEAD_ROWS = 500
const LARGE_HEAD_ADDITIONAL_ROWS = 5000
const WARMUP_CAPTURES = 5
const MEASURED_CAPTURES = 30
const MEDIAN_PERCENTILE = 0.5
const P95_PERCENTILE = 0.95

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
    return Number(process.hrtime.bigint() - started) / 1e6
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
  const percentile = (samples: number[], fraction: number): number => {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0
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
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? 'unknown',
        },
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
