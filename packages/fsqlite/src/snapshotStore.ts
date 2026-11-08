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
  mkdirSync,
  copyFileSync,
  linkSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import * as driver from './driver.ts'
import { normalize, applyWithPolicy } from './conflictPolicy.ts'
import { fsyncPath, fsyncDir, postPublishError, publishPointer } from './fsutil.ts'
import { commitSnapshot } from './publication.ts'
import type { CommitOutcome } from './publication.ts'
import { isLockFresh, withLock } from './lock.ts'
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
  ReconcileResult,
  WriteWithRetryResult,
  GcOptions,
  GcResult,
  RepairResult,
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
const DEFAULT_WRITE_RETRIES = 5
const DEFAULT_RECONCILE_RETRIES = 8
const DEFAULT_RETAINED_SNAPSHOTS = 3
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
function requireSafeInteger(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}; received ${String(value)}`)
  }
  return value
}

/**
 * Store states in which gc may delete: the head passed identity and full integrity
 * validation. `in-flight-capture` qualifies because its tells (fresh transients, a held
 * lock, uncommitted envelopes, an orphan ahead of `current`) are routine on a live store
 * and gc never touches them; a corrupt or unrecognized store may need every snapshot.
 */
const GC_SAFE_STATES: ReadonlySet<StoreValidationState> = new Set([
  'sealed',
  'live',
  'in-flight-capture',
])

// Transient (never-store-state) entries, per fsql-format-spec.md §2: reconcile builds,
// DirectStore builds, init's snapshot-0 temp, writer working copies, and lock directories
// moved aside by a break or release (`publish.lock.<hex>.tmp/`, the only directory). A fresh
// one is work in flight; an old one is crash debris. Removal is recursive for that reason.
const isTransientFile = (f: string): boolean =>
  f.startsWith('.build-') ||
  f.startsWith('.direct-') ||
  f.startsWith('.work-') ||
  f.endsWith('.tmp')

// writerId is interpolated into filesystem paths (the working copy and the envelope dir),
// so it must be a safe single path component: no separators, traversal, or oversize names.
// The raw, unrestricted value is still recorded in the manifest for provenance.
const SAFE_WRITER_ID = /^[A-Za-z0-9._-]{1,64}$/

/** Default cap on a single changeset envelope before reconcile quarantines it (1 GiB). */
const DEFAULT_MAX_ENVELOPE_BYTES = 1 << 30

/**
 * Every caller table needs a NON-NULL primary key: the per-table merge policy is keyed on it.
 * An INTEGER PRIMARY KEY is a non-null rowid alias; any other primary key column must be NOT
 * NULL (SQLite otherwise allows a NULL in a non-integer PRIMARY KEY).
 */
function validatePrimaryKeys(db: driver.DB): void {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('applied_tx', 'fsqlite_meta')",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
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
      throw new Error(`table "${t}" has no primary key; fsqlite requires a NON-NULL primary key`)
    }
    const firstPk = pk[0]
    const isRowidAlias =
      pk.length === 1 && firstPk !== undefined && /^integer$/i.test(firstPk.type.trim())
    const nullablePk = pk.find((c) => c.notnull === 0)
    if (!isRowidAlias && nullablePk) {
      throw new Error(
        `table "${t}" primary key column "${nullablePk.name}" is nullable; declare it NOT NULL`,
      )
    }
  }
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
      throw new Error(`snapshot has invalid fsqlite-owned table ${table}`)
    }
  }
}

/** @internal Verify the format-owned identity and tables of a candidate snapshot. */
export function verifySnapshotIdentity(db: driver.DB, marker: StoreMarker): void {
  const applicationId = Number(
    (db.prepare('PRAGMA application_id').get() as Record<string, unknown>).application_id,
  )
  if (applicationId !== FSQLITE_APPLICATION_ID) {
    throw new Error(
      `snapshot application_id ${applicationId} does not match fsqlite application_id ${FSQLITE_APPLICATION_ID}`,
    )
  }
  verifyOwnedTableShapes(db)
  const storedFormatVersion = metaValue(db, 'format_version')
  if (storedFormatVersion !== marker.format_version) {
    throw new Error(
      `snapshot format version ${String(storedFormatVersion)} does not match ${STORE_MARKER_FILENAME} ` +
        marker.format_version,
    )
  }
  const storedStoreId = metaValue(db, 'store_id')
  if (storedStoreId !== marker.store_id) {
    throw new Error(
      `snapshot store_id ${String(storedStoreId)} does not match ${STORE_MARKER_FILENAME} ${marker.store_id}`,
    )
  }
  for (const key of ['schema_hash', 'tool_version']) {
    if (metaValue(db, key) === undefined) {
      throw new Error(`snapshot is missing required fsqlite_meta key ${key}`)
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
  const version = Number(
    (db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version,
  )
  if (version !== schemaVersion) {
    throw new Error(
      `store schema version ${version} is incompatible with the requested ${schemaVersion}`,
    )
  }
  const storedHash = metaValue(db, 'schema_hash')
  if (storedHash !== schemaHash) {
    throw new Error(
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
 * immutable snapshots, the `applied_tx` ledger, and optimistic concurrency on `current`, not
 * on the publish lock being perfect.
 */
export class SnapshotStore {
  readonly dir: string
  readonly snapDir: string
  readonly txPending: string
  readonly txApplied: string
  readonly txQuarantine: string
  readonly leaseDir: string
  readonly currentPath: string
  readonly publishLock: string
  readonly schema: string
  readonly schemaVersion: number
  readonly schemaHash: string
  readonly conflictPolicy: NormalizedPolicy
  readonly toolVersion: string
  readonly maxEnvelopeBytes: number
  private _clock: number

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
    this.maxEnvelopeBytes = opts.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES
    this._clock = 0
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
          throw new Error(
            `refusing to initialize an unmarked non-empty directory: ${unrelated.join(', ')}; ` +
              `choose an empty directory or an existing store with ${STORE_MARKER_FILENAME}`,
          )
        }
        marker = createStoreMarker(this.dir)
      }

      for (const d of [
        this.snapDir,
        this.txPending,
        this.txApplied,
        this.txQuarantine,
        this.leaseDir,
      ]) {
        mkdirSync(d, { recursive: true })
      }
      if (existsSync(this.currentPath)) {
        return
      } // another initializer won while we waited
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
        } finally {
          db.close()
        }
        fsyncPath(tmp)
        if (existsSync(this.currentPath)) {
          rmSync(tmp, { force: true })
          return
        }
        if (!lease.fence()) {
          throw new Error('init lost ownership of publish.lock before snapshot publication')
        }
        renameSync(tmp, this.snapshotPath(0))
        fsyncDir(this.snapDir)
        if (!lease.fence()) {
          throw new Error('init lost ownership of publish.lock before pointer publication')
        }
        publishPointer(this.dir, this.currentPath, 0)
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
    })
    this._verifyCompatible()
    return this
  }

  /**
   * Confirm an existing store's stamped identity matches this handle's configuration, so opening
   * a store with the wrong schema fails loudly instead of silently. Checks application_id and
   * user_version (the foreign-readable capability pragmas) and the stamped schema_hash, which
   * catches divergent caller DDL even when the caller forgets to increment schema_version.
   */
  private _verifyCompatible(): void {
    const marker = readStoreMarker(this.dir)
    const db = driver.openReadonly(this.snapshotPath(this.currentVersion()))
    try {
      verifySnapshotForPublish(db, marker, this.schemaVersion, this.schemaHash)
    } finally {
      db.close()
    }
  }

  private _verifySnapshotIdentity(db: driver.DB, marker: StoreMarker): void {
    verifySnapshotIdentity(db, marker)
  }

  /** Refuse store operations if the marker and published snapshot do not identify the same store. */
  private assertStoreIdentity(): void {
    const marker = readStoreMarker(this.dir)
    const db = driver.openReadonly(this.snapshotPath(this.currentVersion()))
    try {
      this._verifySnapshotIdentity(db, marker)
    } finally {
      db.close()
    }
  }

  snapshotPath(v: number): string {
    return join(this.snapDir, `${pad(v)}.fsqlite.sqlite`)
  }

  /**
   * The published version the `current` pointer names. Parsed strictly: an empty or
   * non-numeric pointer is corruption (R2) and throws rather than silently reading as
   * version 0 (the empty snapshot); `Number('')` would be 0, masking a torn pointer.
   */
  currentVersion(): number {
    readStoreMarker(this.dir)
    const raw = readFileSync(this.currentPath, 'utf8').trim()
    if (!/^\d+$/.test(raw)) {
      throw new Error(`corrupt current pointer: ${JSON.stringify(raw)}`)
    }
    return Number(raw)
  }

  /**
   * Run `fn` against the immutable snapshot named by `current`, opened read-only on a fresh
   * connection (close-to-open, so a concurrent publish is observed and never torn). Needs no
   * session extension; any SQLite binding can read the same file.
   */
  read<T>(fn: ReadFn<T>): T {
    const marker = readStoreMarker(this.dir)
    const db = driver.openReadonly(this.snapshotPath(this.currentVersion()))
    try {
      this._verifySnapshotIdentity(db, marker)
      return fn(db)
    } finally {
      db.close()
    }
  }

  /**
   * Pin the current version so reconcile's GC will not delete it while a
   * packager/uploader reads it. Returns { version, heartbeat, release }.
   */
  readLease({ maxRetries = DEFAULT_READ_LEASE_RETRIES }: { maxRetries?: number } = {}): ReadLease {
    this.assertStoreIdentity()
    // Optimistic claim, then verify: publish the lease *before* committing to read the
    // version, then confirm the snapshot still exists. This closes the check-then-act race
    // with gc. gc re-reads leases immediately before each unlink (see `gc`), so either it
    // sees our lease and keeps the snapshot, or it deleted the snapshot before our lease was
    // visible and our existence check fails, sending us to retry against the new head. The
    // newest snapshots are inside gc's retain floor and never collected, so this terminates.
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
        rmSync(tempPath, { force: true })
        throw new Error('readLease: failed to publish lease', { cause: error })
      }
      if (existsSync(this.snapshotPath(version))) {
        return this._lease(version, path)
      }
      rmSync(path, { force: true }) // lost the race to gc; drop the stale lease and retry
      if (attempt >= maxRetries) {
        throw new Error(
          `readLease: snapshot ${version} was collected under contention after ${attempt} retries`,
        )
      }
    }
  }

  private _lease(version: number, path: string): ReadLease {
    return {
      version,
      heartbeat: () => {
        const n = new Date()
        utimesSync(path, n, n)
      },
      release: () => {
        try {
          rmSync(path, { force: true })
        } catch {
          /* ignore */
        }
      },
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
      throw new Error(
        `invalid writerId ${JSON.stringify(writerId)}: must match ${String(SAFE_WRITER_ID)}`,
      )
    }
    this._verifyCompatible()
    driver.requireWriterCapabilities() // loud failure here beats a silent empty changeset
    const marker = readStoreMarker(this.dir)
    const base = this.currentVersion()
    const work = join(this.txPending, `.work-${writerId}-${rand()}.sqlite`)
    copyFileSync(this.snapshotPath(base), work) // SAFE: source snapshot is immutable
    let changeset: Uint8Array | null
    const db = driver.open(work)
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

    const txId = `${pad(Date.now())}-${pad(this._clock++)}-${writerId}-${rand()}`
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
   * never runs again for a published transaction; otherwise the error propagates.
   */
  writeWithRetry(
    writerId: string,
    fn: WorkFn,
    { maxRetries = DEFAULT_WRITE_RETRIES }: { maxRetries?: number } = {},
  ): WriteWithRetryResult {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const txId = this.write(writerId, fn)
      if (txId === null) {
        return { txId: null, attempts: attempt + 1, conflicted: false }
      }
      try {
        this.reconcile() // idempotent and OCC-safe; folds ours and any peers'
      } catch (error) {
        if (!this._isPublishedOr(txId, error)) {
          throw error
        }
      }
      if (this._isPublished(txId)) {
        return { txId, attempts: attempt + 1, conflicted: attempt > 0 }
      }
      const quarantinePath = join(this.txQuarantine, `${txId}.txn`, 'QUARANTINE')
      if (!existsSync(quarantinePath)) {
        throw new Error(
          `writeWithRetry: transaction ${txId} has no published or quarantined outcome`,
        )
      }
      const reason = readFileSync(quarantinePath, 'utf8')
      if (!reason.startsWith('apply-failed: strict conflict')) {
        throw new Error(`writeWithRetry: transaction ${txId} permanently quarantined: ${reason}`)
      }
      // A strict same-row conflict is retryable: re-seed and re-run fn.
    }
    throw new Error('writeWithRetry: exceeded retries (persistent conflict)')
  }

  /**
   * Whether the head `current` names holds `txId`, consulted after `failure`. If the store
   * cannot even be read, `failure` is the error to report, so it is rethrown instead.
   */
  private _isPublishedOr(txId: string, failure: unknown): boolean {
    try {
      return this._isPublished(txId)
    } catch {
      throw failure
    }
  }

  /** Whether the head `current` names holds `txId` in its ledger. */
  private _isPublished(txId: string): boolean {
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
   * An error with a numeric `published` property (`PostPublishError`) was raised after
   * the new version became current, for example while moving envelopes (spec F6); the data
   * is published and the leftovers are settled by the next reconcile. Any other error means
   * this call published nothing.
   */
  reconcile({
    maxRetries = DEFAULT_RECONCILE_RETRIES,
    lockOpts = {},
  }: { maxRetries?: number; lockOpts?: LockOptions } = {}): ReconcileResult {
    const marker = readStoreMarker(this.dir)
    const policy = this.conflictPolicy
    const crashAt = reconcileCrashAtForTest
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const base = this.currentVersion()
      this._verifyCompatible()
      const pending = this.pendingTxns()
      if (pending.length === 0) {
        return { published: base, applied: 0, quarantined: 0, attempts: attempt + 1 }
      }

      const tmp = join(this.snapDir, `.build-${rand()}.sqlite`)
      copyFileSync(this.snapshotPath(base), tmp)
      const applied: string[] = []
      const archivable: string[] = []
      const quarantined: [string, string][] = []
      const db = driver.open(tmp)
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
          const txDir = join(this.txPending, txn)
          let csSize = 0
          try {
            csSize = statSync(join(txDir, CHANGESET_FILENAME)).size
          } catch {
            /* missing/unreadable is handled by the read below */
          }
          if (csSize > this.maxEnvelopeBytes) {
            quarantined.push([txn, `envelope-too-large: ${csSize} > ${this.maxEnvelopeBytes}`])
            continue
          }
          let cs: Uint8Array
          let man: Manifest
          try {
            cs = readFileSync(join(txDir, CHANGESET_FILENAME))
            man = JSON.parse(readFileSync(join(txDir, 'manifest.json'), 'utf8')) as Manifest
          } catch {
            quarantined.push([txn, 'unreadable-envelope'])
            continue
          }
          if (sha256(cs) !== man.changeset_sha256) {
            quarantined.push([txn, 'digest-mismatch'])
            continue
          }
          if (man.format_version !== marker.format_version) {
            quarantined.push([txn, 'format-version-mismatch'])
            continue
          }
          if (man.tx_id !== txId) {
            quarantined.push([txn, 'tx-id-mismatch'])
            continue
          }
          if (man.store_id !== marker.store_id) {
            quarantined.push([txn, 'store-id-mismatch'])
            continue
          }
          if (man.changeset !== CHANGESET_FILENAME) {
            quarantined.push([txn, 'changeset-filename-mismatch'])
            continue
          }
          if (man.schema_version !== this.schemaVersion) {
            quarantined.push([txn, 'schema-version-mismatch'])
            continue
          }
          if (man.schema_hash !== this.schemaHash) {
            quarantined.push([txn, 'schema-hash-mismatch'])
            continue
          }
          try {
            applyWithPolicy(db, cs, policy, () => {
              mark.run(man.tx_id, nowIso())
            })
            applied.push(txn)
            seen.add(txId)
          } catch (e) {
            // A genuine conflict aborted the apply (policy returned ABORT) or some other
            // apply error. Quarantine the tx; do not poison the whole batch.
            quarantined.push([txn, `apply-failed: ${(e as Error).message}`])
          }
        }
        verifySnapshotForPublish(db, marker, this.schemaVersion, this.schemaHash)
        driver.quickCheck(db)
      } finally {
        db.close()
      }

      if (applied.length === 0) {
        rmSync(tmp, { force: true })
        const settled = this._settle(applied, archivable, quarantined)
        return {
          published: base,
          applied: 0,
          quarantined: settled.quarantined,
          attempts: attempt + 1,
        }
      }
      if (crashAt === 'after-build') {
        throw new Error('CRASH after-build')
      } // tmp orphaned; current unchanged

      const next = base + 1
      fsyncPath(tmp) // complete slow durability work before acquiring the publication lease
      const result = withLock(
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
      )
      if (result === 'retry') {
        rmSync(tmp, { force: true })
        continue
      }
      if (crashAt === 'after-pointer') {
        throw new Error('CRASH after-pointer')
      } // published; tx not yet archived

      let settled: { applied: number; quarantined: number }
      try {
        settled = this._settle(applied, archivable, quarantined)
      } catch (error) {
        throw postPublishError(next, error)
      }
      return {
        published: next,
        applied: settled.applied,
        quarantined: settled.quarantined,
        attempts: attempt + 1,
      }
    }
    throw new Error('reconcile exceeded retries (excessive publish contention)')
  }

  /**
   * Delete superseded snapshots, always keeping `current`, every version >= current - retain
   * (current plus its `retain` predecessors under spec G1), and any version pinned by a live
   * read-lease (leases past `leaseStaleMs` are treated as abandoned). Also sweeps *stale*
   * transients but never fresh ones, which may be a live reconcile or DirectStore build in
   * another process (spec G3); `transientStaleMs` gates that.
   *
   * gc is destructive maintenance, so it fails closed (spec G0): invalid options throw a
   * TypeError, a store that does not validate with an integrity-clean head is refused (its
   * older snapshots may be the only recovery points repair has), and every deletion runs
   * under the publish lock with a fenced token, so gc never interleaves with repair.
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
    // Validate outside the lock: the integrity check reads the whole head and must not
    // stall publishers. A recognition failure is refused before the lock dir is created.
    const health = this.validate()
    if (!GC_SAFE_STATES.has(health.state) || health.current === undefined) {
      throw new Error(
        `gc refused: store is ${health.state}: ${health.issues.join('; ')}; ` +
          'run validate and repair before collecting snapshots',
      )
    }
    const validated = health.current
    return withLock(
      this.publishLock,
      (_token, lease) => this._gcLocked(lease, validated, retain, leaseStaleMs, transientStaleMs),
      lockOpts,
    )
  }

  private _gcLocked(
    lease: LockLease,
    validated: number,
    retain: number,
    leaseStaleMs: number,
    transientStaleMs: number,
  ): GcResult {
    const fence = (): void => {
      if (!lease.fence()) {
        throw new Error('gc lost ownership of publish.lock before deletion')
      }
    }
    fence()
    const cur = this.currentVersion()
    // A forward move is an ordinary integrity-gated publication. A backward move means
    // repair re-pointed the store after validation, so the verdict no longer applies.
    if (cur < validated) {
      throw new Error(
        `gc refused: current moved from ${validated} back to ${cur} after validation; run gc again`,
      )
    }
    const leased = this._activeLeasedVersions(leaseStaleMs)
    const versions = this.snapshotVersions()
    const keepFloor = cur - retain
    let removed = 0
    for (const v of versions) {
      if (v === cur || v >= keepFloor || leased.has(v)) {
        continue
      }
      // Re-scan leases right before the tombstone: a reader may have claimed v after we
      // computed `leased` (readLease publishes the lease before reading).
      if (this._activeLeasedVersions(leaseStaleMs).has(v)) {
        continue
      }
      fence()
      if (this._collectSnapshot(v, leaseStaleMs)) {
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
        if (!isTransientFile(f)) {
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
    sweepStaleTransients(this.dir)
    sweepStaleTransients(this.snapDir)
    sweepStaleTransients(this.txPending)
    return { removed, kept: versions.length - removed, leased: [...leased] }
  }

  /**
   * Two-phase unlink (spec G2): rename snapshot `v` to a `.gc-` tombstone, re-scan leases,
   * then either unlink the tombstone or, if a lease on `v` appeared, move it back. A check
   * followed by an unlink cannot close the race with RL1, because a reader can publish its
   * lease and pass its existence check between the two. After the rename the reader's check
   * fails and it retries; a lease published before the rename is visible to the re-scan.
   * Returns true if the snapshot was deleted, false if a lease kept it.
   */
  private _collectSnapshot(v: number, leaseStaleMs: number): boolean {
    const path = this.snapshotPath(v)
    const tombstone = join(this.snapDir, `.gc-${pad(v)}-${rand()}.tmp`)
    const restore = (): void => {
      linkSync(tombstone, path) // never replace a snapshot name
      unlinkSync(tombstone)
    }
    try {
      renameSync(path, tombstone)
    } catch (error) {
      throw new Error(`gc failed to remove snapshot ${v}`, { cause: error })
    }
    let leasedNow: boolean
    try {
      leasedNow = this._activeLeasedVersions(leaseStaleMs).has(v)
    } catch (error) {
      restore() // fail closed: an unreadable lease must not cost the snapshot it may pin
      throw error
    }
    if (leasedNow) {
      restore()
      return false
    }
    try {
      unlinkSync(tombstone)
    } catch (error) {
      throw new Error(`gc failed to remove snapshot ${v}`, { cause: error })
    }
    return true
  }

  private _activeLeasedVersions(staleMs: number): Set<number> {
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
          throw new Error('lease version must be a non-negative safe integer')
        }
        out.add(version)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw new Error(`gc refused: fresh lease ${f} is unreadable`, { cause: error })
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
    const issues: string[] = []
    const recognition = recognizeStore(this.dir)
    if (recognition.state !== 'supported') {
      return { state: recognition.state, issues: [recognition.issue] }
    }
    const marker = recognition.marker
    if (!existsSync(this.currentPath)) {
      return { state: 'corrupt', issues: ['missing current pointer'] }
    }
    let cur: number
    try {
      cur = this.currentVersion()
      if (!Number.isInteger(cur)) {
        throw new Error('nan')
      }
    } catch {
      return { state: 'corrupt', issues: ['torn current pointer'] }
    }
    if (!existsSync(this.snapshotPath(cur))) {
      return { state: 'corrupt', issues: [`current points at missing snapshot ${cur}`] }
    }

    // In-flight tells.
    const rootFiles = readdirSync(this.dir)
    const snapFiles = existsSync(this.snapDir) ? readdirSync(this.snapDir) : []
    const pendingFiles = existsSync(this.txPending) ? readdirSync(this.txPending) : []
    const transients = [
      ...rootFiles.filter(isTransientFile),
      ...snapFiles.filter(isTransientFile),
      ...pendingFiles.filter(isTransientFile), // .work-* writer copies
    ]
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
    try {
      try {
        this._verifySnapshotIdentity(db, marker)
      } catch (error) {
        return {
          state: 'corrupt',
          issues: [...issues, error instanceof Error ? error.message : String(error)],
        }
      }
      problems = driver.integrityProblems(db)
    } finally {
      db.close()
    }
    if (problems.length) {
      return {
        state: 'corrupt',
        issues: [...issues, `snapshot ${cur} failed integrity validation: ${problems.join('; ')}`],
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

  /**
   * Finalize the current snapshot into a clean single-file at `destPath` via VACUUM INTO
   * (no -wal/-shm, integrity-checked). Requires an empty pending tail.
   */
  seal(destPath: string): string {
    this.assertStoreIdentity()
    if (this.pendingTxns().length > 0) {
      throw new Error('cannot seal: pending tx must be reconciled first')
    }
    const lease = this.readLease()
    try {
      const db = driver.openReadonly(this.snapshotPath(lease.version))
      try {
        driver.vacuumInto(db, destPath)
      } finally {
        db.close()
      }
      const out = driver.openReadonly(destPath)
      try {
        const problems = driver.integrityProblems(out)
        if (problems.length) {
          throw new Error(`sealed snapshot failed integrity validation: ${problems.join('; ')}`)
        }
      } finally {
        out.close()
      }
      return destPath
    } finally {
      lease.release()
    }
  }

  /**
   * doctor/repair: restore the last consistent point. Principled because every published
   * snapshot is immutable and was quick_check-validated at publish (R1).
   */
  repair({ lockOpts = {} }: { lockOpts?: LockOptions } = {}): RepairResult {
    const marker = readStoreMarker(this.dir)
    if (isLockFresh(this.publishLock, lockOpts.staleMs)) {
      throw new Error('repair refused: publish.lock is present and held by a live publisher')
    }
    const actions = withLock(
      this.publishLock,
      (_token, lease) => {
        if (!lease.fence()) {
          throw new Error('repair lost ownership of publish.lock before mutation')
        }
        return this._repairLocked(marker, lease)
      },
      lockOpts,
    )
    const state = this.validate().state
    if (state === 'not-a-store' || state === 'invalid' || state === 'unsupported') {
      throw new Error(`repair ended with an unrecognized store: ${state}`)
    }
    return { actions, state }
  }

  private _repairLocked(marker: StoreMarker, lease: LockLease): string[] {
    const actions: string[] = []
    const lost = (): Error => new Error('repair lost ownership of publish.lock before mutation')
    const assertOwnership = (): void => {
      if (!lease.fence()) {
        throw lost()
      }
    }
    // Scanning every snapshot can outlast the stale window, so renew after each one.
    const renew = (): void => {
      if (!lease.heartbeat()) {
        throw lost()
      }
    }
    const versions = this.snapshotVersions()
    const identityMatches = (v: number): boolean => {
      try {
        const db = driver.openReadonly(this.snapshotPath(v))
        try {
          this._verifySnapshotIdentity(db, marker)
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
      throw new Error(`repair: no snapshot matches the store identity in ${STORE_MARKER_FILENAME}`)
    }
    const integrityOk = (v: number): boolean => {
      try {
        const db = driver.openReadonly(this.snapshotPath(v))
        try {
          this._verifySnapshotIdentity(db, marker)
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
      if (!Number.isInteger(cur)) {
        cur = null
      }
    } catch {
      /* ignore */
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
        throw new Error('repair: no integrity-clean snapshot exists')
      }
      assertOwnership()
      publishPointer(this.dir, this.currentPath, good)
      actions.push(`re-published current -> ${good}`)
    }

    // Delete snapshots ahead of the restored pointer (rolled-back orphans) and transients.
    for (const v of this.snapshotVersions()) {
      if (v > good) {
        const wasIntegrityClean = integrityOk(v)
        assertOwnership()
        rmSync(this.snapshotPath(v), { force: true })
        actions.push(`removed ${wasIntegrityClean ? 'orphan' : 'corrupt'} snapshot ${v}`)
      }
    }
    for (const dir of [this.dir, this.snapDir, this.txPending]) {
      if (!existsSync(dir)) {
        continue
      }
      for (const f of readdirSync(dir)) {
        if (isTransientFile(f)) {
          assertOwnership()
          rmSync(join(dir, f), { recursive: true, force: true })
          actions.push(`removed transient ${f}`)
        }
      }
    }

    // Quarantine uncommitted pending envelopes (evidence kept).
    if (existsSync(this.txPending)) {
      for (const d of readdirSync(this.txPending)) {
        if (d.endsWith('.txn') && !existsSync(join(this.txPending, d, 'COMMITTED'))) {
          assertOwnership()
          writeFileSync(join(this.txPending, d, 'QUARANTINE'), 'uncommitted-at-repair')
          assertOwnership()
          this._move([d], this.txQuarantine)
          actions.push(`quarantined uncommitted ${d}`)
        }
      }
    }

    return actions
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
   * own, so its quarantine decisions stand. Otherwise an overlapping holder moved `current`
   * to a lineage this build never saw (spec L5): every other envelope stays pending, for
   * the next reconcile to classify against that lineage. Returns the counts actually moved.
   */
  private _settle(
    applied: string[],
    archivable: string[],
    quarantined: [string, string][],
  ): { applied: number; quarantined: number } {
    const db = driver.openReadonly(this.snapshotPath(this.currentVersion()))
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
    this._archive([...ledgered])
    this._quarantine(toQuarantine)
    return {
      applied: applied.filter((txn) => ledgered.has(txn)).length,
      quarantined: toQuarantine.length,
    }
  }

  private _archive(txns: string[]): void {
    this._move(txns, this.txApplied)
  }

  private _quarantine(pairs: [string, string][]): void {
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
    this._move(
      pairs.map((p) => p[0]),
      this.txQuarantine,
    )
  }

  private _move(txns: string[], destDir: string): void {
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
