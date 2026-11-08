// lock.ts provides a fenced mkdir lease with an owner token.
//
// Publication is fsqlite's only mutual-exclusion point. Writers do not hold the lease
// while preparing changes. `mkdir(2)` provides cross-process coordination on filesystems
// whose exclusive directory-creation semantics pass the required capability checks.
//
// Correctness rests on immutable snapshots, an atomic pointer swap, and the applied_tx
// ledger. The lease reduces redundant work. Its owner token lets a holder revalidate
// ownership immediately before publication and abort if it lost the lease.

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

export interface LockOptions {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
  onStaleBreak?: ((meta: OwnerMeta | null) => void) | null
}

export interface OwnerMeta {
  token: string
  pid: number
  host: string
  at: number
}

export class LockTimeoutError extends Error {
  constructor(p: string, ms: number) {
    super(`could not acquire ${p} within ${ms}ms`)
    this.name = 'LockTimeoutError'
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_LOCK_POLL_MS = 25
export const DEFAULT_LOCK_STALE_MS = 20_000

// Synchronous sleep without a busy-loop (works without async, matches node:sqlite's
// synchronous API). Uses Atomics.wait on a throwaway SharedArrayBuffer.
const sleepSync = (ms: number): void => {
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
 * Acquire the lock dir, run fn(token), release. `fn` receives the owner token so it
 * can revalidate ownership via `ownerOf(lockPath) === token` immediately before a
 * destructive publish.
 *
 * Invariant: timeoutMs > staleMs (you must be able to wait longer than the stale
 * window, or you would break a lock you could otherwise have waited for).
 */
export function withLock<T>(lockPath: string, fn: (token: string) => T, opts: LockOptions = {}): T {
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    onStaleBreak = null,
  } = opts
  if (timeoutMs <= staleMs) {
    throw new Error('withLock requires timeoutMs > staleMs')
  }
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
        rmSync(lockPath, { recursive: true, force: true })
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
      // under it. The defense is `ownerOf()` revalidation in `fn` and a staleMs value
      // well above the maximum critical section, not aggressive breaking.
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
  try {
    return fn(token)
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

/** Touch the lock dir mtime so a slow-but-alive holder is not considered stale. */
export function heartbeat(lockPath: string): void {
  const now = new Date()
  utimesSync(lockPath, now, now)
}

function readOwner(lockPath: string): OwnerMeta | null {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as OwnerMeta
  } catch {
    return null
  }
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
