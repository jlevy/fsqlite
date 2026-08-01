// lock.ts provides an NFS-safe mkdir lease with an owner token.
//
// Publication is fsqlite's only mutual-exclusion point. Writers do not hold the lease
// while preparing changes. `mkdir(2)` provides cross-host coordination on local disks,
// NFS, and SMB, where POSIX byte-range locks and WAL shared memory are unreliable.
//
// Correctness rests on immutable snapshots, an atomic pointer swap, and the applied_tx
// ledger. The lease reduces redundant work. Its owner token lets a holder revalidate
// ownership immediately before publication and abort if it lost the lease.

import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
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
const DEFAULT_LOCK_STALE_MS = 20_000

// Synchronous sleep without a busy-loop (works without async, matches node:sqlite's
// synchronous API). Uses Atomics.wait on a throwaway SharedArrayBuffer.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type OwnerWriter = (path: string, data: string) => void
let writeOwner: OwnerWriter = writeFileSync

/** Internal fault-injection seam; pass null to restore the filesystem writer. */
export function setOwnerWriterForTest(writer: OwnerWriter | null): void {
  writeOwner = writer ?? writeFileSync
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
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          if (onStaleBreak) {
            try {
              onStaleBreak(readOwner(lockPath))
            } catch {
              /* ignore */
            }
          }
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue // lock vanished between exists-check and stat: retry immediately
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
      rmSync(lockPath, { recursive: true, force: true })
    }
  }
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
