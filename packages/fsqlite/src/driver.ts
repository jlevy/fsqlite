// driver.ts: thin SQLite binding wrapper for fsqlite.
//
// fsqlite depends on exactly one capability that most SQLite bindings lack: the
// session/changeset extension (sqlite3session_create / sqlite3changeset_apply).
// `node:sqlite` ships it built-in and needs no runtime dependency, native build, or
// prebuild. This keeps the package portable. `better-sqlite3`'s bundled
// build does not enable SQLITE_ENABLE_SESSION. Deno exposes the same `node:sqlite` with
// sessions; Bun does not implement `node:sqlite` yet. Any session-enabled SQLite build can
// in principle host a writer against the same format.
//
// Readers need none of this: a published snapshot is a plain SQLite file openable by any
// binding in any language. Only the writer (record a session) and reconcile (apply a
// changeset) need the extension, so the session requirement is confined here.

import { DatabaseSync, constants, backup } from 'node:sqlite'
import type { WorkFn, Capabilities } from './types.ts'

export { constants }
export type DB = DatabaseSync

/** Open a read-write database (used for writer working copies and reconcile temps). */
export function open(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

/** Open an immutable published snapshot read-only. Needs no session support. */
export function openReadonly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

/**
 * Run `fn` while recording a session over all tables, returning the changeset blob
 * (or null if nothing changed). The body runs inside a single transaction.
 */
export function recordChangeset(db: DatabaseSync, fn: WorkFn): Uint8Array | null {
  const session = db.createSession()
  db.exec('BEGIN')
  try {
    fn(db)
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
  const cs = session.changeset()
  return cs.length === 0 ? null : cs
}

/**
 * Finalize a database into a clean single-file snapshot via `VACUUM INTO`. This is
 * the SQLite-blessed way to capture a consistent copy (never a live `cp` of an open
 * DB), and it leaves no `-wal`/`-shm` side files behind, required before
 * sealing/packaging.
 */
export function vacuumInto(db: DatabaseSync, destPath: string): void {
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
}

function pragmaOk(db: DatabaseSync, pragma: string): boolean {
  const rows = db.prepare(`PRAGMA ${pragma}`).all() as Record<string, unknown>[]
  const row = rows[0]
  return row !== undefined && rows.length === 1 && Object.values(row)[0] === 'ok'
}

/** Cheap integrity gate run before publishing a candidate snapshot. */
export function quickCheck(db: DatabaseSync): void {
  if (!pragmaOk(db, 'quick_check')) {
    const rows = db.prepare('PRAGMA quick_check').all()
    throw new Error(`quick_check failed: ${JSON.stringify(rows)}`)
  }
}

/**
 * Full integrity check; returns the problems reported by `PRAGMA integrity_check` ([] means
 * clean). Returning the rows, not just a boolean, lets `validate`/`seal` surface *what* is
 * wrong instead of a bare "failed" verdict.
 */
export function integrityProblems(db: DatabaseSync): string[] {
  let rows: Record<string, unknown>[]
  try {
    rows = db.prepare('PRAGMA integrity_check').all()
  } catch (e) {
    // Severe corruption makes SQLite throw SQLITE_CORRUPT mid-check rather than return rows;
    // surface that as a problem (R2) instead of letting it crash validate/seal.
    return [`integrity_check error: ${(e as Error).message}`]
  }
  const messages = rows.map((r) => String(Object.values(r)[0]))
  return messages.length === 1 && messages[0] === 'ok' ? [] : messages
}

/** Full integrity check (used by validate/seal). */
export function integrityCheck(db: DatabaseSync): boolean {
  return integrityProblems(db).length === 0
}

/**
 * Rows violating a declared FOREIGN KEY, per `PRAGMA foreign_key_check` ([] means clean).
 *
 * Structural integrity and referential integrity are different axes and neither
 * `quick_check` nor `integrity_check` looks at foreign keys. Row-level merge resolves
 * same-primary-key conflicts, so two envelopes that were each valid against the base can
 * still combine into a dangling reference (one deletes a parent while the other adds a
 * child). That is inherent to write-set merge; leaving it undetected is not, so validate
 * reports it (R2). See fsql-format-spec.md §6.1.
 */
export function foreignKeyViolations(db: DatabaseSync): { table: string; parent: string }[] {
  let rows: Record<string, unknown>[]
  try {
    rows = db.prepare('PRAGMA foreign_key_check').all()
  } catch {
    return [] // a schema with no foreign keys, or a build without FK support
  }
  const name = (value: unknown): string => (typeof value === 'string' ? value : '?')
  return rows.map((r) => ({ table: name(r.table), parent: name(r.parent) }))
}

/**
 * Report what the current binding can do, so callers detect capabilities instead of
 * assuming them. A `SnapshotStore` writer requires `session`;
 * readers and `DirectStore` require none of these. Probing `session` actually creates
 * a session on a throwaway in-memory db, because presence of the method is not proof
 * the build enabled `SQLITE_ENABLE_SESSION`.
 */
export function capabilities(): Capabilities {
  let session = false
  let probe: DatabaseSync | undefined
  try {
    probe = new DatabaseSync(':memory:')
    probe.exec('CREATE TABLE t(x INTEGER PRIMARY KEY)')
    const s = probe.createSession()
    probe.exec('INSERT INTO t VALUES (1)')
    session = s.changeset().length > 0
  } catch {
    // A capability probe is expected to fail on a build without session support.
  } finally {
    probe?.close()
  }
  const proto = DatabaseSync.prototype as unknown as Record<string, unknown>
  return {
    session,
    applyChangeset: typeof proto.applyChangeset === 'function',
    backup: typeof backup === 'function',
    loadExtension: typeof proto.loadExtension === 'function',
    // node:sqlite has no rebaser binding; only APSW / sqlite-wasm expose it.
    rebaser: false,
  }
}

/**
 * Consistent online backup of a *live* database to `destPath` via SQLite's backup API
 * (never a raw `cp` of an open file). For a cross-host copy of a *published, immutable*
 * snapshot, a plain file copy is already safe because the snapshot never changes.
 */
export interface BackupDatabaseOptions {
  /** Pages copied per backup step. Lower values yield more often to concurrent writers. */
  rate?: number
  /** Called after each backup step with stable package-owned progress data. */
  progress?: (progress: { totalPages: number; remainingPages: number }) => void
}

export async function backupDatabase(
  sourcePath: string,
  destPath: string,
  options: BackupDatabaseOptions = {},
): Promise<void> {
  const db = openReadonly(sourcePath)
  try {
    await backup(db, destPath, options)
  } finally {
    db.close()
  }
}

let _writerCapsOk = false

/**
 * Fail loudly at the writer entry point on a binding/build without the session extension,
 * rather than silently recording an empty changeset (which would look like "no changes" and
 * drop the write). Memoized: the capability of a given process never changes.
 */
export function requireWriterCapabilities(
  getCapabilities: () => Capabilities = capabilities,
): void {
  const usingDefaultProbe = getCapabilities === capabilities
  if (usingDefaultProbe && _writerCapsOk) {
    return
  }
  if (!getCapabilities().session) {
    throw new Error(
      'fsqlite SnapshotStore writers require the SQLite session extension (SQLITE_ENABLE_SESSION), ' +
        'which this SQLite binding/build does not provide. Use a session-enabled build, or use ' +
        'DirectStore, which needs no session extension.',
    )
  }
  if (usingDefaultProbe) {
    _writerCapsOk = true
  }
}
