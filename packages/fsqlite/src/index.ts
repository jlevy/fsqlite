// fsqlite: a standalone, dependency-free, cross-platform, file-native concurrent SQLite
// store: immutable snapshot-publish + transaction-envelope changesets, guarded by an
// NFS-safe mkdir lease lock and an idempotent ledger; plus an easy-local DirectStore over
// the same on-disk format.
//
// See README.md for the rationale and the correctness model.

export { SnapshotStore } from './snapshotStore.ts'
export { DirectStore } from './directStore.ts'
export {
  ACTIONS,
  normalize,
  actionFor,
  applyWithPolicy,
  conflictName,
  StrictConflictError,
} from './conflictPolicy.ts'
export { withLock, ownerOf, heartbeat, LockTimeoutError } from './lock.ts'
export { constants, capabilities, backupTo } from './driver.ts'
export { inspect, formatReport, detectFsType } from './fsinspect.ts'

export type * from './types.ts'
export type { LockOptions, OwnerMeta } from './lock.ts'
export type { InspectReport, ProbeResult, FsType } from './fsinspect.ts'
