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
  run; a `gc()` that refuses to delete from an unhealthy store, holds the publish lock,
  and tombstones snapshots so a racing read lease keeps its snapshot; a disposable
  `readLease()`; an integrity-checked `seal()` that replaces its output atomically and
  refuses while envelopes are pending; and `backupDatabase()`. `init()` refuses an
  unmarked non-empty directory and a lineage that lost `current`, and reads retry when
  gc collects their snapshot.
- **Typed errors:** every deliberate failure is an `FsqliteError` with a stable `code`
  and a `retryable` flag, with subclasses for recognition, conflicts, lock timeouts,
  exhausted publish retries, post-publish failures, and unpublished `writeWithRetry`
  transactions.
- **CLI:** `fsqlite info|validate|stats|gc|seal|repair|doctor|fsinspect` with `--json`,
  strict argument parsing, and one exit-code table; `stats` and `doctor` also accept
  plain SQLite files, and `fsqlite/cli` exports `main()` for in-process use.
- **Package:** zero runtime dependencies, no install scripts, ESM with types, and Node
  `>=22.18.0 <23 || ^24.0.0 || >=26.0.0` (24.22 or 26.8 and later recommended).
  Every connection pins SQLite’s defensive mode where `node:sqlite` offers it, and none
  enables extension loading.

### Performance and Diagnostics

- **Capture:** a `SnapshotStore` writer’s private working copy runs with SQLite
  `synchronous = OFF`, so capture no longer fsyncs a head-sized file it deletes moments
  later. On one cloud VM, median capture in the seed benchmark fell to about a third: 2.1
  to 2.6 ms (from 7.7 to 8.1 ms) for a 2.0 MiB head and 13.4 to 14.6 ms (from 39.4 to
  47.4 ms) for a 21.7 MiB head.
- **No-op gc:** a `gc()` with no snapshot old enough to delete skips the head’s
  `integrity_check` and `foreign_key_check`, which read the whole head, and still
  refuses a store that fails recognition, the pointer, head identity, or the ledger
  lineage. `GcResult.integrityChecked` and the `integrity check:` field of `fsqlite gc`
  say whether the full check ran.
  On a 39.5 MiB head with few archived transactions its median fell from about 20 ms to
  about 1 ms; each archived transaction still adds one ledger lookup (about 4 µs), so a
  store with 30,000 archived transactions still pays about 125 ms.
- **Pointer diagnostics:** `current` content longer than 64 bytes or naming a version
  above 2^53 − 1 is corruption (spec P1), only ASCII whitespace around the digits is
  trimmed, and an error quotes at most 32 characters of a corrupt pointer, escaped, so a
  large file renamed over `current` is never loaded or echoed whole into logs.

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
