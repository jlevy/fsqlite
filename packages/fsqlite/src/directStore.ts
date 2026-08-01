// directStore.ts: the "easy local" write strategy, over the same immutable snapshot
// format as SnapshotStore.
//
// Alongside the safe, file-native, lock-free, NFS-safe multi-writer engine
// (SnapshotStore), DirectStore is the "complete, reliable format with easier locking
// when running locally and standalone." A single writer holds the publish lock and
// builds the next snapshot by copy, mutate, publish, synchronously. There are
//
//   - no changesets, no transaction envelopes, no reconcile step, no conflict policy;
//   - and crucially no session extension required even for the writer, so DirectStore runs
//     on a stock SQLite build, not only a session-enabled one. It still uses node:sqlite via
//     the driver; binding-agnostic operation would need a binding adapter (not yet built).
//
// Format compatibility is the point: a store written by DirectStore is byte-identical in
// shape to one written by SnapshotStore (snapshots/ and current), so the two modes
// interoperate: any reader opens either without knowing which wrote it.

import { copyFileSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as driver from './driver.ts'
import { fsyncPath, fsyncDir } from './fsutil.ts'
import { withLock, ownerOf } from './lock.ts'
import type { LockOptions } from './lock.ts'
import { SnapshotStore } from './snapshotStore.ts'
import type { StoreOptions, WorkFn, ReadFn, ValidateResult, GcResult, ReadLease } from './types.ts'

const rand = (): string => randomBytes(5).toString('hex')

/**
 * The easy-local single-writer strategy: each `write` synchronously copies the current
 * snapshot, mutates the copy, and publishes it under the lease lock, with no changesets, no
 * reconcile, and no session extension even for the writer (so it runs on a stock SQLite build).
 * It writes the identical on-disk format as {@link SnapshotStore} (read/seal/gc/validate
 * delegate there), so a store is interoperable between the two strategies.
 */
export class DirectStore {
  private base: SnapshotStore

  constructor(dir: string, opts: StoreOptions = {}) {
    this.base = new SnapshotStore(dir, opts) // reuse layout, init, read, validate, seal, gc
  }

  init(): this {
    this.base.init()
    return this
  }
  read<T>(fn: ReadFn<T>): T {
    return this.base.read(fn)
  }
  currentVersion(): number {
    return this.base.currentVersion()
  }
  validate(): ValidateResult {
    return this.base.validate()
  }
  seal(dest: string): string {
    return this.base.seal(dest)
  }
  gc(opts?: { retain?: number; leaseStaleMs?: number }): GcResult {
    return this.base.gc(opts)
  }
  readLease(): ReadLease {
    return this.base.readLease()
  }
  snapshotPath(v: number): string {
    return this.base.snapshotPath(v)
  }

  /**
   * Synchronous copy, mutate, publish under the publish lock, with OCC on the
   * `current` pointer (so it also composes safely with a SnapshotStore reconcile
   * publishing into the same store). Retries internally on a lost race.
   */
  write(fn: WorkFn, { lockOpts = {}, maxRetries = 8 }: { lockOpts?: LockOptions; maxRetries?: number } = {}): number {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const out = withLock(
        this.base.publishLock,
        (token): number | 'retry' => {
          const base = this.base.currentVersion()
          const next = base + 1
          const tmp = join(this.base.snapDir, `.direct-${rand()}.sqlite`)
          copyFileSync(this.base.snapshotPath(base), tmp)
          const db = driver.open(tmp)
          try {
            db.exec('BEGIN IMMEDIATE')
            fn(db)
            db.exec('COMMIT')
            driver.quickCheck(db)
          } catch (e) {
            try {
              db.exec('ROLLBACK')
            } catch {
              /* ignore */
            }
            db.close()
            rmSync(tmp, { force: true })
            throw e
          }
          db.close()
          // Re-validate under the lock before the destructive publish (fencing + OCC).
          if (this.base.currentVersion() !== base) {
            rmSync(tmp, { force: true })
            return 'retry'
          }
          if (ownerOf(this.base.publishLock) !== token) {
            rmSync(tmp, { force: true })
            return 'retry'
          }
          fsyncPath(tmp) // durable snapshot before it can be named by current
          renameSync(tmp, this.base.snapshotPath(next))
          fsyncDir(this.base.snapDir)
          this.base._publishPointer(next)
          return next
        },
        lockOpts,
      )
      if (out !== 'retry') return out
    }
    throw new Error('DirectStore.write exceeded retries (excessive publish contention)')
  }
}
