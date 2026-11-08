// publication.ts commits a fully built, fsynced snapshot under the next version name and
// publishes it through the `current` pointer, for both write strategies (spec F5c, §9).
//
// The lock does not make publication safe on its own: a holder paused past the stale
// window can be broken and resume between its last check and its next filesystem step
// (spec L5). Three rules keep such overlap from losing published work:
//
//   1. Commit without replacing. The build is hard-linked to `snapshots/<next>`, which
//      fails with EEXIST instead of replacing whatever another holder put there, so no
//      publisher can ever replace a snapshot that `current` names or may soon name.
//   2. Verify identity at the pointer swap. The holder records the identity of its build
//      before linking and re-checks the entry immediately before swapping the pointer and
//      again after it, so it never reports another holder's build as its own publication.
//   3. Clean up only its own orphan. A holder that abandons after linking removes the entry
//      only while it is still its own build and still ahead of `current`.

import { closeSync, fstatSync, linkSync, openSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { FsqliteError, PostPublishError } from './errors.ts'
import { fsyncDir, publishPointer } from './fsutil.ts'
import { sleepSync } from './lock.ts'
import type { LockLease } from './lock.ts'

type BeforeSnapshotLinkHook = (dest: string) => void
let beforeSnapshotLinkHook: BeforeSnapshotLinkHook | null = null

/**
 * Internal fault-injection seam: runs after a publisher passed its OCC and fencing checks,
 * immediately before it commits its build to `snapshots/<next>`, which is where a paused,
 * stale-broken holder resumes. Pass null to remove it.
 */
export function setBeforeSnapshotLinkForTest(hook: BeforeSnapshotLinkHook | null): void {
  beforeSnapshotLinkHook = hook
}

/** What one publication attempt needs to know about the store and its build. */
export interface SnapshotCommit {
  /** Store root, which holds `current`. */
  storeDir: string
  currentPath: string
  snapDir: string
  /** The fsynced `.build-*` or `.direct-*` transient to publish. */
  build: string
  /** `snapshots/<next>.fsqlite.sqlite`. */
  dest: string
  /** The version the build was made from; `current` must still name it. */
  base: number
  next: number
  /** Strictly parsed `current` (spec P1). */
  readCurrent: () => number
  lease: LockLease
  /**
   * Crash-test seam run after the build is linked and the directory fsynced. An exception
   * from it models a process crash, so it propagates without removing the linked entry.
   */
  afterLink?: (() => void) | undefined
}

/**
 * `published`: `current` names `next` and the entry is this holder's build. `retry`: the
 * attempt was superseded or fenced out and published nothing of its own; rebuild from a
 * fresh base.
 */
export type CommitOutcome = 'published' | 'retry'

/** Identity of a build file: the same inode, unmodified since this holder linked it. */
interface BuildIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

const identityOf = (st: Stats): BuildIdentity => ({
  dev: st.dev,
  ino: st.ino,
  size: st.size,
  mtimeMs: st.mtimeMs,
})

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Whether `path` currently names the build this holder linked. */
function namesBuild(path: string, expected: BuildIdentity): boolean {
  let st: Stats
  try {
    st = statSync(path)
  } catch (error) {
    if (isEnoent(error)) {
      return false
    }
    throw error
  }
  const actual = identityOf(st)
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  )
}

/**
 * Commit `build` as `snapshots/<next>` without replacing anything there, then swap the
 * pointer. Call while holding the publish lock, after the caller's own OCC and fencing
 * checks. On `retry` the caller removes its build transient if it still exists.
 */
export function commitSnapshot(c: SnapshotCommit): CommitOutcome {
  // Holding the build open pins its inode, so the number cannot be reused by another file
  // while this holder compares identities.
  const fd = openSync(c.build, 'r')
  try {
    const expected = linkBuild(c, fd)
    if (expected === null) {
      return 'retry'
    }
    try {
      unlinkSync(c.build)
      fsyncDir(c.snapDir)
    } catch (error) {
      removeOwnOrphan(c, expected, error)
      throw error
    }
    c.afterLink?.()
    try {
      if (c.readCurrent() !== c.base || !c.lease.fence() || !namesBuild(c.dest, expected)) {
        removeOwnOrphan(c, expected)
        return 'retry'
      }
      publishPointer(c.storeDir, c.currentPath, c.next)
    } catch (error) {
      if (!(error instanceof PostPublishError)) {
        removeOwnOrphan(c, expected, error)
      }
      throw error
    }
    // A holder that lost its lease can still finish a pointer rename it began before
    // pausing. If the entry is no longer this build, `current` names another holder's
    // snapshot, so this attempt published nothing of its own.
    try {
      return namesBuild(c.dest, expected) ? 'published' : 'retry'
    } catch (error) {
      throw new PostPublishError(c.next, error)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Hard-link the build to `dest`, waiting out or reclaiming an entry that is already there.
 * Returns the build's identity, or null when the attempt must be retried from a new base.
 *
 * An existing entry belongs either to a publisher that already advanced `current` past
 * `base` (retry), to a holder inside its own link-to-swap window, or to a publisher that
 * crashed or abandoned there. A live holder touches its build immediately before linking
 * and swaps the pointer moments later, so an entry older than the stale window is an
 * orphan: the lock's own liveness rule (spec L2) applied to the entry.
 */
function linkBuild(c: SnapshotCommit, fd: number): BuildIdentity | null {
  const deadline = Date.now() + c.lease.timeoutMs
  for (;;) {
    if (!c.lease.fence()) {
      return null
    }
    const now = new Date()
    utimesSync(c.build, now, now)
    const expected = identityOf(fstatSync(fd))
    beforeSnapshotLinkHook?.(c.dest)
    try {
      linkSync(c.build, c.dest)
      return expected
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    if (c.readCurrent() >= c.next) {
      return null // a peer published this version first
    }
    let existing: Stats
    try {
      existing = statSync(c.dest)
    } catch (error) {
      if (isEnoent(error)) {
        continue
      }
      throw error
    }
    if (Date.now() - existing.mtimeMs > c.lease.staleMs) {
      try {
        unlinkSync(c.dest)
      } catch (error) {
        if (!isEnoent(error)) {
          throw error
        }
      }
      continue
    }
    if (Date.now() >= deadline) {
      throw new FsqliteError(
        'in-flight',
        `snapshot ${c.next} is held by a publication that neither finished nor went stale ` +
          `within ${c.lease.timeoutMs}ms; if no publisher is running, run repair`,
      )
    }
    sleepSync(c.lease.pollMs)
  }
}

/**
 * Remove `dest` only while it is still this holder's build and still ahead of `current`;
 * anything else there is another holder's entry or already published. When called while
 * an error is propagating, a cleanup failure must not hide that error: the entry is then a
 * recoverable orphan that a later publisher reclaims once stale, or that repair removes.
 */
function removeOwnOrphan(c: SnapshotCommit, expected: BuildIdentity, pending?: unknown): void {
  try {
    if (namesBuild(c.dest, expected) && c.readCurrent() < c.next) {
      unlinkSync(c.dest)
    }
  } catch (error) {
    if (pending === undefined && !isEnoent(error)) {
      throw error
    }
  }
}
