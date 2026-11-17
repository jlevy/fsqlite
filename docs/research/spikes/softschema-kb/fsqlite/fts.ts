// FTS5 search sidecar: a rebuildable projection of `search_text` outside the store.
//
// fsqlite rejects virtual tables in a store schema (they have no primary key and sessions
// do not capture them), so a full-text index cannot live in a published snapshot. This
// builds an ordinary SQLite file holding an FTS5 trigram index for one published version;
// readers ATTACH it as `fts`. Rebuild it after each publication.
//
// Usage: node fts.ts <snapshot.sqlite> <sidecar.sqlite>

import { rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isMain, nowMs, readOnlyUri, round } from './common.ts'

export const FTS_DDL = `CREATE VIRTUAL TABLE search_fts USING fts5(
  text, id UNINDEXED, r UNINDEXED, tokenize = 'trigram'
)`

/** Build the sidecar for `snapshot` at `out`; returns timing and size. */
export function buildFtsSidecar(snapshot: string, out: string): Record<string, number> {
  const t0 = nowMs()
  rmSync(out, { force: true })
  const db = new DatabaseSync(out)
  db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;')
  db.exec(FTS_DDL)
  db.exec(`ATTACH '${readOnlyUri(snapshot)}' AS snap`)
  db.exec('BEGIN')
  const rows = db
    .prepare('INSERT INTO search_fts (text, id, r) SELECT text, id, rank FROM snap.search_text')
    .run()
  db.exec('COMMIT')
  db.exec("INSERT INTO search_fts (search_fts) VALUES ('optimize')")
  db.exec('DETACH snap')
  db.close()
  return { rows: Number(rows.changes), build_ms: round(nowMs() - t0), bytes: statSync(out).size }
}

if (isMain(import.meta.url)) {
  const [snapshot, out] = process.argv.slice(2)
  if (!snapshot || !out) {
    throw new Error('usage: fts.ts <snapshot.sqlite> <sidecar.sqlite>')
  }
  console.log(JSON.stringify(buildFtsSidecar(snapshot, out)))
}
