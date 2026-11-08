// driver.ts: thin SQLite binding wrapper for fsqlite.
//
// SnapshotStore's only optional SQLite build requirement is the session/changeset
// extension (sqlite3session_create / sqlite3changeset_apply), compiled with
// SQLITE_ENABLE_SESSION and SQLITE_ENABLE_PREUPDATE_HOOK, which most bindings lack.
// Supported Node releases include SQLite with both options enabled and expose it through
// `node:sqlite`. This gives the package session support without a third-party runtime
// dependency or native build and keeps it portable. `better-sqlite3`'s bundled build does
// not enable SQLITE_ENABLE_SESSION. Any session-enabled SQLite build with a binding that
// exposes these APIs can in principle host a SnapshotStore writer against the same
// format.
//
// Readers and DirectStore need none of this: a published snapshot is a plain SQLite file
// openable by any binding in any language. Only a SnapshotStore writer (record a session)
// and reconcile (apply a changeset) need the extension, so the session requirement is
// confined here.

import { DatabaseSync, constants, backup } from 'node:sqlite'
import type { DatabaseSyncOptions } from 'node:sqlite'
import type { WorkFn, Capabilities } from './types.ts'

export { constants }
export type DB = DatabaseSync

/** Bounded wait for a transient SQLite file lock held by another local connection. */
const WRITER_BUSY_TIMEOUT_MS = 5_000

/**
 * Whether this node:sqlite has SQLite's defensive flag. Node 24.12 added the `defensive`
 * option together with `enableDefensive()`, and 24.14 turned it on by default; Node 22 has
 * neither, and its constructor ignores option names it does not know.
 */
const HAS_DEFENSIVE_OPTION =
  typeof (DatabaseSync.prototype as unknown as Record<string, unknown>).enableDefensive ===
  'function'

/** `DatabaseSyncOptions` plus the `defensive` flag that `@types/node` 22 does not declare. */
interface DefensiveOptions extends DatabaseSyncOptions {
  defensive: true
}

/**
 * Open every fsqlite connection through one place, with SQLite's defensive flag pinned on
 * where the binding has it, so `writable_schema`, `journal_mode = OFF`, `schema_version`
 * writes, and direct shadow-table writes are blocked the same way on every Node line that
 * can block them, regardless of that line's default.
 */
export function connect(path: string, options: DatabaseSyncOptions = {}): DatabaseSync {
  if (!HAS_DEFENSIVE_OPTION) {
    return new DatabaseSync(path, options)
  }
  const pinned: DefensiveOptions = { ...options, defensive: true }
  return new DatabaseSync(path, pinned)
}

/** Open a read-write database with fsqlite's connection settings plus `pragmas`. */
function openWritable(path: string, pragmas: string): DatabaseSync {
  const db = connect(path)
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = ${WRITER_BUSY_TIMEOUT_MS};
      ${pragmas}
    `)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the pragma failure that made this connection unusable.
    }
    throw error
  }
}

/**
 * Open a read-write database for a writer working copy, a DirectStore build, or init's
 * snapshot-0 build. Foreign keys are enforced, so a callback observes declared constraints
 * and its foreign-key actions run, which records their effects in the changeset.
 */
export function open(path: string): DatabaseSync {
  return openWritable(path, 'PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
}

/**
 * Open a reconcile build. Foreign-key enforcement stays off for the connection's life: a
 * changeset already carries every row the writer's foreign-key actions changed, so running
 * those actions again during apply would delete, null, or rewrite rows twice and conflict
 * with the recorded changes (spec F3). The explicit `foreign_key_check` after each envelope
 * and at the publication gate keeps constraint closure. The pragma is set here, outside any
 * transaction, because SQLite ignores it inside one.
 *
 * SQLite never syncs the build (`synchronous = OFF`): it is a transient no reader can reach
 * until reconcile fsyncs it and its directory before naming it (spec section 10), and a
 * rollback inside this process reads the journal back from the OS cache. FULL would add a
 * file sync per applied envelope to a file that a crash discards anyway.
 */
export function openBuild(path: string): DatabaseSync {
  return openWritable(path, 'PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;')
}

/** Open an immutable published snapshot read-only. Needs no session support. */
export function openReadonly(path: string): DatabaseSync {
  return connect(path, { readOnly: true })
}

/**
 * Make fsqlite-owned tables read-only for an application callback. These TEMP triggers
 * guard ordinary INSERT, UPDATE, and DELETE mistakes without changing the published
 * snapshot schema. Candidate validation still runs after the callback to catch DDL and
 * pragma changes.
 */
export function protectOwnedTables(db: DatabaseSync): void {
  for (const table of ['applied_tx', 'fsqlite_meta']) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = `fsqlite_protect_${table}_${action.toLowerCase()}`
      db.exec(`
        CREATE TEMP TRIGGER ${trigger}
        BEFORE ${action} ON main.${table}
        BEGIN
          SELECT RAISE(ABORT, 'fsqlite-owned table ${table} is read-only');
        END;
      `)
    }
  }
}

interface CallbackBoundary {
  applicationId: number
  userVersion: number
  schema: string
  temporarySchema: string
}

function schemaFingerprint(
  db: DatabaseSync,
  catalog: 'sqlite_schema' | 'temp.sqlite_schema',
): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM ${catalog} WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all(),
  )
}

/** Capture the format and schema state an application callback must leave unchanged. */
export function captureCallbackBoundary(db: DatabaseSync): CallbackBoundary {
  const applicationId = Number(
    (db.prepare('PRAGMA application_id').get() as Record<string, unknown>).application_id,
  )
  const userVersion = Number(
    (db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version,
  )
  const schema = schemaFingerprint(db, 'sqlite_schema')
  const temporarySchema = schemaFingerprint(db, 'temp.sqlite_schema')
  return { applicationId, userVersion, schema, temporarySchema }
}

/** Fail a callback that attempts format or schema migration inside a data-write API. */
export function assertCallbackBoundary(db: DatabaseSync, before: CallbackBoundary): void {
  const after = captureCallbackBoundary(db)
  if (after.applicationId !== before.applicationId) {
    throw new Error('application callback changed the fsqlite SQLite application id')
  }
  if (after.userVersion !== before.userVersion) {
    throw new Error('application callback changed the caller schema version')
  }
  if (after.schema !== before.schema) {
    throw new Error('application callback changed the SQLite schema')
  }
  if (after.temporarySchema !== before.temporarySchema) {
    throw new Error('application callback changed the SQLite temporary schema')
  }
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

/** Return caller-declared foreign key violations with stable diagnostic detail. */
export function foreignKeyProblems(db: DatabaseSync): string[] {
  try {
    return (db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[]).map(
      (row) => `foreign_key_check: ${JSON.stringify(row)}`,
    )
  } catch (error) {
    return [`foreign_key_check error: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/** Fail when caller-declared foreign keys do not hold at the current transaction boundary. */
export function foreignKeyCheck(db: DatabaseSync): void {
  const problems = foreignKeyProblems(db)
  if (problems.length > 0) {
    throw new Error(problems.join('; '))
  }
}

/** Cheap integrity gate run before publishing a candidate snapshot. */
export function quickCheck(db: DatabaseSync): void {
  if (!pragmaOk(db, 'quick_check')) {
    const rows = db.prepare('PRAGMA quick_check').all()
    throw new Error(`quick_check failed: ${JSON.stringify(rows)}`)
  }
  foreignKeyCheck(db)
}

/**
 * Full integrity validation; returns physical corruption and foreign key problems.
 * Returning diagnostics lets `validate` and `seal` surface what is wrong.
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
  const integrity = messages.length === 1 && messages[0] === 'ok' ? [] : messages
  return [...integrity, ...foreignKeyProblems(db)]
}

/** Full integrity check (used by validate/seal). */
export function integrityCheck(db: DatabaseSync): boolean {
  return integrityProblems(db).length === 0
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
    probe = connect(':memory:')
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
