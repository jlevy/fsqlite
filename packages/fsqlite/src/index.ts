// fsqlite provides filesystem-friendly concurrent SQLite through immutable snapshot
// publication, transaction-envelope changesets, a fenced mkdir lease, and an
// idempotent ledger. DirectStore provides a serialized-writer strategy over the same
// format.
//
// See README.md for the rationale and the correctness model.

export { SnapshotStore } from './snapshotStore.ts'
export { DirectStore } from './directStore.ts'
export { ACTIONS, normalize, actionFor, applyWithPolicy, conflictName } from './conflictPolicy.ts'
export {
  FsqliteError,
  StoreFormatError,
  ConflictError,
  StrictConflictError,
  PermanentConflictError,
  LockTimeoutError,
  PostPublishError,
  TransactionError,
} from './errors.ts'
export type { FsqliteErrorCode, StoreFormatErrorState } from './errors.ts'
export { withLock, ownerOf, heartbeat } from './lock.ts'
export { capabilities, backupDatabase } from './driver.ts'
export { inspect, formatReport, detectFsType } from './fsinspect.ts'
export { isSqliteFile, sqliteFacts, integrityReport } from './sqliteFacts.ts'
export {
  FSQLITE_APPLICATION_ID,
  STORE_FORMAT_NAME,
  STORE_FORMAT_VERSION,
  STORE_MARKER_FILENAME,
  recognizeStore,
  readStoreMarker,
} from './storeFormat.ts'

export type * from './types.ts'
export type { LockLease, LockOptions, OwnerMeta } from './lock.ts'
export type { InspectReport, ProbeResult, FsType } from './fsinspect.ts'
export type { SqliteFacts } from './sqliteFacts.ts'
export type { BackupDatabaseOptions } from './driver.ts'
export type { StoreMarker, StoreRecognition, StoreRecognitionFailure } from './storeFormat.ts'
