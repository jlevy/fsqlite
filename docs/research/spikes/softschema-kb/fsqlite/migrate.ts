// Side-by-side schema replacement: copy a published snapshot into a new fsqlite store
// that has a different caller schema, transforming rows on the way.
//
// fsqlite never migrates a caller schema in place, and a write callback may not run DDL
// or ATTACH (the callback already runs inside a transaction). So the copy initializes the
// destination with the new DDL, then one DirectStore.write streams every row from a
// separate read-only connection on the source snapshot. The destination is a new store
// with a new store_id; switching readers to it is the application's cutover.

import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { DirectStore } from './fsq.ts'
import { nowMs, round } from './common.ts'

/** Rewrites one row (column name to value) or drops it by returning null. */
export type RowTransform = (
  row: Record<string, SQLInputValue>,
) => Record<string, SQLInputValue> | null

export interface MigrateOptions {
  schema: string
  schemaVersion: number
  /** Per-table transforms, keyed by source table name. */
  transform?: Record<string, RowTransform>
  /** Map a source table to a different destination table. */
  rename?: Record<string, string>
}

const OWNED = new Set(['applied_tx', 'fsqlite_meta'])

export function migrateSnapshot(
  sourceSnapshot: string,
  destDir: string,
  opts: MigrateOptions,
): Record<string, unknown> {
  const t0 = nowMs()
  rmSync(destDir, { recursive: true, force: true })
  const dest = new DirectStore(destDir, { schema: opts.schema, schemaVersion: opts.schemaVersion })
  dest.init()
  const tInit = nowMs()
  const src = new DatabaseSync(sourceSnapshot, { readOnly: true })
  const copied: Record<string, number> = {}
  try {
    const tables = (
      src
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => !OWNED.has(n))
    dest.write(
      (db) => {
        db.exec('PRAGMA cache_size = -262144')
        for (const table of tables) {
          const target = opts.rename?.[table] ?? table
          const destCols = new Set(
            (db.prepare(`PRAGMA table_info("${target}")`).all() as { name: string }[]).map(
              (c) => c.name,
            ),
          )
          if (destCols.size === 0) {
            continue // dropped from the new schema
          }
          const transform = opts.transform?.[table]
          let insert: ReturnType<DatabaseSync['prepare']> | null = null
          let cols: string[] = []
          let n = 0
          for (const raw of src.prepare(`SELECT * FROM "${table}"`).iterate()) {
            const row = transform ? transform(raw as Record<string, SQLInputValue>) : raw
            if (row === null) {
              continue
            }
            if (!insert) {
              cols = Object.keys(row).filter((c) => destCols.has(c))
              insert = db.prepare(
                `INSERT INTO "${target}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
                  `VALUES (${cols.map(() => '?').join(', ')})`,
              )
            }
            const values = cols.map((c) => (row as Record<string, SQLInputValue>)[c] ?? null)
            insert.run(...values)
            n++
          }
          copied[target] = n
        }
      },
      { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } },
    )
  } finally {
    src.close()
  }
  const t1 = nowMs()
  return {
    dest: destDir,
    version: dest.currentVersion(),
    rows: copied,
    init_ms: round(tInit - t0),
    copy_ms: round(t1 - tInit),
    total_ms: round(t1 - t0),
    snapshot: dest.snapshotPath(dest.currentVersion()),
  }
}
