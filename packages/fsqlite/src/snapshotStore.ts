// snapshotStore.ts: the core fsqlite engine. Snapshot-publish plus transaction envelopes
// plus idempotent reconcile, over a caller-provided schema and merge policy.
//
//   - Published heads are immutable versioned snapshots (snapshots/<N>.fsqlite.sqlite),
//     selected by a tiny `current` pointer file.
//   - Writers are lock-free: seed a session from the current immutable snapshot (safe,
//     never mutated), run their work, and drop a transaction envelope under
//     tx/pending/<txid>.txn/ (manifest.json, changeset.bin, and a COMMITTED marker
//     written last). Unique paths make this conflict-free on local disk and NFS.
//   - reconcile() builds the next snapshot in a temp file from current plus the committed
//     pending tx (skipping any already in the snapshot's applied_tx ledger, quarantining
//     corrupt or aborted ones), runs quick_check, then publishes by atomically swapping
//     `current`. Building is lock-free; only the short publish (re-check pointer, rename)
//     is fenced by the mkdir lease lock with optimistic concurrency.
//   - Readers open only the immutable snapshot named by `current`: no session extension,
//     any SQLite binding, any language.
//
// Crash-safety: each changeset's data and its applied_tx ledger row are both committed
// into the throwaway build snapshot before it is published, and publish is a single atomic
// pointer swap, so a published snapshot always carries the ledger for everything in it.
// The next reconcile seeds from that snapshot and skips already-applied tx (the ledger),
// making publish exactly-once across crashes and racing reconcilers.

import {
  closeSync,
  mkdirSync,
  copyFileSync,
  linkSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import * as driver from './driver.ts'
import { normalize, applyWithPolicy } from './conflictPolicy.ts'
import {
  errorMessage,
  FsqliteError,
  PermanentConflictError,
  PostPublishError,
  StoreFormatError,
  StrictConflictError,
  TransactionError,
} from './errors.ts'
import { fsyncPath, fsyncDir, publishPointer, removeQuietly } from './fsutil.ts'
import { commitSnapshot } from './publication.ts'
import type { CommitOutcome } from './publication.ts'
import { validateLockOptions, withLock } from './lock.ts'
import {
  createStoreMarker,
  hasStoreMarker,
  readStoreMarker,
  recognizeStore,
  STORE_FORMAT_VERSION,
  STORE_MARKER_FILENAME,
  FSQLITE_APPLICATION_ID,
} from './storeFormat.ts'
import type { StoreMarker } from './storeFormat.ts'
import type { LockLease, LockOptions } from './lock.ts'
import type {
  StoreOptions,
  NormalizedPolicy,
  WorkFn,
  ReadFn,
  ValidateResult,
  ReadLeaseOptions,
  ReconcileOptions,
  ReconcileResult,
  WriteWithRetryOptions,
  WriteWithRetryResult,
  GcOptions,
  GcResult,
  RepairOptions,
  RepairResult,
  StoreState,
  StoreValidationState,
  ReadLease,
} from './types.ts'

const rand = (): string => randomBytes(5).toString('hex')
const sha256 = (buf: Uint8Array | string): string => createHash('sha256').update(buf).digest('hex')
const pad = (n: number): string => String(n).padStart(12, '0')
const txIdOf = (txn: string): string => txn.replace(/\.txn$/, '')
const nowIso = (): string => new Date().toISOString()

const CHANGESET_FILENAME = 'changeset.bin'
const DEFAULT_TOOL_VERSION = 'fsqlite'
const DEFAULT_READ_LEASE_RETRIES = 8
/**
 * Pointer re-reads a reader makes when the snapshot `current` named was collected before it
 * could open it (spec section 13). Each retry follows a newer publication, and gc never
 * collects the newest snapshots, so contention, not corruption, exhausts this.
 */
const COLLECTED_SNAPSHOT_RETRIES = 8
const DEFAULT_WRITE_RETRIES = 5
const DEFAULT_RECONCILE_RETRIES = 8
/** Predecessors of `current` that gc keeps by default (spec G1). */
export const DEFAULT_RETAINED_SNAPSHOTS = 3
const DEFAULT_LEASE_STALE_MS = 60_000
const DEFAULT_TRANSIENT_STALE_MS = 60_000
const MAX_SCHEMA_VERSION = 0x7fffffff

function validateSchemaVersion(value: unknown = 1): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SCHEMA_VERSION
  ) {
    throw new TypeError(
      `schemaVersion must be an integer between 0 and ${MAX_SCHEMA_VERSION}; received ${String(value)}`,
    )
  }
  return value
}

/** Throw a TypeError unless `value` is a safe integer of at least `min`. */
export function requireSafeInteger(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}; received ${String(value)}`)
  }
  return value
}

/**
 * Store states in which gc may proceed: the head passed identity and lineage validation,
 * and full integrity validation whenever gc has a snapshot to delete (see `gc`).
 * `in-flight-capture` qualifies because its tells (fresh transients, a held lock,
 * uncommitted envelopes, an orphan ahead of `current`) are routine on a live store and gc
 * never touches them; a corrupt or unrecognized store may need every snapshot.
 */
const GC_SAFE_STATES: ReadonlySet<StoreValidationState> = new Set([
  'sealed',
  'live',
  'in-flight-capture',
])

/** Whether `state` is a recognition failure, which no maintenance may act on. */
const isRecognitionFailure = (
  state: StoreValidationState,
): state is 'not-a-store' | 'invalid' | 'unsupported' =>
  state === 'not-a-store' || state === 'invalid' || state === 'unsupported'

const repairLostOwnership = (): FsqliteError =>
  new FsqliteError('retryable', 'repair lost ownership of publish.lock before mutation')

/**
 * Machine reason codes that open a `QUARANTINE` file for an envelope whose apply failed.
 * The text after the colon is diagnostic detail; `writeWithRetry` reads only the code.
 */
type ApplyFailureCode = 'strict-conflict' | 'permanent-conflict' | 'apply-failed'

/** The quarantine reason for an apply failure, classified by error type, not message. */
function applyFailureReason(error: unknown): string {
  const code: ApplyFailureCode =
    error instanceof StrictConflictError
      ? 'strict-conflict'
      : error instanceof PermanentConflictError
        ? 'permanent-conflict'
        : 'apply-failed'
  const detail =
    error instanceof StrictConflictError || error instanceof PermanentConflictError
      ? error.conflictTypes.join(',')
      : error instanceof Error
        ? error.message
        : String(error)
  return `${code}: ${detail}`
}

/** The machine code that opens a quarantine reason (`digest-mismatch`, `strict-conflict`). */
const quarantineReasonCode = (reason: string): string => reason.split(':', 1)[0]?.trim() ?? ''

/**
 * The most of `current` a read loads. A valid pointer is a safe-integer version (at most
 * 16 digits) plus optional whitespace, so anything longer is corruption, and bounding the
 * read keeps a pointer replaced by a large file from being loaded and echoed whole.
 */
const MAX_POINTER_BYTES = 64
/** The most of a malformed pointer an error message quotes. */
const POINTER_QUOTE_CHARS = 32
/**
 * A valid pointer (spec P1): decimal digits with optional ASCII whitespace around them.
 * `trim()` would also strip Unicode spaces and a byte order mark.
 */
const POINTER_PATTERN = /^[ \t\n\v\f\r]*(\d+)[ \t\n\v\f\r]*$/
/** Characters a log line would hide: controls, format characters such as a BOM, spaces. */
const UNPRINTED = /[\p{Cc}\p{Cf}\p{Z}]/gu

/** `JSON.stringify(text)`, also escaping every unprinted character but U+0020. */
function escapeText(text: string): string {
  return JSON.stringify(text).replace(UNPRINTED, (c) => {
    const code = c.codePointAt(0) ?? 0
    if (c === ' ') {
      return c
    }
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/**
 * Quote at most {@link POINTER_QUOTE_CHARS} characters (code points, so none is split) of
 * malformed pointer text, escaped. `prefix` says the text is already only the start of the
 * pointer, so the quote names itself a prefix even when every character fits.
 */
function quotePointer(text: string, prefix = false): string {
  const chars = Array.from(text)
  if (!prefix && chars.length <= POINTER_QUOTE_CHARS) {
    return escapeText(text)
  }
  const quoted = chars.slice(0, POINTER_QUOTE_CHARS)
  return `${escapeText(quoted.join(''))} (the first ${quoted.length} characters)`
}

/** Read at most {@link MAX_POINTER_BYTES} of `current`; a longer file is corruption. */
function readPointerText(path: string): string {
  const buf = Buffer.alloc(MAX_POINTER_BYTES + 1)
  const fd = openSync(path, 'r')
  let length = 0
  try {
    while (length < buf.length) {
      const n = readSync(fd, buf, length, buf.length - length, length)
      if (n === 0) {
        break
      }
      length += n
    }
  } finally {
    closeSync(fd)
  }
  if (length > MAX_POINTER_BYTES) {
    // Streaming decode holds back a character the bound cuts off instead of emitting U+FFFD.
    const start = new TextDecoder().decode(buf.subarray(0, MAX_POINTER_BYTES), { stream: true })
    throw new FsqliteError(
      'corrupt',
      `corrupt current pointer: larger than ${MAX_POINTER_BYTES} bytes, beginning ` +
        quotePointer(start, true),
    )
  }
  return buf.toString('utf8', 0, length)
}

/** init found a lineage without `current`; only repair may choose the head to restore. */
const missingPointerError = (versions: number[]): FsqliteError =>
  new FsqliteError(
    'corrupt',
    `refusing to initialize: ${STORE_MARKER_FILENAME} exists and snapshots/ holds snapshot(s) ` +
      `${versions.join(', ')}, but current is missing; run repair to restore current to the ` +
      'newest integrity-clean snapshot instead of re-creating snapshot 0',
  )

// Transient (never-store-state) entries, per fsql-format-spec.md §2: reconcile builds,
// DirectStore builds, init's snapshot-0 temp and the SQLite rollback journal beside it
// (`.tmp-journal`), writer working copies, lease temps (`leases/*.tmp`), gc tombstones
// (`.gc-<version>-<hex>.tmp`), and lock directories moved aside by a break or release
// (`publish.lock.<hex>.tmp/`, the only directory). A fresh one is work in flight; an old
// one is crash debris. Removal is recursive for that reason.
const isTransientFile = (f: string): boolean =>
  f.startsWith('.build-') ||
  f.startsWith('.direct-') ||
  f.startsWith('.work-') ||
  f.endsWith('.tmp') ||
  f.endsWith('.tmp-journal')

/** A gc tombstone: a snapshot renamed aside by a gc that may have crashed (spec G2). */
const isGcTombstone = (f: string): boolean => f.startsWith('.gc-') && f.endsWith('.tmp')

// writerId is interpolated into filesystem paths (the working copy and the envelope dir),
// so it must be a safe single path component: no separators, traversal, or oversize names.
const SAFE_WRITER_ID = /^[A-Za-z0-9._-]{1,64}$/

/** Default cap on a single changeset envelope before reconcile quarantines it (1 GiB). */
const DEFAULT_MAX_ENVELOPE_BYTES = 1 << 30

/**
 * Every caller table needs a NON-NULL primary key: the per-table merge policy is keyed on it,
 * and a session silently omits any row whose key is NULL. A rowid table's INTEGER PRIMARY KEY
 * is a non-null rowid alias exactly when SQLite builds no separate primary-key index for it;
 * the column-level `INTEGER PRIMARY KEY DESC` form gets one, stays an ordinary column, and
 * admits NULL. Every other primary key column must be NOT NULL (SQLite otherwise allows a
 * NULL in a non-integer PRIMARY KEY).
 */
function validatePrimaryKeys(db: driver.DB): void {
  const owned: readonly string[] = driver.OWNED_TABLES
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((name) => !owned.includes(name))
  for (const t of tables) {
    const quoted = `"${t.replace(/"/g, '""')}"`
    const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    const pk = cols.filter((c) => c.pk > 0)
    if (pk.length === 0) {
      throw new FsqliteError(
        'incompatible',
        `table "${t}" has no primary key; fsqlite requires a NON-NULL primary key`,
      )
    }
    const firstPk = pk[0]
    const integerKey =
      pk.length === 1 && firstPk !== undefined && /^integer$/i.test(firstPk.type.trim())
    const hasPkIndex = (
      db.prepare(`PRAGMA index_list(${quoted})`).all() as { origin: string }[]
    ).some((index) => index.origin === 'pk')
    const isRowidAlias = integerKey && !hasPkIndex
    const nullablePk = pk.find((c) => c.notnull === 0)
    if (isRowidAlias || !nullablePk) {
      continue
    }
    if (integerKey) {
      throw new FsqliteError(
        'incompatible',
        `table "${t}" primary key column "${nullablePk.name}" is nullable: an INTEGER PRIMARY ` +
          'KEY declared DESC is not a rowid alias and admits NULL keys, which changesets omit; ' +
          'declare it NOT NULL or drop DESC',
      )
    }
    throw new FsqliteError(
      'incompatible',
      `table "${t}" primary key column "${nullablePk.name}" is nullable; declare it NOT NULL`,
    )
  }
}

/**
 * Refuse a caller schema that declares a trigger (spec S4). Reconcile applies a changeset
 * with ordinary statements, so a trigger would fire again on the build and collide with the
 * rows it already wrote at capture, quarantining valid envelopes. node:sqlite exposes no way
 * to disable triggers for a connection.
 */
function rejectCallerTriggers(db: driver.DB): void {
  const triggers = db
    .prepare("SELECT name, tbl_name FROM main.sqlite_schema WHERE type = 'trigger' ORDER BY name")
    .all() as { name: string; tbl_name: string }[]
  if (triggers.length === 0) {
    return
  }
  const named = triggers.map((t) => `"${t.name}" on table "${t.tbl_name}"`).join(', ')
  throw new FsqliteError(
    'incompatible',
    `SnapshotStore does not support triggers: the caller schema declares trigger ${named}. ` +
      'Reconcile applies changesets with ordinary statements, so a trigger would fire again ' +
      'and conflict with the rows it already wrote; remove the trigger, or use DirectStore, ' +
      'which runs callbacks directly and supports triggers',
  )
}

/** SQL text with comments, string literals, and quoted identifiers blanked out. */
const sqlCodeOnly = (sql: string): string =>
  sql.replace(
    /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g,
    ' ',
  )

/**
 * A conflict clause that resolves a clash instead of reporting it. Only a primary key or
 * UNIQUE constraint can be at stake: a `NOT NULL ON CONFLICT` clause substitutes its
 * default at capture, so the changeset already carries the resolved value.
 */
const KEY_CONFLICT_RESOLUTION = /\bON\s+CONFLICT\s+(?:REPLACE|IGNORE)\b/i
const NOT_NULL_CONFLICT_CLAUSE = /\bNOT\s+NULL\s+ON\s+CONFLICT\s+\w+/gi

/**
 * Refuse a caller table whose primary key or UNIQUE constraint declares `ON CONFLICT
 * REPLACE` or `IGNORE` (spec S4). Changeset apply runs ordinary statements, so SQLite
 * would resolve a clash by that clause and never report it to the merge policy: REPLACE
 * deletes the conflicting row and IGNORE drops the incoming one, both while the envelope
 * is ledgered as applied, even under `strict`.
 */
function rejectKeyConflictResolution(db: driver.DB): void {
  const tables = db
    .prepare(
      "SELECT name, sql FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; sql: string | null }[]
  const offending = tables
    .filter(({ sql }) =>
      KEY_CONFLICT_RESOLUTION.test(sqlCodeOnly(sql ?? '').replace(NOT_NULL_CONFLICT_CLAUSE, ' ')),
    )
    .map(({ name }) => `"${name}"`)
  if (offending.length === 0) {
    return
  }
  throw new FsqliteError(
    'incompatible',
    'SnapshotStore does not support ON CONFLICT REPLACE or IGNORE on a primary key or UNIQUE ' +
      `constraint: table ${offending.join(', ')} declares one. Reconcile applies changesets ` +
      'with ordinary statements, so SQLite would resolve a clash by that clause instead of ' +
      'reporting it to the merge policy, deleting or dropping rows silently; remove the ' +
      'clause, or use DirectStore, which runs callbacks directly',
  )
}

// applied_tx is the per-snapshot idempotency ledger fsqlite manages on the caller's
// behalf; fsqlite_meta stamps the store's own identity (schema hash, tool version) so a
// reopen with a divergent schema is rejected loudly. These are the only two tables fsqlite
// owns; everything else is the caller's. Both are copied forward with every snapshot.
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS applied_tx (
  tx_id TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);`

const META_DDL = `CREATE TABLE IF NOT EXISTS fsqlite_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);`

type BeforeSnapshotOpenHook = (version: number) => void
let beforeSnapshotOpenHook: BeforeSnapshotOpenHook | null = null

/**
 * Internal fault-injection seam: runs after a reader parsed `current` and before it opens
 * or copies the snapshot that pointer names, the window in which gc can collect it. Pass
 * null to remove it.
 */
export function setBeforeSnapshotOpenForTest(hook: BeforeSnapshotOpenHook | null): void {
  beforeSnapshotOpenHook = hook
}

type CrashAt = 'after-build' | 'after-snapshot' | 'after-pointer' | null
let reconcileCrashAtForTest: CrashAt = null

/** Internal fault-injection seam for crash recovery tests. */
export function setReconcileCrashForTest(crashAt: CrashAt): void {
  reconcileCrashAtForTest = crashAt
}

interface Manifest {
  tx_id: string
  format_version: string
  store_id: string
  writer_id: string
  base_version: number
  schema_version: number
  schema_hash: string
  created_at: string
  changeset: string
  changeset_sha256: string
  tool_version: string
}

/** One repair step: how a plan names it, and the fenced action that takes it. */
interface RepairStep {
  planned: string
  /** Take the step; it calls `assertOwnership` before each mutation. Returns what it did. */
  apply: (assertOwnership: () => void) => string
}

/** What one reconcile build did with each committed pending envelope (spec F3). */
interface FoldResult {
  applied: string[]
  archivable: string[]
  quarantined: [string, string][]
}

interface TableColumn {
  name: string
  type: string
  notnull: number
  pk: number
}

const EXPECTED_OWNED_TABLES: Record<string, TableColumn[]> = {
  applied_tx: [
    { name: 'tx_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  fsqlite_meta: [
    { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
  ],
}

function metaValue(db: driver.DB, key: string): string | undefined {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fsqlite_meta'")
    .get()
  if (!hasMeta) {
    return undefined
  }
  const row = db.prepare('SELECT value FROM fsqlite_meta WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value
}

function verifyOwnedTableShapes(db: driver.DB): void {
  for (const [table, expected] of Object.entries(EXPECTED_OWNED_TABLES)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableColumn[]
    const normalized = actual.map(({ name, type, notnull, pk }) => ({
      name,
      type: type.toUpperCase(),
      notnull,
      pk,
    }))
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
      throw new FsqliteError('corrupt', `snapshot has invalid fsqlite-owned table ${table}`)
    }
  }
}

/** @internal Verify the format-owned identity and tables of a candidate snapshot. */
export function verifySnapshotIdentity(db: driver.DB, marker: StoreMarker): void {
  const applicationId = driver.pragmaNumber(db, 'application_id')
  if (applicationId !== FSQLITE_APPLICATION_ID) {
    throw new FsqliteError(
      'corrupt',
      `snapshot application_id ${applicationId} does not match fsqlite application_id ${FSQLITE_APPLICATION_ID}`,
    )
  }
  verifyOwnedTableShapes(db)
  const storedFormatVersion = metaValue(db, 'format_version')
  if (storedFormatVersion !== marker.format_version) {
    throw new FsqliteError(
      'corrupt',
      `snapshot format version ${String(storedFormatVersion)} does not match ${STORE_MARKER_FILENAME} ` +
        marker.format_version,
    )
  }
  const storedStoreId = metaValue(db, 'store_id')
  if (storedStoreId !== marker.store_id) {
    throw new FsqliteError(
      'corrupt',
      `snapshot store_id ${String(storedStoreId)} does not match ${STORE_MARKER_FILENAME} ${marker.store_id}`,
    )
  }
  for (const key of ['schema_hash', 'tool_version']) {
    if (metaValue(db, key) === undefined) {
      throw new FsqliteError('corrupt', `snapshot is missing required fsqlite_meta key ${key}`)
    }
  }
}

/** @internal Reassert all format and caller-schema invariants before publication. */
export function verifySnapshotForPublish(
  db: driver.DB,
  marker: StoreMarker,
  schemaVersion: number,
  schemaHash: string,
): void {
  verifySnapshotIdentity(db, marker)
  const version = driver.pragmaNumber(db, 'user_version')
  if (version !== schemaVersion) {
    throw new FsqliteError(
      'incompatible',
      `store schema version ${version} is incompatible with the requested ${schemaVersion}`,
    )
  }
  const storedHash = metaValue(db, 'schema_hash')
  if (storedHash !== schemaHash) {
    throw new FsqliteError(
      'incompatible',
      `store schema is incompatible: stamped schema_hash ${storedHash} does not match the requested ` +
        `exact DDL hash ${schemaHash} at schemaVersion ${schemaVersion}`,
    )
  }
}

/**
 * The lock-free concurrent multi-writer engine: writers drop changeset envelopes
 * (`write`), an out-of-band `reconcile` folds them into the next immutable snapshot and
 * publishes it with an atomic pointer swap, and readers (`read`) open only the published
 * snapshot. Writers need the session extension; readers need none. Shared filesystems must
 * provide the capabilities required by the format specification. Correctness rests on
 * immutable snapshots, the `applied_tx` ledger, and exclusive publication ownership until
 * release. The publish lock is never taken over on age alone.
 */
export class SnapshotStore {
  /** The store root this handle was opened on. */
  readonly dir: string
  /** @internal Store layout paths (spec section 2); not part of the public API. */
  readonly snapDir: string
  /** @internal */
  readonly txPending: string
  /** @internal */
  readonly txApplied: string
  /** @internal */
  readonly txQuarantine: string
  /** @internal */
  readonly leaseDir: string
  /** @internal */
  readonly currentPath: string
  /** @internal */
  readonly publishLock: string
  /** The caller DDL; see {@link StoreOptions.schema}. */
  readonly schema: string
  readonly schemaVersion: number
  /** The first 16 hex digits of SHA-256 over `schema`, stamped into every snapshot. */
  readonly schemaHash: string
  /** The frozen, normalized merge policy this handle reconciles with. */
  readonly conflictPolicy: NormalizedPolicy
  readonly toolVersion: string
  readonly maxEnvelopeBytes: number
  private clock: number

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = dir
    this.snapDir = join(dir, 'snapshots')
    this.txPending = join(dir, 'tx', 'pending')
    this.txApplied = join(dir, 'tx', 'applied')
    this.txQuarantine = join(dir, 'tx', 'quarantine')
    this.leaseDir = join(dir, 'leases')
    this.currentPath = join(dir, 'current')
    this.publishLock = join(dir, 'publish.lock')

    this.schema = opts.schema ?? ''
    this.schemaVersion = validateSchemaVersion(opts.schemaVersion)
    // The exact caller-DDL hash completes the immutable schema identity. A version or hash
    // mismatch is incompatible in f1.0; neither token performs migration.
    this.schemaHash = sha256(this.schema).slice(0, 16)
    this.conflictPolicy = normalize(opts.conflictPolicy ?? {})
    this.toolVersion = opts.toolVersion ?? DEFAULT_TOOL_VERSION
    this.maxEnvelopeBytes = requireSafeInteger(
      'maxEnvelopeBytes',
      opts.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
      1,
    )
    this.clock = 0
  }

  /**
   * Create the store if absent, otherwise verify it is schema-compatible (idempotent).
   * Snapshot 0 holds the empty schema. First-open is fenced under the publish lock and built
   * through a temp file, so concurrent initializers converge on one clean snapshot 0 rather
   * than racing the initial file and pointer. Validates the NON-NULL primary key contract.
   */
  init(): this {
    mkdirSync(this.dir, { recursive: true })
    withLock(this.publishLock, (_token, lease) => {
      let marker: StoreMarker
      if (hasStoreMarker(this.dir)) {
        marker = readStoreMarker(this.dir)
      } else {
        const unrelated = readdirSync(this.dir).filter((entry) => entry !== 'publish.lock')
        if (unrelated.length > 0) {
          throw new FsqliteError(
            'refused',
            `refusing to initialize an unmarked non-empty directory: ${unrelated.join(', ')}; ` +
              `choose an empty directory or an existing store with ${STORE_MARKER_FILENAME}`,
          )
        }
        marker = createStoreMarker(this.dir)
      }

      this.createStoreDirs()
      if (existsSync(this.currentPath)) {
        return
      } // another initializer won while we waited
      // A snapshot can survive an interrupted first open or a later loss of `current`.
      // Repair selects a recovery point without overwriting that snapshot.
      const lineage = this.snapshotVersions()
      if (lineage.length > 0) {
        throw missingPointerError(lineage)
      }
      const tmp = `${this.snapshotPath(0)}.${rand()}.tmp`
      try {
        const db = driver.open(tmp)
        try {
          db.exec(`PRAGMA application_id = ${FSQLITE_APPLICATION_ID};`)
          db.exec(`PRAGMA user_version = ${this.schemaVersion};`)
          db.exec(LEDGER_DDL)
          db.exec(META_DDL)
          const stamp = db.prepare('INSERT INTO fsqlite_meta (key, value) VALUES (?, ?)')
          stamp.run('schema_hash', this.schemaHash)
          stamp.run('tool_version', this.toolVersion)
          stamp.run('format_version', STORE_FORMAT_VERSION)
          stamp.run('store_id', marker.store_id)
          db.exec(this.schema)
          validatePrimaryKeys(db)
          this.assertStrategySchema(db)
        } finally {
          db.close()
        }
        fsyncPath(tmp)
        if (existsSync(this.currentPath)) {
          rmSync(tmp, { force: true })
          return
        }
        if (!lease.fence()) {
          throw new FsqliteError(
            'retryable',
            'init lost ownership of publish.lock before snapshot publication',
          )
        }
        try {
          linkSync(tmp, this.snapshotPath(0)) // commit without replacing (spec F5c)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw missingPointerError([0])
          }
          throw error
        }
        unlinkSync(tmp)
        fsyncDir(this.snapDir)
        if (!lease.fence()) {
          throw new FsqliteError(
            'retryable',
            'init lost ownership of publish.lock before pointer publication',
          )
        }
        publishPointer(this.dir, this.currentPath, 0)
      } catch (e) {
        removeQuietly(tmp)
        throw e
      }
    })
    this.verifyCompatible()
    return this
  }

  /**
   * Create any missing store subdirectory and fsync the parent of every directory created,
   * deepest first, so a power loss cannot drop `tx/pending` or `leases/` from a store whose
   * marker and pointer survived (spec section 10).
   */
  private createStoreDirs(): void {
    const parents = new Set<string>()
    for (const d of [
      this.snapDir,
      this.txPending,
      this.txApplied,
      this.txQuarantine,
      this.leaseDir,
    ]) {
      const first = mkdirSync(d, { recursive: true }) // the topmost directory it created
      if (first === undefined) {
        continue
      }
      for (let created = d; created !== dirname(created); created = dirname(created)) {
        parents.add(dirname(created))
        if (resolve(created) === resolve(first)) {
          break
        }
      }
    }
    const deepestFirst = [...parents].sort((a, b) => b.length - a.length)
    for (const parent of deepestFirst) {
      fsyncDir(parent)
    }
  }

  /**
   * Confirm an existing store's stamped identity matches this handle's configuration, so opening
   * a store with the wrong schema fails loudly instead of silently. Checks application_id and
   * user_version (the foreign-readable capability pragmas) and the stamped schema_hash, which
   * catches divergent caller DDL even when the caller forgets to increment schema_version.
   */
  private verifyCompatible(): void {
    const marker = readStoreMarker(this.dir)
    const db = this.openCurrent()
    try {
      verifySnapshotForPublish(db, marker, this.schemaVersion, this.schemaHash)
      this.assertStrategySchema(db)
      this.assertPolicyTables(db)
    } finally {
      db.close()
    }
  }

  /**
   * Refuse a conflict policy that routes a table the store's schema does not declare: a
   * misspelled key would otherwise fall back to the `'*'` action silently. DirectStore,
   * which applies no changesets, overrides this.
   */
  /** @internal */
  protected assertPolicyTables(db: driver.DB): void {
    const callerTables = new Set(
      (
        db
          .prepare(
            "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !(driver.OWNED_TABLES as readonly string[]).includes(name)),
    )
    const unknown = Object.keys(this.conflictPolicy).filter(
      (table) => table !== '*' && !callerTables.has(table),
    )
    if (unknown.length === 0) {
      return
    }
    const named = unknown.map((table) => `"${table}"`).join(', ')
    throw new FsqliteError(
      'incompatible',
      unknown.length === 1
        ? `conflictPolicy names table ${named}, which is not a caller table in this store's ` +
            "schema; a misspelled key falls back to the '*' action silently, so fix or remove it"
        : `conflictPolicy names tables ${named}, which are not caller tables in this store's ` +
            "schema; a misspelled key falls back to the '*' action silently, so fix or remove them",
    )
  }

  /**
   * Reject caller-schema features this write strategy cannot carry (spec S4). Changeset
   * apply fires triggers again and resolves key clashes by any declared REPLACE or IGNORE
   * clause, so a SnapshotStore schema may declare neither; DirectStore, which runs its
   * callback on the build directly, overrides this.
   */
  /** @internal */
  protected assertStrategySchema(db: driver.DB): void {
    rejectCallerTriggers(db)
    rejectKeyConflictResolution(db)
  }

  /** Refuse store operations if the marker and published snapshot do not identify the same store. */
  private assertStoreIdentity(): void {
    const marker = readStoreMarker(this.dir)
    const db = this.openCurrent()
    try {
      verifySnapshotIdentity(db, marker)
    } finally {
      db.close()
    }
  }

  /** The path of snapshot `v`, whether or not it exists. */
  snapshotPath(v: number): string {
    return join(this.snapDir, `${pad(v)}.fsqlite.sqlite`)
  }

  /** Open the snapshot `current` names read-only; see {@link withCurrentSnapshot}. */
  private openCurrent(): driver.DB {
    return this.withCurrentSnapshot((path) => driver.openReadonly(path)).result
  }

  /**
   * Run `step` on the snapshot `current` names. When the step fails because that snapshot
   * no longer exists and `current` has moved, gc collected it after a newer publication,
   * so the pointer is read again (spec section 13). A pointer that still names a missing
   * snapshot is corruption.
   */
  private withCurrentSnapshot<R>(step: (path: string) => R): { version: number; result: R } {
    for (let attempt = 0; ; attempt++) {
      const version = this.currentVersion()
      beforeSnapshotOpenHook?.(version)
      const path = this.snapshotPath(version)
      try {
        return { version, result: step(path) }
      } catch (error) {
        if (existsSync(path)) {
          throw error
        }
        if (this.currentVersion() === version) {
          throw new FsqliteError('corrupt', `current points at missing snapshot ${version}`, {
            cause: error,
          })
        }
        if (attempt >= COLLECTED_SNAPSHOT_RETRIES) {
          throw new FsqliteError(
            'retryable',
            `the snapshot current named was collected before it could be opened ` +
              `${attempt + 1} times in a row (excessive publish and gc contention)`,
            { cause: error },
          )
        }
      }
    }
  }

  /**
   * The published version the `current` pointer names. Parsed strictly: an empty or
   * non-numeric pointer is corruption (R2) and throws rather than silently reading as
   * version 0 (the empty snapshot); `Number('')` would be 0, masking a torn pointer. At
   * most {@link MAX_POINTER_BYTES} are read, and a digit string too long to be a safe
   * integer is corruption too.
   */
  currentVersion(): number {
    readStoreMarker(this.dir)
    const text = readPointerText(this.currentPath)
    const digits = POINTER_PATTERN.exec(text)?.[1]
    const version = digits === undefined ? Number.NaN : Number(digits)
    if (!Number.isSafeInteger(version)) {
      throw new FsqliteError('corrupt', `corrupt current pointer: ${quotePointer(text)}`)
    }
    return version
  }

  /**
   * Run `fn` against the immutable snapshot named by `current`, opened read-only on a fresh
   * connection (close-to-open, so a concurrent publish is observed and never torn). Needs no
   * session extension; any SQLite binding can read the same file. A snapshot gc collects
   * between the pointer read and the open is retried against the newer head (spec section
   * 13). The connection closes when `fn` returns, so `fn` must not return a lazy handle
   * such as a `stmt.iterate()` iterator.
   */
  read<T>(fn: ReadFn<T>): T {
    const marker = readStoreMarker(this.dir)
    const db = this.openCurrent()
    try {
      verifySnapshotIdentity(db, marker)
      return fn(db)
    } finally {
      db.close()
    }
  }

  /**
   * Pin the current version while holding the publication lock, so gc cannot hide its
   * pathname between the lease's publication and return. Release the disposable lease
   * after the packager or uploader finishes reading.
   */
  readLease({
    maxRetries = DEFAULT_READ_LEASE_RETRIES,
    lockOpts = {},
  }: ReadLeaseOptions = {}): ReadLease {
    requireSafeInteger('maxRetries', maxRetries, 0)
    validateLockOptions(lockOpts)
    this.assertStoreIdentity()
    return withLock(this.publishLock, () => this.claimReadLease(maxRetries), lockOpts)
  }

  /** Publish and verify the pin while gc is excluded by the publication lock. */
  private claimReadLease(maxRetries: number): ReadLease {
    for (let attempt = 0; ; attempt++) {
      const version = this.currentVersion()
      const token = `${pad(Date.now())}-${rand()}`
      const path = join(this.leaseDir, `${token}.lease`)
      const tempPath = `${path}.${rand()}.tmp`
      try {
        writeFileSync(
          tempPath,
          JSON.stringify({ version, pid: process.pid, host: hostname(), at: Date.now() }),
          { flag: 'wx' },
        )
        fsyncPath(tempPath)
        renameSync(tempPath, path)
        fsyncDir(this.leaseDir)
      } catch (error) {
        removeQuietly(tempPath)
        throw new FsqliteError('io', `readLease: failed to publish lease ${path}`, {
          cause: error,
        })
      }
      if (existsSync(this.snapshotPath(version))) {
        return this.lease(version, path)
      }
      rmSync(path, { force: true }) // lost the race to gc; drop the stale lease and retry
      if (attempt >= maxRetries) {
        throw new FsqliteError(
          'retryable',
          `readLease: snapshot ${version} was collected under contention after ${attempt} retries`,
        )
      }
    }
  }

  private lease(version: number, path: string): ReadLease {
    const release = (): void => {
      try {
        rmSync(path, { force: true }) // an already-dropped pin is fine
      } catch (error) {
        throw new FsqliteError(
          'io',
          `could not release the read lease on snapshot ${version} (${path}); gc keeps ` +
            'that snapshot until the lease goes stale',
          { cause: error },
        )
      }
    }
    return {
      version,
      heartbeat: () => {
        const now = new Date()
        try {
          utimesSync(path, now, now)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new FsqliteError(
              'refused',
              `read lease on snapshot ${version} was lost (released, or reaped by gc as ` +
                'stale); take a new lease before reading further',
              { cause: error },
            )
          }
          throw error
        }
      },
      release,
      [Symbol.dispose]: release,
    }
  }

  /**
   * Lock-free write: capture `fn`'s mutations as a uniquely-named changeset envelope and
   * commit it to the pending tail. Mutates no live state; the change becomes visible only
   * when a later `reconcile()` folds it in. Returns the tx id, or null if `fn` changed nothing.
   *
   * The writer copies the current immutable snapshot so the callback observes the same
   * rows and constraints its changeset is based on. The O(snapshot size) cost is an
   * explicit part of the alpha operating envelope.
   */
  write(writerId: string, fn: WorkFn): string | null {
    if (!SAFE_WRITER_ID.test(writerId)) {
      throw new TypeError(
        `invalid writerId ${JSON.stringify(writerId)}: must match ${String(SAFE_WRITER_ID)}`,
      )
    }
    this.verifyCompatible()
    driver.requireWriterCapabilities() // loud failure here beats a silent empty changeset
    const marker = readStoreMarker(this.dir)
    const work = join(this.txPending, `.work-${writerId}-${rand()}.sqlite`)
    // SAFE: the source snapshot is immutable.
    const base = this.withCurrentSnapshot((path) => {
      copyFileSync(path, work)
    }).version
    let changeset: Uint8Array | null
    const db = driver.openWorkingCopy(work)
    try {
      driver.protectOwnedTables(db)
      const boundary = driver.captureCallbackBoundary(db)
      changeset = driver.recordChangeset(db, (callbackDb) => {
        fn(callbackDb)
        driver.assertCallbackBoundary(callbackDb, boundary)
      })
    } finally {
      db.close()
      rmSync(work, { force: true })
    }
    if (!changeset) {
      return null
    }

    const txId = `${pad(Date.now())}-${pad(this.clock++)}-${writerId}-${rand()}`
    const txDir = join(this.txPending, `${txId}.txn`)
    mkdirSync(txDir, { recursive: true })
    writeFileSync(join(txDir, CHANGESET_FILENAME), changeset)
    const manifest: Manifest = {
      tx_id: txId,
      format_version: marker.format_version,
      store_id: marker.store_id,
      writer_id: writerId,
      base_version: base,
      schema_version: this.schemaVersion,
      schema_hash: this.schemaHash,
      created_at: nowIso(),
      changeset: CHANGESET_FILENAME,
      changeset_sha256: sha256(changeset),
      tool_version: this.toolVersion,
    }
    writeFileSync(join(txDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(join(txDir, 'COMMITTED'), '') // COMMITTED marker written last, so visibility is atomic
    return txId
  }

  /**
   * Per-transaction OPTIMISTIC RETRY (granular OCC): runs `fn` against a fresh seed
   * from the current snapshot, reconciles, and, if `fn`'s changes conflicted with a
   * concurrently-published row under a 'strict' table, re-seeds and re-runs `fn`, up
   * to `maxRetries`. The classic read-modify-write compare-and-retry loop; prevents a
   * lost update on a strict row without any global lock.
   *
   * If reconcile throws, the published ledger decides: when it already holds this
   * transaction (reconcile failed after publishing it), the call returns success, so `fn`
   * never runs again for a published transaction. When the envelope is still pending, the
   * call throws a {@link TransactionError} with code `pending` and the reconcile error as
   * its `cause`: a later reconcile folds that envelope, so running the write again would
   * apply its change twice. Reconcile and check the ledger for `txId` instead.
   */
  writeWithRetry(
    writerId: string,
    fn: WorkFn,
    { maxRetries = DEFAULT_WRITE_RETRIES }: WriteWithRetryOptions = {},
  ): WriteWithRetryResult {
    requireSafeInteger('maxRetries', maxRetries, 1)
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const txId = this.write(writerId, fn)
      if (txId === null) {
        return { txId: null, attempts: attempt + 1, conflicted: false }
      }
      const quarantinePath = join(this.txQuarantine, `${txId}.txn`, 'QUARANTINE')
      let reconcileError: unknown = null
      try {
        this.reconcile() // idempotent and OCC-safe; folds ours and any peers'
      } catch (error) {
        reconcileError = error
      }
      let published: boolean
      try {
        published = this.isPublished(txId)
      } catch (error) {
        throw this.unknownTransactionOutcome(
          txId,
          reconcileError === null
            ? error
            : new AggregateError(
                [reconcileError, error],
                'reconcile and outcome inspection failed',
              ),
        )
      }
      if (published) {
        return { txId, attempts: attempt + 1, conflicted: attempt > 0 }
      }
      if (!existsSync(quarantinePath)) {
        throw this.unsettledTransaction(txId, reconcileError)
      }
      let reason: string
      try {
        reason = readFileSync(quarantinePath, 'utf8')
      } catch (error) {
        throw this.unknownTransactionOutcome(txId, error)
      }
      const reasonCode = quarantineReasonCode(reason)
      if (reasonCode !== 'strict-conflict') {
        throw new TransactionError(
          reasonCode === 'permanent-conflict' ? 'conflict' : 'refused',
          txId,
          `writeWithRetry: transaction ${txId} permanently quarantined: ${reason}`,
          reason,
        )
      }
      // A strict same-row conflict is retryable: re-seed and re-run fn.
    }
    throw new FsqliteError(
      'retryable',
      `writeWithRetry: exceeded retries after ${maxRetries} attempts (persistent strict conflict)`,
    )
  }

  /**
   * The error for a captured transaction that is neither published nor quarantined: still
   * pending (`pending`, after a reconcile `failure` or a reconcile that left it for the
   * next one), or gone from every envelope directory (`corrupt`).
   */
  private unsettledTransaction(txId: string, failure: unknown): TransactionError {
    const options = failure === null ? {} : { cause: failure }
    if (existsSync(join(this.txPending, `${txId}.txn`))) {
      const why =
        failure === null
          ? 'reconcile left it pending'
          : `reconcile failed before publishing it (${errorMessage(failure)})`
      return new TransactionError(
        'pending',
        txId,
        `writeWithRetry: transaction ${txId} is captured but not published: ${why}; a later ` +
          'reconcile folds it, so do not run the write again',
        null,
        options,
      )
    }
    return new TransactionError(
      'corrupt',
      txId,
      `writeWithRetry: transaction ${txId} has no published, pending, or quarantined outcome`,
      null,
      options,
    )
  }

  /** A captured envelope must never become a retryable write merely because inspection failed. */
  private unknownTransactionOutcome(txId: string, cause: unknown): TransactionError {
    return new TransactionError(
      'outcome-unknown',
      txId,
      `writeWithRetry: transaction ${txId} was captured but its outcome could not be read; ` +
        'inspect its published or quarantined outcome before proceeding; do not run the write again',
      null,
      { cause },
    )
  }

  /** Whether the head `current` names holds `txId` in its ledger. */
  private isPublished(txId: string): boolean {
    return this.read((db) =>
      Boolean(db.prepare('SELECT 1 FROM applied_tx WHERE tx_id = ?').get(txId)),
    )
  }

  /** Committed pending transaction dirs, in deterministic (txid) order. */
  pendingTxns(): string[] {
    if (!existsSync(this.txPending)) {
      return []
    }
    return readdirSync(this.txPending)
      .filter((d) => d.endsWith('.txn') && existsSync(join(this.txPending, d, 'COMMITTED')))
      .sort()
  }

  /**
   * Fold the committed pending tail into the next immutable snapshot and publish it with an
   * atomic pointer swap under the lease lock. Idempotent (skips tx already in the snapshot's
   * `applied_tx` ledger) and conflict-resolving per the merge policy (clashes are quarantined,
   * not lost). Safe to run concurrently: optimistic concurrency on `current` makes a superseded
   * builder retry.
   *
   * A {@link PostPublishError} was raised after
   * the new version became current, for example while moving envelopes (spec F6); the data
   * is published and the leftovers are settled by the next reconcile. Any other error means
   * this call published nothing.
   */
  reconcile({
    maxRetries = DEFAULT_RECONCILE_RETRIES,
    lockOpts = {},
  }: ReconcileOptions = {}): ReconcileResult {
    requireSafeInteger('maxRetries', maxRetries, 1)
    validateLockOptions(lockOpts)
    const marker = readStoreMarker(this.dir)
    const crashAt = reconcileCrashAtForTest
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const base = this.currentVersion()
      this.verifyCompatible()
      const pending = this.pendingTxns()
      if (pending.length === 0) {
        return { published: base, applied: 0, quarantined: 0, attempts: attempt + 1 }
      }

      const tmp = join(this.snapDir, `.build-${rand()}.sqlite`)
      let fold: FoldResult
      let result: CommitOutcome | 'nothing-applied'
      // A crash seam models a dead process, which runs no cleanup.
      let crashed = false
      try {
        fold = this.fold(tmp, base, pending, marker)
        if (fold.applied.length === 0) {
          result = 'nothing-applied'
        } else {
          if (crashAt === 'after-build') {
            crashed = true
            throw new Error('CRASH after-build')
          } // tmp orphaned; current unchanged
          result = this.publishBuild(tmp, base, lockOpts, crashAt)
        }
      } finally {
        // Every exit before or from the publish step discards the build. Once committed,
        // the build has no `.build-` name left, so this only ever removes an uncommitted
        // transient, never a committed or published snapshot.
        if (!crashed) {
          removeQuietly(tmp)
        }
      }
      if (result === 'retry') {
        continue
      }
      if (result === 'nothing-applied') {
        const settled = this.settle(fold.applied, fold.archivable, fold.quarantined)
        return {
          published: base,
          applied: 0,
          quarantined: settled.quarantined,
          attempts: attempt + 1,
        }
      }
      const next = base + 1
      if (crashAt === 'after-pointer') {
        throw new Error('CRASH after-pointer')
      } // published; tx not yet archived

      let settled: { applied: number; quarantined: number }
      try {
        settled = this.settle(fold.applied, fold.archivable, fold.quarantined)
      } catch (error) {
        throw new PostPublishError(next, error)
      }
      return {
        published: next,
        applied: settled.applied,
        quarantined: settled.quarantined,
        attempts: attempt + 1,
      }
    }
    throw new FsqliteError(
      'retryable',
      `reconcile exceeded retries after ${maxRetries} attempts (excessive publish contention)`,
    )
  }

  /**
   * F2-F4: copy the base to the `tmp` build, fold the committed `pending` envelopes into it
   * in order, and run the pre-publication gates. Each envelope is applied, found archivable
   * (already in the base lineage), or quarantined with a reason; one bad envelope never
   * aborts the batch. A gate failure throws, and the caller discards the build.
   */
  private fold(tmp: string, base: number, pending: string[], marker: StoreMarker): FoldResult {
    copyFileSync(this.snapshotPath(base), tmp)
    const applied: string[] = []
    const archivable: string[] = []
    const quarantined: [string, string][] = []
    const db = driver.openBuild(tmp)
    try {
      const seen = new Set(
        (db.prepare('SELECT tx_id FROM applied_tx').all() as Record<string, unknown>[]).map((r) =>
          String(r.tx_id),
        ),
      )
      const mark = db.prepare('INSERT INTO applied_tx (tx_id, applied_at) VALUES (?, ?)')
      for (const txn of pending) {
        const txId = txIdOf(txn)
        if (seen.has(txId)) {
          archivable.push(txn)
          continue
        } // already in this lineage
        const admitted = this.admitEnvelope(txn, marker)
        if (typeof admitted === 'string') {
          quarantined.push([txn, admitted])
          continue
        }
        try {
          applyWithPolicy(db, admitted.changeset, this.conflictPolicy, () => {
            mark.run(admitted.manifest.tx_id, nowIso())
          })
          applied.push(txn)
          seen.add(txId)
        } catch (e) {
          // A genuine conflict aborted the apply (policy returned ABORT) or some other
          // apply error. Quarantine the tx; do not poison the whole batch.
          quarantined.push([txn, applyFailureReason(e)])
        }
      }
      verifySnapshotForPublish(db, marker, this.schemaVersion, this.schemaHash)
      driver.quickCheck(db)
    } finally {
      db.close()
    }
    return { applied, archivable, quarantined }
  }

  /**
   * F3 admission: read envelope `txn` and check it against the store and this handle. Returns
   * its changeset and manifest, or the quarantine reason.
   */
  private admitEnvelope(
    txn: string,
    marker: StoreMarker,
  ): { changeset: Uint8Array; manifest: Manifest } | string {
    const txDir = join(this.txPending, txn)
    let csSize = 0
    try {
      csSize = statSync(join(txDir, CHANGESET_FILENAME)).size
    } catch {
      /* missing/unreadable is handled by the read below */
    }
    if (csSize > this.maxEnvelopeBytes) {
      return `envelope-too-large: ${csSize} > ${this.maxEnvelopeBytes}`
    }
    let cs: Uint8Array
    let parsed: unknown
    try {
      cs = readFileSync(join(txDir, CHANGESET_FILENAME))
      parsed = JSON.parse(readFileSync(join(txDir, 'manifest.json'), 'utf8'))
    } catch {
      return 'unreadable-envelope'
    }
    // Valid JSON that is not an object (`null`, an array, a string) has no fields to check;
    // reading one from `null` would throw out of the whole reconcile.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'malformed-manifest'
    }
    const man = parsed as Manifest
    if (sha256(cs) !== man.changeset_sha256) {
      return 'digest-mismatch'
    }
    if (man.format_version !== marker.format_version) {
      return 'format-version-mismatch'
    }
    if (man.tx_id !== txIdOf(txn)) {
      return 'tx-id-mismatch'
    }
    if (man.store_id !== marker.store_id) {
      return 'store-id-mismatch'
    }
    if (man.changeset !== CHANGESET_FILENAME) {
      return 'changeset-filename-mismatch'
    }
    if (man.schema_version !== this.schemaVersion) {
      return 'schema-version-mismatch'
    }
    if (man.schema_hash !== this.schemaHash) {
      return 'schema-hash-mismatch'
    }
    return { changeset: cs, manifest: man }
  }

  /**
   * F5: fsync the build, then commit it as `base + 1` and swap the pointer under the publish
   * lock. Returns `retry` when another publisher won or this one was fenced out.
   */
  private publishBuild(
    tmp: string,
    base: number,
    lockOpts: LockOptions,
    crashAt: CrashAt,
  ): CommitOutcome {
    const next = base + 1
    fsyncPath(tmp) // complete slow durability work before acquiring the publication lease
    return withLock(
      this.publishLock,
      (_token, lease): CommitOutcome => {
        if (this.currentVersion() !== base) {
          return 'retry'
        } // someone published while we built
        if (!lease.fence()) {
          return 'retry'
        } // lost ownership (stale break): fencing
        return commitSnapshot({
          storeDir: this.dir,
          currentPath: this.currentPath,
          snapDir: this.snapDir,
          build: tmp,
          dest: this.snapshotPath(next),
          base,
          next,
          readCurrent: () => this.currentVersion(),
          lease,
          afterLink:
            crashAt === 'after-snapshot'
              ? () => {
                  throw new Error('CRASH after-snapshot')
                }
              : undefined,
        })
      },
      lockOpts,
      (error, outcome) => (outcome === 'published' ? new PostPublishError(next, error) : error),
    )
  }

  /**
   * Delete superseded snapshots, always keeping `current`, every version >= current - retain
   * (current plus its `retain` predecessors under spec G1), and any version pinned by a live
   * read-lease (leases past `leaseStaleMs` are treated as abandoned). Also sweeps *stale*
   * transients but never fresh ones, which may be a live reconcile or DirectStore build in
   * another process (spec G3); `transientStaleMs` gates that.
   *
   * gc is destructive maintenance, so it fails closed (spec G0): invalid options throw a
   * TypeError, a store that does not validate is refused, no snapshot is deleted unless
   * the head passed the full integrity check (its older snapshots may be the only recovery
   * points repair has), and every deletion runs under the publish lock with a fenced
   * token, so gc never interleaves with repair.
   *
   * The integrity check reads the whole head, so it runs only when some snapshot is old
   * enough to delete. A call that would delete nothing still checks recognition, the
   * pointer, the head's identity, and its lineage, and still requires `current` under the
   * lock to equal the head it checked. It then sweeps stale transients other than gc
   * tombstones, which hold a predecessor's bytes; snapshots that become collectable after
   * that check, and those tombstones, wait for a call that runs the full check.
   */
  gc({
    retain = DEFAULT_RETAINED_SNAPSHOTS,
    leaseStaleMs = DEFAULT_LEASE_STALE_MS,
    transientStaleMs = DEFAULT_TRANSIENT_STALE_MS,
    lockOpts = {},
  }: GcOptions = {}): GcResult {
    requireSafeInteger('gc option retain', retain, 0)
    requireSafeInteger('gc option leaseStaleMs', leaseStaleMs, 1)
    requireSafeInteger('gc option transientStaleMs', transientStaleMs, 1)
    validateLockOptions(lockOpts)
    // Validate outside the lock: the integrity check reads the whole head and must not
    // stall publishers. A recognition failure is refused before the lock dir is created.
    // The full check runs only when there is a snapshot to delete, and the store is
    // classified once either way: each pass looks up every archived transaction. A wrong
    // guess here only costs work: `collect` false deletes nothing, and the floor and the
    // `current`-moved check below both use the head the classification checked.
    let collect = false
    try {
      const head = this.currentVersion()
      collect = this.snapshotVersions().some((v) => v < head - retain)
    } catch {
      // A recognition failure or an unreadable pointer: the classification reports it.
    }
    const health = collect ? this.validate() : this.classify(false)
    if (!GC_SAFE_STATES.has(health.state) || health.current === undefined) {
      const message =
        `gc refused: store is ${health.state}: ${health.issues.join('; ')}; ` +
        'run validate and repair before collecting snapshots'
      throw isRecognitionFailure(health.state)
        ? new StoreFormatError(health.state, message)
        : new FsqliteError('corrupt', message)
    }
    const validated = health.current
    return withLock(
      this.publishLock,
      (_token, lease) =>
        this.gcLocked(lease, validated, collect, retain, leaseStaleMs, transientStaleMs),
      lockOpts,
    )
  }

  /**
   * `validated` is the head gc checked. `collect` is whether that check was the full one,
   * run because some snapshot was old enough to delete; without it gc deletes no snapshot
   * and sweeps no tombstone, only the other stale transients. The result reports it as
   * `integrityChecked`.
   */
  private gcLocked(
    lease: LockLease,
    validated: number,
    collect: boolean,
    retain: number,
    leaseStaleMs: number,
    transientStaleMs: number,
  ): GcResult {
    const fence = (): void => {
      if (!lease.fence()) {
        throw new FsqliteError('retryable', 'gc lost ownership of publish.lock before deletion')
      }
    }
    fence()
    const cur = this.currentVersion()
    // The full integrity verdict applies only to the head that was validated.
    if (cur !== validated) {
      throw new FsqliteError(
        'retryable',
        `gc refused: current moved from ${validated} to ${cur} after validation; run gc again`,
      )
    }
    const leased = this.activeLeasedVersions(leaseStaleMs)
    const versions = this.snapshotVersions()
    const keepFloor = cur - retain
    let removed = 0
    for (const v of versions) {
      if (!collect || v === cur || v >= keepFloor || leased.has(v)) {
        continue
      }
      // Re-scan leases right before the tombstone: a reader may have claimed v after we
      // computed `leased` (readLease publishes the lease before reading).
      if (this.activeLeasedVersions(leaseStaleMs).has(v)) {
        continue
      }
      fence()
      if (this.collectSnapshot(v, leaseStaleMs)) {
        removed++
      } else {
        leased.add(v)
      }
    }
    // Sweep stale transients only. A fresh .build-/.direct-/.work- file may be
    // a live build in another process. Deleting it would not corrupt anything because the
    // publish would fail loudly and retry, but it would waste work. mtime age gates the sweep.
    const sweepStaleTransients = (dir: string): void => {
      if (!existsSync(dir)) {
        return
      }
      for (const f of readdirSync(dir)) {
        if (!isTransientFile(f) || (!collect && isGcTombstone(f))) {
          continue
        }
        const p = join(dir, f)
        try {
          if (Date.now() - statSync(p).mtimeMs > transientStaleMs) {
            rmSync(p, { recursive: true, force: true })
          }
        } catch {
          /* ignore */
        }
      }
    }
    fence()
    for (const dir of this.transientDirs()) {
      sweepStaleTransients(dir)
    }
    return {
      removed,
      kept: versions.length - removed,
      leased: [...leased],
      integrityChecked: collect,
    }
  }

  /**
   * Two-phase unlink (spec G2): rename snapshot `v` to a `.gc-` tombstone, re-scan leases,
   * then either unlink the tombstone or, if a lease on `v` appeared, move it back. A check
   * followed by an unlink cannot close the race with RL1, because a reader can publish its
   * lease and pass its existence check between the two. After the rename the reader's check
   * fails and it retries; a lease published before the rename is visible to the re-scan.
   * Returns true if the snapshot was deleted, false if a lease kept it.
   */
  private collectSnapshot(v: number, leaseStaleMs: number): boolean {
    const path = this.snapshotPath(v)
    const tombstone = join(this.snapDir, `.gc-${pad(v)}-${rand()}.tmp`)
    const restore = (): void => {
      linkSync(tombstone, path) // never replace a snapshot name
      unlinkSync(tombstone)
    }
    try {
      renameSync(path, tombstone)
    } catch (error) {
      throw new FsqliteError('io', `gc failed to remove snapshot ${v} (${path})`, {
        cause: error,
      })
    }
    let leasedNow: boolean
    try {
      leasedNow = this.activeLeasedVersions(leaseStaleMs).has(v)
    } catch (error) {
      // Fail closed: an unreadable lease must not cost the snapshot it may pin.
      try {
        restore()
      } catch (restoreError) {
        throw new FsqliteError(
          'io',
          `gc could not restore snapshot ${v} from its tombstone ${tombstone} after a lease ` +
            `re-scan failed (${errorMessage(error)}); rename the tombstone back to ${path} ` +
            'before running gc again',
          { cause: new AggregateError([error, restoreError]) },
        )
      }
      throw error
    }
    if (leasedNow) {
      restore()
      return false
    }
    try {
      unlinkSync(tombstone)
    } catch (error) {
      throw new FsqliteError('io', `gc failed to remove snapshot ${v} (${path})`, {
        cause: error,
      })
    }
    return true
  }

  private activeLeasedVersions(staleMs: number): Set<number> {
    const out = new Set<number>()
    if (!existsSync(this.leaseDir)) {
      return out
    }
    for (const f of readdirSync(this.leaseDir)) {
      if (!f.endsWith('.lease')) {
        continue
      }
      const p = join(this.leaseDir, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > staleMs) {
          rmSync(p, { force: true })
          continue
        }
        const value: unknown = JSON.parse(readFileSync(p, 'utf8'))
        const version =
          typeof value === 'object' && value !== null && 'version' in value
            ? value.version
            : undefined
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
          throw new FsqliteError('corrupt', 'lease version must be a non-negative safe integer')
        }
        out.add(version)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw new FsqliteError(
          'retryable',
          `gc refused: fresh lease ${f} is unreadable (in ${this.leaseDir})`,
          { cause: error },
        )
      }
    }
    return out
  }

  /**
   * Classify store health from on-disk layout without trusting any single file: detects a
   * missing/torn pointer, an orphan snapshot ahead of `current`, transient build files, a held
   * lock, and live `-wal`/`-shm` side files. Surfaces every inconsistency (R2) as a
   * {@link StoreState} plus issues, rather than silently accepting it.
   */
  validate(): ValidateResult {
    return this.classify(true)
  }

  /**
   * {@link validate}'s classification. With `deep` false it skips the head's
   * `integrity_check` and `foreign_key_check`, the only steps that read the whole head,
   * and keeps every other check, including the head's identity and lineage.
   */
  private classify(deep: boolean): ValidateResult {
    const issues: string[] = []
    const recognition = recognizeStore(this.dir)
    if (recognition.state !== 'supported') {
      return { state: recognition.state, issues: [recognition.issue] }
    }
    const marker = recognition.marker
    // A peer archives only after publication. Observe the archive before the pointer so
    // newly archived transactions cannot be compared with an older, still valid head.
    const archived = this.archivedTransactions()
    if (!existsSync(this.currentPath)) {
      return { state: 'corrupt', issues: ['missing current pointer'] }
    }
    let cur: number
    try {
      cur = this.currentVersion()
    } catch {
      return { state: 'corrupt', issues: ['torn current pointer'] }
    }
    if (!existsSync(this.snapshotPath(cur))) {
      return { state: 'corrupt', issues: [`current points at missing snapshot ${cur}`] }
    }

    // In-flight tells.
    const snapFiles = existsSync(this.snapDir) ? readdirSync(this.snapDir) : []
    const transients = this.transientDirs().flatMap((dir) =>
      existsSync(dir) ? readdirSync(dir).filter(isTransientFile) : [],
    )
    if (transients.length) {
      issues.push(`transient build files present: ${transients.join(', ')}`)
    }
    const orphanAhead = snapFiles
      .map((f) => /^(\d+)\.fsqlite\.sqlite$/.exec(f)?.[1])
      .filter((x): x is string => Boolean(x))
      .map(Number)
      .filter((v) => v > cur)
    if (orphanAhead.length) {
      issues.push(`orphan snapshot(s) ahead of pointer: ${orphanAhead.join(', ')}`)
    }
    const lockHeld = existsSync(this.publishLock)
    if (lockHeld) {
      issues.push('publish.lock present (reconcile in progress or crashed)')
    }
    const uncommitted = existsSync(this.txPending)
      ? readdirSync(this.txPending).filter(
          (d) => d.endsWith('.txn') && !existsSync(join(this.txPending, d, 'COMMITTED')),
        )
      : []
    if (uncommitted.length) {
      issues.push(`uncommitted tx envelope(s): ${uncommitted.length}`)
    }
    const sideFiles = snapFiles.filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))
    if (sideFiles.length) {
      issues.push(`live SQLite side files present: ${sideFiles.join(', ')}`)
    }

    // Integrity of the current head.
    const db = driver.openReadonly(this.snapshotPath(cur))
    let problems: string[]
    let missingArchived: number
    try {
      try {
        verifySnapshotIdentity(db, marker)
      } catch (error) {
        return {
          state: 'corrupt',
          issues: [...issues, errorMessage(error)],
        }
      }
      problems = deep ? driver.integrityProblems(db) : []
      missingArchived = problems.length === 0 ? this.countMissingArchived(db, archived) : 0
    } finally {
      db.close()
    }
    if (problems.length) {
      return {
        state: 'corrupt',
        issues: [...issues, `snapshot ${cur} failed integrity validation: ${problems.join('; ')}`],
      }
    }
    if (missingArchived > 0) {
      return {
        state: 'corrupt',
        current: cur,
        issues: [
          ...issues,
          `${missingArchived} archived transaction(s) absent from the current ledger`,
        ],
      }
    }

    const pendingCommitted = this.pendingTxns().length
    if (
      transients.length ||
      orphanAhead.length ||
      lockHeld ||
      sideFiles.length ||
      uncommitted.length
    ) {
      return { state: 'in-flight-capture', current: cur, pending: pendingCommitted, issues }
    }
    if (pendingCommitted > 0) {
      return { state: 'live', current: cur, pending: pendingCommitted, issues }
    }
    return { state: 'sealed', current: cur, pending: 0, issues }
  }

  private archivedTransactions(): string[] {
    return existsSync(this.txApplied)
      ? readdirSync(this.txApplied).filter((entry) => entry.endsWith('.txn'))
      : []
  }

  private countMissingArchived(
    db: ReturnType<typeof driver.openReadonly>,
    archived: string[],
  ): number {
    const inLedger = db.prepare('SELECT 1 FROM applied_tx WHERE tx_id = ?')
    return archived.filter((entry) => !inLedger.get(txIdOf(entry))).length
  }

  /**
   * Finalize the current snapshot into a clean single-file at `destPath` via VACUUM INTO
   * (no -wal/-shm, integrity-checked). Requires an empty pending tail.
   *
   * The export is published like any completed file: VACUUM INTO writes a temp beside the
   * destination (it writes in place and never fsyncs), which is integrity-checked, fsynced,
   * linked to a new `destPath`, and followed by a directory fsync. The destination must not
   * exist, have SQLite sidecars, or lie anywhere inside the store. The no-replace link also
   * protects existing files reached through case aliases or a concurrent destination create.
   */
  seal(destPath: string): string {
    this.assertStoreIdentity()
    const pending = this.pendingTxns().length
    if (pending > 0) {
      throw new FsqliteError(
        'refused',
        `cannot seal: ${pending} pending transaction(s) must be reconciled first`,
      )
    }
    const destDir = dirname(resolve(destPath))
    if (this.isStoreOwnedPath(join(realpathSync(destDir), basename(destPath)))) {
      throw new FsqliteError(
        'refused',
        `cannot seal into ${destPath}: the destination is a path inside the store that the ` +
          'store owns; choose a new path outside the store',
      )
    }
    const refuseSidecars = (): void => {
      for (const suffix of ['-journal', '-wal', '-shm']) {
        if (existsSync(`${destPath}${suffix}`)) {
          throw new FsqliteError(
            'refused',
            `cannot seal: SQLite sidecar exists at ${destPath}${suffix}`,
          )
        }
      }
    }
    refuseSidecars()
    const tmp = join(destDir, `.${basename(destPath)}.${rand()}.tmp`)
    const lease = this.readLease()
    try {
      let db: driver.DB
      try {
        db = driver.openReadonly(this.snapshotPath(lease.version))
      } catch (error) {
        if (!existsSync(this.snapshotPath(lease.version))) {
          throw new FsqliteError(
            'refused',
            `cannot seal: snapshot ${lease.version} disappeared after the lease was claimed; ` +
              'the lease may have expired; start a new export',
            { cause: error },
          )
        }
        throw error
      }
      try {
        driver.vacuumInto(db, tmp)
      } catch (error) {
        if (driver.isSqliteCorruption(error)) {
          throw new FsqliteError(
            'corrupt',
            `cannot seal: snapshot ${lease.version} is corrupt (${errorMessage(error)}); ` +
              'run validate and repair',
            { cause: error },
          )
        }
        throw error
      } finally {
        db.close()
      }
      const out = driver.openReadonly(tmp)
      try {
        const problems = driver.integrityProblems(out)
        if (problems.length) {
          throw new FsqliteError(
            'corrupt',
            `sealed snapshot failed integrity validation: ${problems.join('; ')}`,
          )
        }
      } finally {
        out.close()
      }
      fsyncPath(tmp)
      refuseSidecars()
      try {
        linkSync(tmp, destPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FsqliteError(
            'refused',
            `cannot seal: destination already exists: ${destPath}`,
            {
              cause: error,
            },
          )
        }
        throw error
      }
      unlinkSync(tmp)
      fsyncDir(destDir)
    } catch (error) {
      removeQuietly(tmp)
      try {
        lease.release()
      } catch {
        // Keep the seal failure; the unreleased pin goes stale on its own.
      }
      throw error
    }
    lease.release()
    return destPath
  }

  /** Whether `path` lies anywhere inside this store. */
  private isStoreOwnedPath(path: string): boolean {
    const root = statSync(this.dir)
    // Compare directory identity rather than path spelling: case-insensitive filesystems
    // and symlink aliases can give the same store several textual names.
    let ancestor = dirname(path)
    for (;;) {
      const candidate = statSync(ancestor)
      if (candidate.dev === root.dev && candidate.ino === root.ino) {
        return true
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) {
        return false
      }
      ancestor = parent
    }
  }

  /**
   * doctor/repair: restore the last consistent point. Principled because every published
   * snapshot is immutable and was quick_check-validated at publish (R1). Use
   * {@link planRepair} to see the steps without taking them.
   */
  repair({ lockOpts = {} }: RepairOptions = {}): RepairResult {
    const marker = readStoreMarker(this.dir)
    this.refuseRepairUnderLiveLock(lockOpts)
    const actions = withLock(
      this.publishLock,
      (_token, lease) => {
        if (!lease.fence()) {
          throw repairLostOwnership()
        }
        const assertOwnership = (): void => {
          if (!lease.fence()) {
            throw repairLostOwnership()
          }
        }
        // Scanning every snapshot can outlast the stale window, so renew after each one.
        const renew = (): void => {
          if (!lease.heartbeat()) {
            throw repairLostOwnership()
          }
        }
        return this.repairSteps(marker, renew).map((step) => step.apply(assertOwnership))
      },
      lockOpts,
    )
    return { actions, state: this.recognizedState('repair ended with') }
  }

  /**
   * Report what {@link repair} would do now, without taking the publish lock or changing
   * any file: a dry run. It refuses exactly when repair would (an unrecognized store, a
   * live publisher lock, no clean recovery point), `actions` names each step repair would
   * take, and `state` is the store's state now. The store can change before a later repair.
   */
  planRepair({ lockOpts = {} }: RepairOptions = {}): RepairResult {
    const marker = readStoreMarker(this.dir)
    this.refuseRepairUnderLiveLock(lockOpts)
    const actions = this.repairSteps(marker, () => undefined).map((step) => step.planned)
    return { actions, state: this.recognizedState('repair plan found') }
  }

  private refuseRepairUnderLiveLock(lockOpts: LockOptions): void {
    validateLockOptions(lockOpts)
    if (existsSync(this.publishLock)) {
      throw new FsqliteError(
        'in-flight',
        'repair refused: publish.lock is present; stop every store client on every host, ' +
          'verify none can resume, then remove the abandoned lock before repair',
      )
    }
  }

  /** The store's validated state, which repair and its plan require to be recognized. */
  private recognizedState(context: string): StoreState {
    const state = this.validate().state
    if (isRecognitionFailure(state)) {
      throw new StoreFormatError(state, `${context} an unrecognized store: ${state}`)
    }
    return state
  }

  /**
   * Scan the store without modifying it and list the steps that restore its last
   * consistent point (spec section 11). `renew` runs after each snapshot scan; each step's
   * `apply` revalidates ownership through the callback it is given before it mutates.
   */
  private repairSteps(marker: StoreMarker, renew: () => void): RepairStep[] {
    const steps: RepairStep[] = []
    const versions = this.snapshotVersions()
    const identityMatches = (v: number): boolean => {
      try {
        const db = driver.openReadonly(this.snapshotPath(v))
        try {
          verifySnapshotIdentity(db, marker)
          return true
        } finally {
          db.close()
        }
      } catch {
        return false
      } finally {
        renew()
      }
    }
    if (!versions.some(identityMatches)) {
      throw new FsqliteError(
        'corrupt',
        `repair: no snapshot matches the store identity in ${STORE_MARKER_FILENAME}`,
      )
    }
    const integrityOk = (v: number): boolean => {
      try {
        const db = driver.openReadonly(this.snapshotPath(v))
        try {
          verifySnapshotIdentity(db, marker)
          return driver.integrityCheck(db)
        } finally {
          db.close()
        }
      } catch {
        return false // a file that won't even open as SQLite is corrupt
      } finally {
        renew()
      }
    }

    // Determine the restored head, preferring the current pointer if its snapshot is valid.
    let cur: number | null = null
    try {
      cur = this.currentVersion()
    } catch {
      // A torn or unreadable pointer is what repair restores.
    }
    let good: number | null = null
    if (cur !== null && versions.includes(cur) && integrityOk(cur)) {
      good = cur
    } else {
      for (const v of [...versions].reverse()) {
        if (integrityOk(v)) {
          good = v
          break
        }
      }
      if (good === null) {
        throw new FsqliteError(
          'corrupt',
          'repair: no integrity-clean snapshot exists; every snapshot was left in place',
        )
      }
      const head = good
      steps.push({
        planned: `re-publish current -> ${head}`,
        apply: (assertOwnership) => {
          assertOwnership()
          publishPointer(this.dir, this.currentPath, head)
          return `re-published current -> ${head}`
        },
      })
    }

    if (cur === good) {
      // A clean but regressed head can make a previously published version look like an
      // orphan. Keep every recovery candidate if the current ledger disagrees with the archive.
      const db = driver.openReadonly(this.snapshotPath(good))
      try {
        if (this.countMissingArchived(db, this.archivedTransactions()) > 0) {
          throw new FsqliteError(
            'corrupt',
            'repair refused: archived transactions are absent from the current ledger; preserve the snapshots and archive for recovery',
          )
        }
      } finally {
        db.close()
      }
    }

    // Delete snapshots ahead of the restored pointer (rolled-back orphans) and transients.
    for (const v of versions) {
      if (v > good) {
        const kind = integrityOk(v) ? 'orphan' : 'corrupt'
        steps.push({
          planned: `remove ${kind} snapshot ${v}`,
          apply: (assertOwnership) => {
            assertOwnership()
            rmSync(this.snapshotPath(v), { force: true })
            return `removed ${kind} snapshot ${v}`
          },
        })
      }
    }
    for (const dir of this.transientDirs()) {
      if (!existsSync(dir)) {
        continue
      }
      for (const f of readdirSync(dir)) {
        if (isTransientFile(f)) {
          steps.push({
            planned: `remove transient ${f}`,
            apply: (assertOwnership) => {
              assertOwnership()
              rmSync(join(dir, f), { recursive: true, force: true })
              return `removed transient ${f}`
            },
          })
        }
      }
    }

    // Quarantine abandoned uncommitted envelopes (evidence kept). A writer adds
    // changeset.bin, manifest.json, and COMMITTED last (W4), so the envelope dir's mtime
    // marks its latest step; one younger than the transient stale window (G3's rule) may be
    // a live capture and is left alone.
    if (existsSync(this.txPending)) {
      for (const d of readdirSync(this.txPending)) {
        const pendingDir = join(this.txPending, d)
        if (!d.endsWith('.txn') || existsSync(join(pendingDir, 'COMMITTED'))) {
          continue
        }
        if (Date.now() - statSync(pendingDir).mtimeMs <= DEFAULT_TRANSIENT_STALE_MS) {
          const left = `fresh uncommitted ${d} (possibly a live capture)`
          steps.push({ planned: `leave ${left}`, apply: () => `left ${left}` })
          continue
        }
        steps.push({
          planned: `quarantine uncommitted ${d}`,
          apply: (assertOwnership) => this.quarantineUncommitted(d, assertOwnership),
        })
      }
    }
    return steps
  }

  /** Move abandoned uncommitted envelope `d` to quarantine; returns the action taken. */
  private quarantineUncommitted(d: string, assertOwnership: () => void): string {
    const pendingDir = join(this.txPending, d)
    assertOwnership()
    writeFileSync(join(pendingDir, 'QUARANTINE'), 'uncommitted-at-repair')
    assertOwnership()
    this.move([d], this.txQuarantine)
    // A writer can still write COMMITTED between the plan's check and the move. Its write
    // either landed in the moved dir, seen here, or failed with ENOENT and the writer
    // reported failure, so this check after the move has no race window.
    const movedDir = join(this.txQuarantine, d)
    if (existsSync(join(movedDir, 'COMMITTED'))) {
      rmSync(join(movedDir, 'QUARANTINE'), { force: true })
      renameSync(movedDir, pendingDir)
      return `kept ${d}, which committed during repair`
    }
    return `quarantined uncommitted ${d}`
  }

  /** Every directory that can hold transients (spec section 2), for validate, gc, and repair. */
  private transientDirs(): string[] {
    return [this.dir, this.snapDir, this.txPending, this.leaseDir]
  }

  /** Published snapshot versions in ascending order. */
  snapshotVersions(): number[] {
    if (!existsSync(this.snapDir)) {
      return []
    }
    return readdirSync(this.snapDir)
      .map((f) => /^(\d+)\.fsqlite\.sqlite$/.exec(f)?.[1])
      .filter((x): x is string => Boolean(x))
      .map(Number)
      .sort((a, b) => a - b)
  }

  /**
   * F6: move this attempt's envelopes out of `tx/pending/` according to the ledger of the
   * head `current` names now, not according to what the build believes it published.
   *
   * Only envelopes in that ledger move to `tx/applied/`. When the ledger also holds every
   * envelope this build applied or found archivable, the published lineage is this build's
   * own, so its quarantine decisions stand. Otherwise external interference moved `current`
   * to a lineage this build never saw (spec L5): every other envelope stays pending, for
   * the next reconcile to classify against that lineage. Returns the counts actually moved.
   */
  private settle(
    applied: string[],
    archivable: string[],
    quarantined: [string, string][],
  ): { applied: number; quarantined: number } {
    const db = this.openCurrent()
    const ledgered = new Set<string>()
    try {
      const inLedger = db.prepare('SELECT 1 FROM applied_tx WHERE tx_id = ?')
      for (const txn of [...applied, ...archivable, ...quarantined.map(([t]) => t)]) {
        if (inLedger.get(txIdOf(txn)) !== undefined) {
          ledgered.add(txn)
        }
      }
    } finally {
      db.close()
    }
    const lineageIsOurs = [...applied, ...archivable].every((txn) => ledgered.has(txn))
    const toQuarantine = lineageIsOurs ? quarantined.filter(([txn]) => !ledgered.has(txn)) : []
    this.archive([...ledgered])
    this.quarantine(toQuarantine)
    return {
      applied: applied.filter((txn) => ledgered.has(txn)).length,
      quarantined: toQuarantine.length,
    }
  }

  private archive(txns: string[]): void {
    this.move(txns, this.txApplied)
  }

  private quarantine(pairs: [string, string][]): void {
    for (const [txn, reason] of pairs) {
      const txDir = join(this.txPending, txn)
      try {
        writeFileSync(join(txDir, 'QUARANTINE'), reason)
      } catch (error) {
        // Another reconciler may have archived or quarantined the same envelope after
        // this builder classified it. That is a successful concurrent resolution, not
        // a reason-write failure. Existing pending envelopes still fail closed.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(txDir)) {
          throw error
        }
      }
    }
    this.move(
      pairs.map((p) => p[0]),
      this.txQuarantine,
    )
  }

  private move(txns: string[], destDir: string): void {
    for (const txn of txns) {
      try {
        renameSync(join(this.txPending, txn), join(destDir, txn))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw e
        }
      }
    }
  }
}
