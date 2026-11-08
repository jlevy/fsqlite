// directStore.ts provides the serialized-writer strategy over the same immutable
// snapshot format as SnapshotStore.
//
// A writer holds the publish lock while it copies, mutates, and publishes the next
// snapshot. DirectStore needs no changesets, transaction envelopes, reconcile step, or
// conflict policy. It also needs no session extension, so its strategy works with a
// standard SQLite build. This implementation uses node:sqlite; another binding requires
// an adapter.
//
// Both strategies produce the same snapshots and current pointer, so readers and writers
// can use either strategy without changing the store format.

import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as driver from './driver.ts'
import { fsyncPath } from './fsutil.ts'
import { commitSnapshot } from './publication.ts'
import type { CommitOutcome } from './publication.ts'
import { withLock } from './lock.ts'
import type { LockOptions } from './lock.ts'
import { SnapshotStore, verifySnapshotForPublish } from './snapshotStore.ts'
import { readStoreMarker } from './storeFormat.ts'
import type {
  StoreOptions,
  WorkFn,
  ReadFn,
  ValidateResult,
  GcOptions,
  GcResult,
  ReadLease,
  RepairResult,
} from './types.ts'

const rand = (): string => randomBytes(5).toString('hex')
const DEFAULT_DIRECT_WRITE_RETRIES = 8

/**
 * The serialized-writer strategy. Cooperative callers may contend for `write`, but the
 * publish lease admits one complete copy, callback, validation, and publication path at
 * a time. It produces the same on-disk format as {@link SnapshotStore}.
 */
export class DirectStore {
  private base: SnapshotStore

  constructor(dir: string, opts: StoreOptions = {}) {
    this.base = new SnapshotStore(dir, opts)
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
  gc(opts?: GcOptions): GcResult {
    return this.base.gc(opts)
  }
  repair(opts?: { lockOpts?: LockOptions }): RepairResult {
    return this.base.repair(opts)
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
   * publishing into the same store). Retries internally on a lost race, rerunning `fn`.
   * Returns the published version, which always carries this call's mutation.
   *
   * An error with a numeric `published` property (`PostPublishError`) was raised after
   * that version became current (for example a failed directory fsync after the pointer
   * rename): the write is visible and must not be re-run. Any other error published nothing.
   */
  write(
    fn: WorkFn,
    {
      lockOpts = {},
      maxRetries = DEFAULT_DIRECT_WRITE_RETRIES,
    }: { lockOpts?: LockOptions; maxRetries?: number } = {},
  ): number {
    const marker = readStoreMarker(this.base.dir)
    this.base.read((db) => {
      verifySnapshotForPublish(db, marker, this.base.schemaVersion, this.base.schemaHash)
    })
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const out = withLock(
        this.base.publishLock,
        (_token, lease): number | 'retry' => {
          const base = this.base.currentVersion()
          const next = base + 1
          const tmp = join(this.base.snapDir, `.direct-${rand()}.sqlite`)
          const abandon = (): 'retry' => {
            rmSync(tmp, { force: true })
            return 'retry'
          }
          copyFileSync(this.base.snapshotPath(base), tmp)
          if (!lease.heartbeat()) {
            return abandon()
          }
          const db = driver.open(tmp)
          try {
            driver.protectOwnedTables(db)
            const boundary = driver.captureCallbackBoundary(db)
            db.exec('BEGIN IMMEDIATE')
            fn(db)
            driver.assertCallbackBoundary(db, boundary)
            verifySnapshotForPublish(
              db,
              readStoreMarker(this.base.dir),
              this.base.schemaVersion,
              this.base.schemaHash,
            )
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
          // Revalidate fencing and optimistic concurrency before publication. The fence
          // also renews the lease the callback and checks may have run down.
          if (this.base.currentVersion() !== base || !lease.fence()) {
            return abandon()
          }
          fsyncPath(tmp) // durable snapshot before it can be named by current
          if (this.base.currentVersion() !== base || !lease.fence()) {
            return abandon()
          }
          let outcome: CommitOutcome
          try {
            outcome = commitSnapshot({
              storeDir: this.base.dir,
              currentPath: this.base.currentPath,
              snapDir: this.base.snapDir,
              build: tmp,
              dest: this.base.snapshotPath(next),
              base,
              next,
              readCurrent: () => this.base.currentVersion(),
              lease,
            })
          } catch (error) {
            abandon() // removes only the uncommitted `.direct-` name, never a committed entry
            throw error
          }
          return outcome === 'published' ? next : abandon()
        },
        lockOpts,
      )
      if (out !== 'retry') {
        return out
      }
    }
    throw new Error('DirectStore.write exceeded retries (excessive publish contention)')
  }
}
