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
   * store epoch must use the same effective policy; see {@link ConflictPolicyInput}.
   */
  conflictPolicy?: ConflictPolicyInput
  /** Free-form writer/tool version recorded on each envelope for provenance. */
  toolVersion?: string
  /**
   * Reconcile refuses to load a changeset envelope larger than this many bytes, quarantining
   * it instead of reading it fully into memory. Guards against a runaway writer OOMing the
   * reconciler. Defaults to 1 GiB.
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
  current?: number
  pending?: number
  issues: string[]
}

/**
 * Result of `reconcile()`: the head version after publishing, how many tx were folded in,
 * how many were quarantined (policy conflicts / bad envelopes), and how many OCC attempts
 * the publish took.
 */
export interface ReconcileResult {
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

/**
 * An error raised after the `current` pointer already named a newly published version,
 * for example a post-publish envelope move (spec F6) or a directory fsync that failed after
 * the pointer rename. The version is visible to readers, so the write it carries must not
 * be re-run; `published` is that version. Every error without this property was raised
 * before publication, and the attempt published nothing.
 */
export interface PostPublishError extends Error {
  readonly published: number
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

/** Result of `repair()`: the actions taken and the resulting {@link StoreState}. */
export interface RepairResult {
  actions: string[]
  state: StoreState
}

/**
 * A pin on a published version so `gc` will not delete it while a packager reads it.
 * `heartbeat()` refreshes the pin; `release()` drops it. A lease that stops heartbeating
 * past `leaseStaleMs` self-clears so a dead packager cannot wedge `gc`.
 */
export interface ReadLease {
  version: number
  heartbeat: () => void
  release: () => void
}

/** What the current SQLite binding can do (capability detection, research G2). */
export interface Capabilities {
  session: boolean
  applyChangeset: boolean
  backup: boolean
  loadExtension: boolean
  rebaser: boolean
}
