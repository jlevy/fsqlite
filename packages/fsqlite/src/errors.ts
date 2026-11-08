// errors.ts: fsqlite's typed error model.
//
// Every error fsqlite raises on purpose is an FsqliteError. Its `code` names the store or
// operation state a caller can act on, and `retryable` says whether repeating the same
// call may succeed, so callers branch on those (or on a subclass), never on message text.
// Argument mistakes remain TypeErrors, and an unexpected filesystem or SQLite failure that
// fsqlite does not classify propagates unchanged.

import { inspect } from 'node:util'

/** The message of `error`, the string itself, or a readable rendering of another value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : inspect(error)
}

/**
 * Stable, machine-readable error categories.
 *
 * - `not-a-store`, `invalid`, `unsupported`: recognition failures (spec section 11); the
 *   path is not a store, its marker is malformed, or it needs a newer implementation.
 *   Nothing may mutate such a path.
 * - `corrupt`: the store is inconsistent (torn or dangling pointer, identity mismatch, a
 *   head that fails integrity validation). Run `repair`.
 * - `in-flight`: a capture, publication, or maintenance operation is mid-flight, such as a
 *   live publisher holding `publish.lock`, or a captured write still pending.
 * - `conflict`: a changeset conflicted with the published head under the merge policy.
 * - `retryable`: bounded contention ran out (lock timeout, lost lock ownership, publish
 *   retries exhausted). Retry later.
 * - `post-publish`: a step failed after `current` already named the new version; see
 *   {@link PostPublishError}.
 * - `incompatible`: the caller's schema, schema version, or SQLite binding cannot serve
 *   this store or strategy. Fix the caller, not the store.
 * - `refused`: an operation's precondition does not hold (sealing a pending tail, a
 *   callback that changed the schema, initializing a non-empty unmarked directory).
 * - `io`: a filesystem step fsqlite needed failed; `cause` carries the system error.
 */
export type FsqliteErrorCode =
  | 'not-a-store'
  | 'invalid'
  | 'unsupported'
  | 'corrupt'
  | 'in-flight'
  | 'conflict'
  | 'retryable'
  | 'post-publish'
  | 'incompatible'
  | 'refused'
  | 'io'

/** Codes whose operation may succeed when the same call is repeated later. */
const RETRYABLE_CODES: ReadonlySet<FsqliteErrorCode> = new Set(['in-flight', 'retryable'])

/** Base class of every error fsqlite raises on purpose. */
export class FsqliteError extends Error {
  /** The stable category; see {@link FsqliteErrorCode}. */
  readonly code: FsqliteErrorCode
  /**
   * Whether repeating the same call may succeed without changing the store or the
   * arguments. It defaults by code: `in-flight` and `retryable` are retryable.
   */
  readonly retryable: boolean

  constructor(
    code: FsqliteErrorCode,
    message: string,
    options: ErrorOptions = {},
    retryable = RETRYABLE_CODES.has(code),
  ) {
    super(message, options)
    this.name = 'FsqliteError'
    this.code = code
    this.retryable = retryable
  }
}

/** The recognition states a {@link StoreFormatError} reports. */
export type StoreFormatErrorState = 'not-a-store' | 'invalid' | 'unsupported'

/**
 * A path failed store recognition (spec section 11). `state` equals `code` and is kept
 * for callers that already branch on it.
 */
export class StoreFormatError extends FsqliteError {
  readonly state: StoreFormatErrorState

  constructor(state: StoreFormatErrorState, message: string, options?: ErrorOptions) {
    super(state, message, options)
    this.name = 'StoreFormatError'
    this.state = state
  }
}

/**
 * A failure raised after the `current` pointer already named a newly published version,
 * for example a post-publish envelope move (spec F6) or a directory fsync that failed after
 * the pointer rename. The version is visible to readers, so the write it carries must not
 * be re-run. Every other error from a publishing call was raised before publication, and
 * that attempt published nothing.
 */
export class PostPublishError extends FsqliteError {
  /** The version that is published; the write it carries must not be re-run. */
  readonly published: number

  constructor(published: number, cause: unknown) {
    super(
      'post-publish',
      `version ${published} is published, but a later step failed (${errorMessage(cause)}); ` +
        'do not re-run the write it carries',
      { cause },
    )
    this.name = 'PostPublishError'
    this.published = published
  }
}

/** A changeset conflicted with the published head; see the two subclasses. */
export class ConflictError extends FsqliteError {
  /** The SQLite conflict types (`DATA`, `CONSTRAINT`, ...) or other recorded causes. */
  readonly conflictTypes: readonly string[]

  constructor(
    kind: 'strict' | 'permanent',
    conflictTypes: readonly string[],
    options: ErrorOptions,
    retryable: boolean,
  ) {
    super('conflict', `${kind} conflict (${conflictTypes.join(',')})`, options, retryable)
    this.name = 'ConflictError'
    this.conflictTypes = [...conflictTypes]
  }
}

/**
 * A replaceable conflict on a `strict` table. It is retryable: re-running the write
 * against the newer head (as `writeWithRetry` does) can succeed.
 */
export class StrictConflictError extends ConflictError {
  constructor(conflictTypes: readonly string[], options: ErrorOptions = {}) {
    super('strict', conflictTypes, options, true)
    this.name = 'StrictConflictError'
  }
}

/**
 * A conflict no policy can resolve (NOTFOUND, CONSTRAINT, FOREIGN_KEY, or a write to an
 * fsqlite-owned table). Re-running the same write against any head fails the same way.
 */
export class PermanentConflictError extends ConflictError {
  constructor(conflictTypes: readonly string[], options: ErrorOptions = {}) {
    super('permanent', conflictTypes, options, false)
    this.name = 'PermanentConflictError'
  }
}

/** The publish lock could not be acquired within `timeoutMs`. */
export class LockTimeoutError extends FsqliteError {
  readonly lockPath: string
  readonly timeoutMs: number

  constructor(lockPath: string, timeoutMs: number) {
    super('retryable', `could not acquire ${lockPath} within ${timeoutMs}ms`)
    this.name = 'LockTimeoutError'
    this.lockPath = lockPath
    this.timeoutMs = timeoutMs
  }
}

/**
 * `writeWithRetry` captured transaction `txId` but could not publish it. The code says
 * where the envelope is: `in-flight` (still pending; a later reconcile folds it),
 * `conflict` or `refused` (quarantined for good, with `quarantineReason`), or `corrupt`
 * (the envelope has no outcome). None is retryable: running the write again would apply
 * its change a second time once the pending envelope is folded.
 */
export class TransactionError extends FsqliteError {
  readonly txId: string
  /** The envelope's quarantine reason, or null when it was not quarantined. */
  readonly quarantineReason: string | null

  constructor(
    code: 'in-flight' | 'conflict' | 'refused' | 'corrupt',
    txId: string,
    message: string,
    quarantineReason: string | null,
    options: ErrorOptions = {},
  ) {
    super(code, message, options, false)
    this.name = 'TransactionError'
    this.txId = txId
    this.quarantineReason = quarantineReason
  }
}
