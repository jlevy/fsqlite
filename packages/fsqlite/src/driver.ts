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

// Node 26.11 renamed the class `Database` and kept `DatabaseSync` as an alias deprecated
// in documentation only (DEP0210, no runtime warning). Only `DatabaseSync` exists on every
// supported line, so fsqlite keeps that name until its Node floor reaches 26.11.
import { DatabaseSync, constants, backup } from 'node:sqlite'
import type { DatabaseSyncOptions } from 'node:sqlite'
import { errorMessage, FsqliteError } from './errors.ts'
import type { WorkFn, Capabilities } from './types.ts'

export { constants }
export type DB = DatabaseSync

/**
 * The tables fsqlite owns in every snapshot: the `applied_tx` idempotency ledger and the
 * `fsqlite_meta` identity stamp. Every other table belongs to the caller.
 */
export const OWNED_TABLES = Object.freeze(['applied_tx', 'fsqlite_meta'] as const)

/** The numeric value of a single-value PRAGMA such as `user_version` or `page_size`. */
export function pragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  return Number(Object.values(row ?? {})[0])
}

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
  for (const table of OWNED_TABLES) {
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
  const applicationId = pragmaNumber(db, 'application_id')
  const userVersion = pragmaNumber(db, 'user_version')
  const schema = schemaFingerprint(db, 'sqlite_schema')
  const temporarySchema = schemaFingerprint(db, 'temp.sqlite_schema')
  return { applicationId, userVersion, schema, temporarySchema }
}

/** Fail a callback that attempts format or schema migration inside a data-write API. */
export function assertCallbackBoundary(db: DatabaseSync, before: CallbackBoundary): void {
  const after = captureCallbackBoundary(db)
  const refuse = (what: string): never => {
    throw new FsqliteError('refused', `application callback changed the ${what}`)
  }
  if (after.applicationId !== before.applicationId) {
    refuse('fsqlite SQLite application id')
  }
  if (after.userVersion !== before.userVersion) {
    refuse('caller schema version')
  }
  if (after.schema !== before.schema) {
    refuse('SQLite schema')
  }
  if (after.temporarySchema !== before.temporarySchema) {
    refuse('SQLite temporary schema')
  }
}

/**
 * Run `fn` while recording a session over all tables, returning the changeset blob
 * (or null if nothing changed). The body runs inside a single transaction.
 */
export function recordChangeset(db: DatabaseSync, fn: WorkFn): Uint8Array | null {
  const session = db.createSession()
  try {
    db.exec('BEGIN')
    try {
      fn(db)
      db.exec('COMMIT')
    } catch (e) {
      rollbackQuietly(db)
      throw e
    }
    const cs = session.changeset()
    return cs.length === 0 ? null : cs
  } finally {
    session.close()
  }
}

/**
 * Roll back while another error is propagating. A failed ROLLBACK (no transaction is open
 * after SQLite already rolled back) must not replace the error being reported.
 */
export function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // Keep the original error.
  }
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
    return [`foreign_key_check error: ${errorMessage(error)}`]
  }
}

/** Fail when caller-declared foreign keys do not hold at the current transaction boundary. */
export function foreignKeyCheck(db: DatabaseSync): void {
  const problems = foreignKeyProblems(db)
  if (problems.length > 0) {
    throw new FsqliteError('refused', problems.join('; '))
  }
}

/** SQLite primary result codes that mean the file itself is damaged or not a database. */
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
/** Extended result codes carry the primary code in their low byte. */
const PRIMARY_RESULT_CODE_MASK = 0xff

/** Whether `error` is SQLite reporting a damaged database file. */
export function isSqliteCorruption(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  if (typeof errcode !== 'number') {
    return false
  }
  const primary = errcode & PRIMARY_RESULT_CODE_MASK
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB
}

/** Cheap integrity gate run before publishing a candidate snapshot. */
export function quickCheck(db: DatabaseSync): void {
  if (!pragmaOk(db, 'quick_check')) {
    const rows = db.prepare('PRAGMA quick_check').all()
    throw new FsqliteError('corrupt', `quick_check failed: ${JSON.stringify(rows)}`)
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
    return [`integrity_check error: ${errorMessage(e)}`]
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

/** Options for {@link backupDatabase}. */
export interface BackupDatabaseOptions {
  /** Pages copied per backup step. Lower values yield more often to concurrent writers. */
  rate?: number
  /** Called after each backup step with stable package-owned progress data. */
  progress?: (progress: { totalPages: number; remainingPages: number }) => void
}

/**
 * Consistent online backup of a *live* database to `destPath` via SQLite's backup API
 * (never a raw `cp` of an open file). For a cross-host copy of a *published, immutable*
 * snapshot, a plain file copy is already safe because the snapshot never changes.
 */
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

let writerCapabilitiesVerified = false

/**
 * Fail loudly at the writer entry point on a binding/build without the session extension,
 * rather than silently recording an empty changeset (which would look like "no changes" and
 * drop the write). Memoized: the capability of a given process never changes.
 */
export function requireWriterCapabilities(
  getCapabilities: () => Capabilities = capabilities,
): void {
  const usingDefaultProbe = getCapabilities === capabilities
  if (usingDefaultProbe && writerCapabilitiesVerified) {
    return
  }
  if (!getCapabilities().session) {
    throw new FsqliteError(
      'incompatible',
      'fsqlite SnapshotStore writers require the SQLite session extension (SQLITE_ENABLE_SESSION), ' +
        'which this SQLite binding/build does not provide. Use a session-enabled build, or use ' +
        'DirectStore, which needs no session extension.',
    )
  }
  if (usingDefaultProbe) {
    writerCapabilitiesVerified = true
  }
}
