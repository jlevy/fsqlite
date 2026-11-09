// Public types for fsqlite.

import type { DatabaseSync } from 'node:sqlite'
import type { LockOptions } from './lock.ts'

/** A unit of work run against a writable connection. */
export type WorkFn = (db: DatabaseSync) => void

/** A read-only view over the current published snapshot. */
export type ReadFn<T> = (db: DatabaseSync) => T

/**
 * Per-table merge action. `lww` (last-writer-wins) aliases `replace`; `union`
 * (set-union / first-writer-wins) aliases `omit`; `strict` quarantines any conflict.
 */
export type ConflictAction = 'replace' | 'omit' | 'strict' | 'lww' | 'union'

/** Caller-supplied policy: table name to action, with `'*'` the default. */
export type ConflictPolicyInput = Record<string, ConflictAction>

/** Normalized policy: only the three actions node:sqlite honors, `'*'` always set. */
export type NormalizedPolicy = Record<string, 'replace' | 'omit' | 'strict'>

/** Caller-supplied configuration for a store: the schema and the per-table merge policy. */
export interface StoreOptions {
  /** Caller DDL applied to snapshot 0. Every table must have a NON-NULL primary key. */
  schema?: string
  /**
   * Immutable caller-schema identity for this store epoch, stamped as `user_version` and
   * on envelopes. Must be an integer from 0 through 2,147,483,647. Changing it does not
   * migrate an existing store; a different value is incompatible until an explicit future
   * migration protocol is used.
   */
  schemaVersion?: number
  /**
   * Per-table merge policy (table to action, `'*'` the default). Every reconciler for one
   * store epoch must use the same effective policy; see {@link ConflictPolicyInput}. Every
   * key other than `'*'` must name a caller table, so a misspelling cannot silently fall
   * back to the default. An unknown action throws a `TypeError`.
   */
  conflictPolicy?: ConflictPolicyInput
  /** Free-form writer/tool version recorded on each envelope for provenance. */
  toolVersion?: string
  /**
   * Reconcile refuses to load a changeset envelope larger than this many bytes, quarantining
   * it instead of reading it fully into memory. Guards against a runaway writer OOMing the
   * reconciler. A positive safe integer; defaults to 1 GiB.
   */
  maxEnvelopeBytes?: number
}

/**
 * Store health. `sealed`/`live` are healthy; `in-flight-capture` means a capture,
 * publish, or maintenance operation is mid-flight (retryable); `corrupt` means an inconsistency `validate` surfaced
 * rather than silently accepted (R2).
 */
export type StoreState = 'sealed' | 'live' | 'in-flight-capture' | 'corrupt'

/** Recognition failures precede health validation and are never repairable corruption. */
export type StoreRecognitionState = 'not-a-store' | 'invalid' | 'unsupported'

export type StoreValidationState = StoreState | StoreRecognitionState

/** Recognition plus health classification and any human-readable issues. */
export interface ValidateResult {
  state: StoreValidationState
  /** The version `current` names; absent when recognition fails or the pointer is unusable. */
  current?: number
  /** Committed pending envelopes; present whenever `current` is. */
  pending?: number
  issues: string[]
}

/**
 * Result of `reconcile()`: the head version after publishing, how many tx were folded in,
 * how many were quarantined (policy conflicts / bad envelopes), and how many OCC attempts
 * the publish took.
 */
export interface ReconcileResult {
  /** The version `current` names after this call (unchanged when nothing was published). */
  published: number
  applied: number
  quarantined: number
  attempts: number
}

/**
 * Result of `writeWithRetry()`: the committed tx id (or null if `fn` made no change),
 * the number of attempts, and whether a strict-row conflict forced a re-seed.
 */
export interface WriteWithRetryResult {
  txId: string | null
  attempts: number
  conflicted: boolean
}

/** Options for `reconcile()`. Invalid values throw a `TypeError`. */
export interface ReconcileOptions {
  /** Publication attempts under contention; an integer of at least 1, default 8. */
  maxRetries?: number
  /** Publish-lock options. */
  lockOpts?: LockOptions
}

/** Options for `writeWithRetry()`. Invalid values throw a `TypeError`. */
export interface WriteWithRetryOptions {
  /** Write attempts after strict conflicts; an integer of at least 1, default 5. */
  maxRetries?: number
}

/** Options for `readLease()`. Invalid values throw a `TypeError`. */
export interface ReadLeaseOptions {
  /** Re-reads of `current` after gc collects the version first read; at least 0, default 8. */
  maxRetries?: number
  /** Lock options for claiming a lease without racing gc's snapshot removal. */
  lockOpts?: LockOptions
}

/** Options for `gc()`. Invalid values throw a `TypeError` before anything is deleted. */
export interface GcOptions {
  /** Predecessors of `current` to keep (spec G1). A non-negative integer; default 3. */
  retain?: number
  /** Age in ms after which a lease counts as abandoned. A positive integer; default 60 s. */
  leaseStaleMs?: number
  /** Age in ms after which a transient counts as crash debris. A positive integer; default 60 s. */
  transientStaleMs?: number
  /** Publish-lock options; gc holds the lock for every deletion. */
  lockOpts?: LockOptions
}

/** Result of `gc()`: snapshots removed, snapshots kept, and the versions a lease pinned. */
export interface GcResult {
  removed: number
  kept: number
  leased: number[]
}

/** Options for `repair()` and `planRepair()`. */
export interface RepairOptions {
  /** Publish-lock options; `staleMs` also decides whether an existing lock is live. */
  lockOpts?: LockOptions
}

/**
 * Result of `repair()`: the actions taken and the resulting {@link StoreState}. For
 * `planRepair()`, the actions repair would take and the state now.
 */
export interface RepairResult {
  actions: string[]
  state: StoreState
}

/**
 * A pin on a published version so `gc` will not delete it while a packager reads it.
 * `heartbeat()` refreshes the pin; `release()` drops it. A lease that stops heartbeating
 * past `leaseStaleMs` self-clears so a dead packager cannot wedge `gc`. A lease is
 * disposable, so `using lease = store.readLease()` releases it at the end of the scope.
 */
export interface ReadLease {
  /** The pinned version. */
  version: number
  /**
   * Refresh the pin's liveness. Throws a `retryable` FsqliteError once the pin is gone
   * (released, or reaped by gc as stale), because the snapshot is no longer protected.
   */
  heartbeat: () => void
  /** Drop the pin; idempotent. Throws an `io` FsqliteError when the pin cannot be removed. */
  release: () => void
  /** The same as `release()`, for `using` declarations. */
  [Symbol.dispose]: () => void
}

/**
 * What the current SQLite binding can do (capability detection, research G2). Extension
 * loading is deliberately absent: fsqlite opens every connection without `allowExtension`,
 * so neither fsqlite nor a callback can load one, whatever the binding supports.
 */
export interface Capabilities {
  /** The session extension records changesets; SnapshotStore writers require it. */
  session: boolean
  /**
   * The binding exposes changeset apply. Informational: every supported Node release
   * does, and fsqlite cannot load without it.
   */
  applyChangeset: boolean
  /**
   * The binding exposes the online backup API. Informational: fsqlite imports it
   * statically, so a binding without it cannot load the package.
   */
  backup: boolean
  /** The binding exposes SQLite's changeset rebaser; node:sqlite does not. */
  rebaser: boolean
}
