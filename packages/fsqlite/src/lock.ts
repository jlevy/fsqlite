// lock.ts provides a fenced mkdir lease with an owner token.
//
// Publication is fsqlite's only mutual-exclusion point. Writers do not hold the lease
// while preparing changes. `mkdir(2)` provides cross-process coordination on filesystems
// whose exclusive directory-creation semantics pass the required capability checks.
//
// Correctness rests on immutable snapshots, an atomic pointer swap, and the applied_tx
// ledger. The lease reduces redundant work. Its owner token lets a holder revalidate
// ownership immediately before each destructive step and abort if it lost the lease.

import {
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { LockTimeoutError } from './errors.ts'
import { removeQuietly } from './fsutil.ts'

/**
 * Publish-lock timing, in milliseconds. Each window is a positive finite number, and
 * `timeoutMs` must exceed `staleMs`: a waiter must be able to outwait the stale window,
 * or it would break a lock it could have waited for. Invalid values throw a `TypeError`.
 */
export interface LockOptions {
  /** How long to wait for the lock before throwing `LockTimeoutError`; default 30 s. */
  timeoutMs?: number
  /** Delay between acquisition attempts; default 25 ms. */
  pollMs?: number
  /**
   * Age after which an unrefreshed lock counts as abandoned and may be broken; default
   * 20 s. Choose it longer than the longest single step a holder takes between renewals.
   */
  staleMs?: number
  /** Diagnostic callback run after this caller breaks a stale lock. */
  onStaleBreak?: ((meta: OwnerMeta | null) => void) | null
}

/** The owner record (`owner.json`) a lock holder writes inside the lock directory. */
export interface OwnerMeta {
  token: string
  pid: number
  host: string
  at: number
}

/**
 * A holder's handle on an acquired lock, passed to the `withLock` callback.
 *
 * Correctness never depends on the lock (spec L5), but a live holder keeps it fresh so
 * waiters do not break it during a long critical section, and it re-verifies ownership
 * immediately before every destructive step so a holder that was broken anyway backs off.
 * The callback runs synchronously, so renewal happens at step boundaries: a single step
 * (one copy, one application callback, one fsync) must still finish within `staleMs`.
 */
export interface LockLease {
  /** The random owner token this holder wrote to `owner.json`. */
  readonly token: string
  /** The resolved stale window, acquisition timeout, and poll interval of this lock. */
  readonly staleMs: number
  readonly timeoutMs: number
  readonly pollMs: number
  /**
   * Renew at a step boundary: refresh the lock's mtime once it is older than
   * {@link LEASE_RENEW_FRACTION} of `staleMs`. Returns false once this holder has lost the
   * lock, so long work can stop early instead of finishing a doomed attempt.
   */
  heartbeat: () => boolean
  /**
   * Refresh the lock and re-verify ownership immediately before a destructive step (spec
   * L3). Returns false when this holder no longer owns the lock and must abandon the step.
   */
  fence: () => boolean
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_LOCK_POLL_MS = 25
export const DEFAULT_LOCK_STALE_MS = 20_000
/**
 * A step-boundary heartbeat refreshes the lock once its age reaches this fraction of the
 * stale window. Renewing at a quarter keeps a holder at least three quarters of a window
 * away from any waiter's stale judgment, while a run of quick steps costs one stat each.
 */
export const LEASE_RENEW_FRACTION = 0.25

/** {@link LockOptions} with every default applied and every value validated. */
export interface ResolvedLockOptions {
  timeoutMs: number
  pollMs: number
  staleMs: number
  onStaleBreak: ((meta: OwnerMeta | null) => void) | null
}

function lockWindow(name: string, value: unknown, fallback: number): number {
  const ms = value === undefined ? fallback : value
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new TypeError(
      `lockOpts.${name} must be a positive finite number of milliseconds; received ` +
        (typeof ms === 'number' ? String(ms) : typeof ms),
    )
  }
  return ms
}

/**
 * Validate `opts` and apply the defaults. Every entry point that takes `lockOpts` calls
 * this before it touches the store: a zero, negative, or NaN stale window would let a
 * caller judge a live holder's lock or build stale, and a zero poll would spin.
 */
export function resolveLockOptions(opts: LockOptions = {}): ResolvedLockOptions {
  if (typeof opts !== 'object' || (opts as LockOptions | null) === null) {
    throw new TypeError(`lockOpts must be an object; received ${typeof opts}`)
  }
  const timeoutMs = lockWindow('timeoutMs', opts.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS)
  const pollMs = lockWindow('pollMs', opts.pollMs, DEFAULT_LOCK_POLL_MS)
  const staleMs = lockWindow('staleMs', opts.staleMs, DEFAULT_LOCK_STALE_MS)
  const onStaleBreak = opts.onStaleBreak ?? null
  if (onStaleBreak !== null && typeof onStaleBreak !== 'function') {
    throw new TypeError(
      `lockOpts.onStaleBreak must be a function or null; received ${typeof onStaleBreak}`,
    )
  }
  if (timeoutMs <= staleMs) {
    throw new TypeError(
      `withLock requires timeoutMs > staleMs; received timeoutMs ${timeoutMs}, staleMs ${staleMs}`,
    )
  }
  return { timeoutMs, pollMs, staleMs, onStaleBreak }
}

// Synchronous sleep without a busy-loop (works without async, matches node:sqlite's
// synchronous API). Uses Atomics.wait on a throwaway SharedArrayBuffer.
export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type OwnerWriter = (path: string, data: string) => void
let writeOwner: OwnerWriter = writeFileSync
type StaleLockMover = (lockPath: string, gravePath: string) => void
let moveStaleLock: StaleLockMover = renameSync

/** Internal fault-injection seam; pass null to restore the filesystem writer. */
export function setOwnerWriterForTest(writer: OwnerWriter | null): void {
  writeOwner = writer ?? writeFileSync
}

/** Internal fault-injection seam; pass null to restore the rename that moves a stale lock aside. */
export function setStaleLockMoverForTest(mover: StaleLockMover | null): void {
  moveStaleLock = mover ?? renameSync
}

/**
 * Acquire the lock dir, run fn(token, lease), release. `fn` receives the owner token and a
 * {@link LockLease}: it calls `lease.heartbeat()` between long steps and `lease.fence()`
 * immediately before each destructive step, abandoning the step when fencing fails.
 *
 * Invariant: timeoutMs > staleMs (you must be able to wait longer than the stale
 * window, or you would break a lock you could otherwise have waited for).
 */
export function withLock<T>(
  lockPath: string,
  fn: (token: string, lease: LockLease) => T,
  opts: LockOptions = {},
): T {
  const { timeoutMs, pollMs, staleMs, onStaleBreak } = resolveLockOptions(opts)
  const token = randomBytes(8).toString('hex')
  const meta = JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() })
  const deadline = Date.now() + timeoutMs
  let held = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath)
      try {
        writeOwner(join(lockPath, 'owner.json'), meta)
      } catch (error) {
        removeQuietly(lockPath)
        throw error
      }
      held = true
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e
      }
      // Lock exists. Break it only if it is older than the stale window. This is the
      // irreducible NFS hazard: a holder paused past the lease can be stolen out from
      // under it. The defense is the holder's `lease.fence()` before each destructive step,
      // its step-boundary heartbeats, and a staleMs value well above the longest single
      // step, not aggressive breaking.
      try {
        const seen = observeLock(lockPath)
        if (seen === null) {
          continue // lock vanished between mkdir and stat: retry immediately
        }
        if (Date.now() - seen.mtimeMs > staleMs) {
          // Two waiters can judge the same lock stale. Only the directory that was judged
          // stale may be removed, never a successor that re-acquired the name in between.
          const broken = removeLockIf(
            lockPath,
            (moved) =>
              moved.meta?.token === seen.meta?.token && Date.now() - moved.mtimeMs > staleMs,
          )
          if (broken !== null) {
            if (onStaleBreak) {
              try {
                onStaleBreak(broken.meta)
              } catch {
                /* a diagnostic callback must not change lock acquisition */
              }
            }
            continue
          }
        }
      } catch {
        // An unreadable or unremovable lock is treated as held: back off and retry until
        // the acquisition deadline rather than spinning.
      }
      sleepSync(pollMs)
    }
  }
  if (!held) {
    throw new LockTimeoutError(lockPath, timeoutMs)
  }
  // Verify, touch, verify: the first check avoids refreshing a successor's lock; the
  // second proves the touched directory is still ours. A breaker re-checks staleness after
  // moving a lock aside (L2), so a lock refreshed here cannot be broken for staleMs.
  const refresh = (): boolean => {
    if (ownerOf(lockPath) !== token) {
      return false
    }
    try {
      const now = new Date()
      utimesSync(lockPath, now, now)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
    return ownerOf(lockPath) === token
  }
  const lease: LockLease = {
    token,
    staleMs,
    timeoutMs,
    pollMs,
    heartbeat: () => {
      const seen = observeLock(lockPath)
      if (seen?.meta?.token !== token) {
        return false
      }
      return Date.now() - seen.mtimeMs < staleMs * LEASE_RENEW_FRACTION || refresh()
    },
    fence: refresh,
  }
  try {
    return fn(token, lease)
  } finally {
    // Fence the release the same way as publication: remove the directory only if we
    // still own it. A holder that stalled past staleMs and was stale-broken must not delete
    // a successor's live lock (which would let a third holder acquire concurrently). If we
    // lost ownership, leave the successor's lock alone; staleMs reclaims any true orphan.
    if (ownerOf(lockPath) === token) {
      removeLockIf(lockPath, (moved) => moved.meta?.token === token)
    }
  }
}

interface LockObservation {
  meta: OwnerMeta | null
  mtimeMs: number
}

/** The owner metadata and liveness mtime of a lock directory, or null if it is absent. */
function observeLock(path: string): LockObservation | null {
  const meta = readOwner(path)
  try {
    return { meta, mtimeMs: statSync(path).mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Remove the lock directory only while it is still the one the caller judged removable,
 * and return what was removed (null when nothing was).
 *
 * The directory is first renamed aside to a `.tmp` transient name. The rename is atomic, so
 * two breakers cannot both take the same directory, and once it is aside its holder can no
 * longer refresh it and no acquirer can reuse it. The moved directory is then judged again;
 * a check-then-delete on the lock path itself would race with a successor that re-acquires
 * the name between the check and the delete. If the moved directory no longer qualifies, it
 * is a successor's live lock and is renamed back. The rename back fails rather than replace
 * a lock another acquirer has since completed; that directory then belongs to no one (its
 * former holder fails every ownership check) and is removed.
 */
function removeLockIf(
  lockPath: string,
  accept: (moved: LockObservation) => boolean,
): LockObservation | null {
  const grave = `${lockPath}.${randomBytes(5).toString('hex')}.tmp`
  try {
    moveStaleLock(lockPath, grave)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null // another breaker or releaser moved it first
    }
    throw error
  }
  const moved = observeLock(grave)
  if (moved !== null && accept(moved)) {
    rmSync(grave, { recursive: true, force: true })
    return moved
  }
  try {
    renameSync(grave, lockPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error
    }
    rmSync(grave, { recursive: true, force: true })
  }
  return null
}

/** The lock's owner record, or null when it is absent, unreadable, or malformed. */
function readOwner(lockPath: string): OwnerMeta | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { token, pid, host, at } = value as Record<string, unknown>
  return typeof token === 'string' &&
    typeof pid === 'number' &&
    typeof host === 'string' &&
    typeof at === 'number'
    ? { token, pid, host, at }
    : null
}

/** Current owner token of a held lock, or null. Used to revalidate before publish. */
export function ownerOf(lockPath: string): string | null {
  const o = readOwner(lockPath)
  return o ? o.token : null
}

/** Whether an existing lock is still inside its live lease window. */
export function isLockFresh(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs <= staleMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}
