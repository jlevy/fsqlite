# Changelog

All notable changes to fsqlite are documented here.

## 0.1.0 (Unreleased)

First public alpha: the draft `f1.0` store format and its Node reference implementation.
The API and format may change before 1.0, and real multi-host NFS/SMB and Windows
publication validation are still pending.

### Features

- **`f1.0` store format:** a self-identifying root (`fsqlite.json` with a UUID
  `store_id`), immutable SQLite snapshots named by an atomic `current` pointer, and the
  fixed SQLite `application_id` `0x4653514C` (`FSQL`). Not-a-store, invalid,
  unsupported, in-flight, and corrupt states stay distinct, and opening a store never
  upgrades it.
- **`SnapshotStore`:** writers capture SQLite session changesets as envelopes without
  taking the publish lock, and `reconcile()` folds them exactly once under per-table
  `lww`, `union`, or `strict` policies.
  Constraint and foreign-key outcomes quarantine the whole envelope, and foreign-key
  actions such as `ON DELETE CASCADE` apply once.
  `writeWithRetry()` re-runs a `strict` point-row write on a newer head.
  Schemas that declare triggers or an `ON CONFLICT REPLACE` or `IGNORE` key clause are
  rejected, because reconciliation would re-fire or silently resolve them.
- **`DirectStore`:** a serialized copy, mutate, and publish lane over the same format
  that needs no session extension and supports triggers.
- **Publication safety:** a snapshot commits by a no-replace hard link with identity
  checks around the pointer swap, so overlapping publishers cannot replace a published
  or in-flight snapshot.
  Snapshot, pointer, and directory fsyncs fail closed, envelopes are archived only once
  the published ledger holds them, and a failure after the new version is visible raises
  `PostPublishError` so callers do not re-run the write.
- **Maintenance:** `validate()`; a non-destructive `repair()` with a `planRepair()` dry
  run; a `gc()` that refuses an unhealthy store, holds the publish lock, and tombstones
  snapshots so a racing read lease keeps its snapshot; a disposable `readLease()`; an
  integrity-checked `seal()` that replaces its output atomically and refuses while
  envelopes are pending; and `backupDatabase()`. `init()` refuses an unmarked non-empty
  directory and a lineage that lost `current`, and reads retry when gc collects their
  snapshot.
- **Typed errors:** every deliberate failure is an `FsqliteError` with a stable `code`
  and a `retryable` flag, with subclasses for recognition, conflicts, lock timeouts,
  post-publish failures, and unpublished `writeWithRetry` transactions.
- **CLI:** `fsqlite info|validate|stats|gc|seal|repair|doctor|fsinspect` with `--json`,
  strict argument parsing, and one exit-code table; `stats` and `doctor` also accept
  plain SQLite files, and `fsqlite/cli` exports `main()` for in-process use.
- **Package:** zero runtime dependencies, no install scripts, ESM with types, and Node
  `>=22.18.0 <23 || ^24.0.0 || >=26.0.0` (24.22 or 26.8 and later recommended).
  Every connection pins SQLite’s defensive mode where `node:sqlite` offers it, and none
  enables extension loading.

### Performance and Diagnostics

- **Pointer diagnostics:** `current` is read only up to 64 bytes, and an error quotes at
  most 32 characters of a corrupt pointer, so a large file renamed over `current` is
  never loaded or echoed whole into logs.

### Changes From the July 2026 Repository Snapshot

The repository has carried an unpublished `0.1.0` since July 2026. Code written against
that snapshot needs these changes:

- **Trigger schemas:** `SnapshotStore` rejects them; use `DirectStore` for such a
  schema.
- **Changeset keys and policies:** `SnapshotStore` rejects key clauses using
  `ON CONFLICT REPLACE` or `IGNORE`, and nullable `INTEGER PRIMARY KEY DESC` keys.
  A conflict-policy key naming an absent caller table fails initialization.
- **Options and read leases:** invalid limits for garbage collection, reconciliation,
  retries, lease acquisition, or envelope size throw `TypeError`. A lost read pin makes
  `heartbeat()` throw.
  A failed release reports `io`.
- **Errors:** branch on `FsqliteError.code` and `retryable`, not on message text.
  `writeWithRetry()` throws a non-retryable `TransactionError` when it captured a write
  it could not publish.
- **CLI exit codes:** a failing command exits with the code of its error, such as `4`
  for an unsupported store, instead of `1`; `fsinspect` exits `5` (was `1`) when the
  filesystem cannot host a store; and unknown options or extra arguments are usage
  errors (`64`). `fsinspect` probes only an existing directory.
- **API:** `inspect` and `formatReport` are now `inspectFilesystem` and
  `formatInspectReport`; the merge-policy, lock, and mount-detection helpers are no
  longer exported; `capabilities()` no longer reports `loadExtension`; and importing
  `fsqlite/cli` no longer runs the CLI.
- **Node 25:** the `engines` range excludes this end-of-life line.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
