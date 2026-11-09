// lock.ts provides an exclusive mkdir lock with an owner token.
//
// Publication is fsqlite's only mutual-exclusion point. Writers do not hold the lease
// while preparing changes. `mkdir(2)` provides cross-process coordination on filesystems
// whose exclusive directory-creation semantics pass the required capability checks.
//
// Publication correctness requires exclusive ownership until release: a timestamp cannot
// distinguish a dead process from a paused one. An existing lock is never stolen on age.
// Abandoned-lock recovery requires stopping every client on every host before removing it.

import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { LockTimeoutError } from './errors.ts'
import { removeQuietly } from './fsutil.ts'

/**
 * Publish-lock timing, in milliseconds. All timings are positive safe integers.
 * `timeoutMs > staleMs` is retained for compatibility; age never permits lock takeover.
 */
export interface LockOptions {
  /** How long to wait for the lock before throwing `LockTimeoutError`; default 30 s. */
  timeoutMs?: number
  /** Delay between acquisition attempts; default 25 ms. */
  pollMs?: number
  /**
   * Heartbeat and diagnostic age, default 20 s. Exceeding it never allows lock takeover.
   */
  staleMs?: number
  /** Legacy callback accepted for compatibility. Automatic stale-lock breaking is disabled. */
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
 * The lock remains exclusive across arbitrary pauses (spec L5). Heartbeats provide
 * diagnostic liveness; token checks catch accidental out-of-protocol removal. They are
 * not an atomic fence against concurrent lock removal or a substitute for exclusivity.
 */
export interface LockLease {
  /** The random owner token this holder wrote to `owner.json`. */
  readonly token: string
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

/** Validate timing before any caller examines or mutates a lock. */
export function validateLockOptions(opts: unknown = {}): Required<LockOptions> {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new TypeError('lock options must be an object')
  }
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    onStaleBreak = null,
  } = opts as LockOptions
  for (const [name, value] of Object.entries({ timeoutMs, pollMs, staleMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`lock option ${name} must be a positive safe integer`)
    }
  }
  if (timeoutMs <= staleMs) {
    throw new TypeError(
      `withLock requires timeoutMs > staleMs; received timeoutMs ${timeoutMs}, staleMs ${staleMs}`,
    )
  }
  if (onStaleBreak !== null && typeof onStaleBreak !== 'function') {
    throw new TypeError('lock option onStaleBreak must be a function or null')
  }
  return { timeoutMs, pollMs, staleMs, onStaleBreak }
}
/**
 * A step-boundary heartbeat refreshes the lock once its age reaches this fraction of the
 * diagnostic stale window. A run of quick steps costs one stat each.
 */
export const LEASE_RENEW_FRACTION = 0.25

// Synchronous sleep without a busy-loop (works without async, matches node:sqlite's
// synchronous API). Uses Atomics.wait on a throwaway SharedArrayBuffer.
export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type OwnerWriter = (path: string, data: string) => void
let writeOwner: OwnerWriter = writeFileSync

/** Internal fault-injection seam; pass null to restore the filesystem writer. */
export function setOwnerWriterForTest(writer: OwnerWriter | null): void {
  writeOwner = writer ?? writeFileSync
}

/**
 * Acquire the lock dir, run fn(token, lease), release. `fn` receives the owner token and a
 * {@link LockLease}: it calls `lease.heartbeat()` between long steps and `lease.fence()`
 * immediately before each destructive step, abandoning the step when fencing fails.
 *
 * Existing locks, including malformed or arbitrarily old ones, cause bounded waiting.
 * Recovery must establish that all clients have stopped before removing an abandoned lock.
 */
export function withLock<T>(
  lockPath: string,
  fn: (token: string, lease: LockLease) => T,
  opts: LockOptions = {},
): T {
  const { timeoutMs, pollMs, staleMs } = validateLockOptions(opts)
  const token = randomBytes(8).toString('hex')
  const meta = JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() })
  const deadline = performance.now() + timeoutMs
  let held = false
  while (performance.now() < deadline) {
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
      // An old lock may belong to a paused publisher already past its last token check.
      // Taking it over would let that publisher resume a blind pointer rename later and
      // roll back acknowledged writes. Only its owner, or quiescent recovery, removes it.
      sleepSync(Math.min(pollMs, Math.max(0, deadline - performance.now())))
    }
  }
  if (!held) {
    throw new LockTimeoutError(lockPath, timeoutMs)
  }
  // Verify, touch, verify: the first check avoids refreshing a successor's lock; the
  // second catches accidental replacement. Correctness requires no concurrent takeover.
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
    // No conforming contender can remove this lock before its owner releases it.
    // The token check also avoids deleting an accidentally installed foreign lock.
    if (ownerOf(lockPath) === token) {
      rmSync(lockPath, { recursive: true, force: true })
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
