// fsqlite provides filesystem-friendly concurrent SQLite through immutable snapshot
// publication, transaction-envelope changesets, a fenced mkdir lease, and an
// idempotent ledger. DirectStore provides a serialized-writer strategy over the same
// format.
//
// This module is the package's public API. Merge-policy, lock, and mount-detection
// helpers are implementation details and are not exported. See README.md for the
// rationale, the correctness model, and the error contract.

export { SnapshotStore, DEFAULT_RETAINED_SNAPSHOTS } from './snapshotStore.ts'
export { DirectStore } from './directStore.ts'
export {
  FsqliteError,
  StoreFormatError,
  ConflictError,
  StrictConflictError,
  PermanentConflictError,
  LockTimeoutError,
  PublishContentionError,
  PostPublishError,
  TransactionError,
} from './errors.ts'
export type { FsqliteErrorCode, StoreFormatErrorState } from './errors.ts'
export { capabilities, backupDatabase } from './driver.ts'
export { inspectFilesystem, formatInspectReport } from './fsinspect.ts'
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
export type { DirectStoreOptions, DirectWriteOptions } from './directStore.ts'
export type { LockOptions, OwnerMeta } from './lock.ts'
export type {
  FsType,
  InspectProbes,
  InspectReport,
  InspectVerdict,
  MkdirProbeResult,
  MtimeProbeResult,
  ProbeResult,
  RequiredProbe,
  WalProbeResult,
} from './fsinspect.ts'
export type { SqliteFacts, SqliteTableFacts } from './sqliteFacts.ts'
export type { BackupDatabaseOptions } from './driver.ts'
export type { StoreMarker, StoreRecognition, StoreRecognitionFailure } from './storeFormat.ts'
