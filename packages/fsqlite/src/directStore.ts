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
import { FsqliteError } from './errors.ts'
import { fsyncPath, removeQuietly } from './fsutil.ts'
import { commitSnapshot } from './publication.ts'
import type { CommitOutcome } from './publication.ts'
import { withLock } from './lock.ts'
import type { LockOptions } from './lock.ts'
import { requireSafeInteger, SnapshotStore, verifySnapshotForPublish } from './snapshotStore.ts'
import { readStoreMarker } from './storeFormat.ts'
import type {
  StoreOptions,
  WorkFn,
  ReadFn,
  ValidateResult,
  GcOptions,
  GcResult,
  ReadLease,
  ReadLeaseOptions,
  RepairOptions,
  RepairResult,
} from './types.ts'

/**
 * DirectStore's configuration: the schema and its identity. It applies no changesets, so
 * it takes no merge policy and no envelope-size cap.
 */
export type DirectStoreOptions = Omit<StoreOptions, 'conflictPolicy' | 'maxEnvelopeBytes'>

/** Options for `DirectStore.write()`. Invalid values throw a `TypeError`. */
export interface DirectWriteOptions {
  /** Publish-lock options; `staleMs` must exceed the longest single step of a write. */
  lockOpts?: LockOptions
  /** Attempts after a lost publication race; an integer of at least 1, default 8. */
  maxRetries?: number
}

const rand = (): string => randomBytes(5).toString('hex')
const DEFAULT_DIRECT_WRITE_RETRIES = 8

/** The shared store engine under DirectStore's caller-schema rules. */
class DirectStrategyStore extends SnapshotStore {
  protected override assertStrategySchema(): void {
    // DirectStore never applies a changeset: a trigger fires once, inside the callback's own
    // transaction on the build, so trigger schemas are supported.
  }

  protected override assertPolicyTables(): void {
    // DirectStore never consults a conflict policy.
  }
}

/**
 * The serialized-writer strategy. Cooperative callers may contend for `write`, but the
 * publish lease admits one complete copy, callback, validation, and publication path at
 * a time. It produces the same on-disk format as {@link SnapshotStore}.
 */
export class DirectStore {
  private base: SnapshotStore

  constructor(dir: string, opts: DirectStoreOptions = {}) {
    this.base = new DirectStrategyStore(dir, opts)
  }

  /** Create the store if absent, otherwise verify it is schema-compatible; see `SnapshotStore#init`. */
  init(): this {
    this.base.init()
    return this
  }
  /** Read the published head; see `SnapshotStore#read`. */
  read<T>(fn: ReadFn<T>): T {
    return this.base.read(fn)
  }
  /** The version `current` names; see `SnapshotStore#currentVersion`. */
  currentVersion(): number {
    return this.base.currentVersion()
  }
  /** Classify the store's health; see `SnapshotStore#validate`. */
  validate(): ValidateResult {
    return this.base.validate()
  }
  /** Export the head as a standalone SQLite file; see `SnapshotStore#seal`. */
  seal(dest: string): string {
    return this.base.seal(dest)
  }
  /** Delete superseded snapshots; see `SnapshotStore#gc`. */
  gc(opts?: GcOptions): GcResult {
    return this.base.gc(opts)
  }
  /** Restore the last consistent point; see `SnapshotStore#repair`. */
  repair(opts?: RepairOptions): RepairResult {
    return this.base.repair(opts)
  }
  /** The steps `repair` would take, without taking them; see `SnapshotStore#planRepair`. */
  planRepair(opts?: RepairOptions): RepairResult {
    return this.base.planRepair(opts)
  }
  /** Pin the head against gc; see `SnapshotStore#readLease`. */
  readLease(opts?: ReadLeaseOptions): ReadLease {
    return this.base.readLease(opts)
  }
  /** The path of snapshot `v`, whether or not it exists. */
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
    { lockOpts = {}, maxRetries = DEFAULT_DIRECT_WRITE_RETRIES }: DirectWriteOptions = {},
  ): number {
    requireSafeInteger('maxRetries', maxRetries, 1)
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
            driver.rollbackQuietly(db)
            db.close()
            removeQuietly(tmp)
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
            removeQuietly(tmp) // only the uncommitted `.direct-` name, never a committed entry
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
    throw new FsqliteError(
      'retryable',
      `DirectStore.write exceeded retries after ${maxRetries} attempts (excessive publish contention)`,
    )
  }
}
