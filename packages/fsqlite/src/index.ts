// fsqlite provides filesystem-friendly concurrent SQLite through immutable snapshot
// publication, transaction-envelope changesets, a fenced mkdir lease, and an
// idempotent ledger. DirectStore provides a local single-writer strategy over the same
// format.
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
  PermanentConflictError,
} from './conflictPolicy.ts'
export { withLock, ownerOf, heartbeat, LockTimeoutError } from './lock.ts'
export { capabilities, backupDatabase } from './driver.ts'
export { inspect, formatReport, detectFsType } from './fsinspect.ts'
export { isSqliteFile, sqliteFacts, integrityReport } from './sqliteFacts.ts'
export {
  FSQLITE_APPLICATION_ID,
  STORE_FORMAT_NAME,
  STORE_FORMAT_VERSION,
  STORE_MARKER_FILENAME,
  StoreFormatError,
  recognizeStore,
  readStoreMarker,
} from './storeFormat.ts'

export type * from './types.ts'
export type { LockOptions, OwnerMeta } from './lock.ts'
export type { InspectReport, ProbeResult, FsType } from './fsinspect.ts'
export type { SqliteFacts } from './sqliteFacts.ts'
export type { BackupDatabaseOptions } from './driver.ts'
export type { StoreMarker, StoreRecognition, StoreRecognitionFailure } from './storeFormat.ts'
