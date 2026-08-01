import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from '../src/index.ts'
import type { StoreOptions } from '../src/types.ts'

const options: StoreOptions = {
  schema:
    'CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, title TEXT, updated_at TEXT NOT NULL);',
  schemaVersion: 1,
  conflictPolicy: { artifacts: 'lww', '*': 'strict' },
}

const dir = mkdtempSync(join(tmpdir(), 'fsqlite-seed-benchmark-'))
try {
  const store = new SnapshotStore(dir, options).init()
  const direct = new DirectStore(dir, options)
  const blob = 'x'.repeat(2048)
  let sequence = 0
  const grow = (rows: number): void => {
    direct.write((db) => {
      const insert = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
      for (let index = 0; index < rows; index++) {
        insert.run(`grow-${sequence++}`, blob, 't')
      }
    })
  }
  const measure = (iterations: number, seed: 'snapshot' | 'schema-only'): number => {
    const started = process.hrtime.bigint()
    for (let index = 0; index < iterations; index++) {
      store.write(
        'benchmark',
        (db) =>
          db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(`write-${sequence++}`, blob, 't'),
        { seed },
      )
    }
    return Number(process.hrtime.bigint() - started) / 1e6 / iterations
  }

  grow(500)
  const snapshotSmall = measure(20, 'snapshot')
  grow(5000)
  const snapshotLarge = measure(20, 'snapshot')
  const schemaOnlyLarge = measure(20, 'schema-only')
  console.log(
    JSON.stringify(
      { millisecondsPerWrite: { snapshotSmall, snapshotLarge, schemaOnlyLarge } },
      null,
      2,
    ),
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
