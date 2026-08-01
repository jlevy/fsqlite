// lock.ts: NFS-safe mkdir lease lock with an owner token.
//
// This is the ONLY mutual-exclusion primitive in fsqlite, and it is held only
// around the short snapshot-publish step (re-check `current` pointer + rename),
// never around writer work. It is deliberately NOT flock/fcntl: `mkdir(2)` is
// atomic on local disk AND on NFS/SMB, which is exactly why the git/npm world uses
// it for cross-host coordination. POSIX byte-range locks and WAL `-shm` shared
// memory do not work across hosts; `mkdir` does.
//
// Correctness does NOT depend on this lock being perfect. The reconcile that uses it
// is independently made idempotent (per-snapshot applied_tx ledger) and atomic
// (immutable snapshots + atomic pointer swap), so a broken stale lease or two
// overlapping holders cannot corrupt or double-apply. The lock is belt-and-suspenders;
// the owner token lets a holder REVALIDATE ownership right before the destructive
// publish (fencing) and abort if it lost the lease.

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

// Synchronous sleep without a busy-loop (works without async, matches node:sqlite's
// synchronous API). Uses Atomics.wait on a throwaway SharedArrayBuffer.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Acquire the lock dir, run fn(token), release. `fn` receives the owner token so it
 * can revalidate ownership via `ownerOf(lockPath) === token` immediately before a
 * destructive publish.
 *
 * INVARIANT: timeoutMs > staleMs (you must be able to wait longer than the stale
 * window, or you would break a lock you could otherwise have waited for).
 */
export function withLock<T>(lockPath: string, fn: (token: string) => T, opts: LockOptions = {}): T {
  const { timeoutMs = 30_000, pollMs = 25, staleMs = 20_000, onStaleBreak = null } = opts
  if (timeoutMs <= staleMs) throw new Error('withLock requires timeoutMs > staleMs')
  const token = randomBytes(8).toString('hex')
  const meta = JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() })
  const deadline = Date.now() + timeoutMs
  let held = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath)
      writeFileSync(join(lockPath, 'owner.json'), meta) // record owner INSIDE the lock dir
      held = true
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Lock exists. Break it only if it is older than the stale window. This is the
      // irreducible NFS hazard: a holder paused past the lease can be stolen out from
      // under. The defense is `ownerOf()` revalidation in `fn` + a generous staleMs >>
      // max critical section, NOT aggressive breaking.
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
  if (!held) throw new LockTimeoutError(lockPath, timeoutMs)
  try {
    return fn(token)
  } finally {
    // Fence the release the same way the publish step is fenced: only remove the dir if WE
    // still own it. A holder that stalled past staleMs and was stale-broken must not delete
    // a successor's live lock (which would let a third holder acquire concurrently). If we
    // lost ownership, leave the successor's lock alone; staleMs reclaims any true orphan.
    if (ownerOf(lockPath) === token) rmSync(lockPath, { recursive: true, force: true })
  }
}

/** Touch the lock dir mtime so a slow-but-alive holder is not considered stale. */
export function heartbeat(lockPath: string): void {
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch {
    /* ignore */
  }
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
