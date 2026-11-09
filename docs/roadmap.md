# fsqlite Roadmap

The alpha establishes the first self-identifying store format and Node reference
implementation. The work below is evidence required for broader compatibility and a
stable release, not a promise that unsupported environments work today.

## Before 1.0

### Conformance and Format Evolution

- Publish golden stores for every recognition, health, envelope, and recovery outcome.
- Build a verifier independent of the Node implementation.
- Specify explicit side-by-side whole-format upgrades that preserve `store_id`, validate
  the destination, and leave the source untouched until cutover.
- Settle whether envelope `base_version` remains provenance or gains staleness rules.
- Publish builds under unique snapshot filenames in an `f1.1` revision, with a pointer
  protocol that cannot move `current` backward, so overlapping publishers never share a
  path (spec O6).
- Decide whether repair should delete only stale transients, as gc does, so a repair
  cannot remove a live writer’s in-progress files.

### Shared Filesystems and Durability

- Run the correctness suite across at least two hosts on NFSv4.1/EFS, SMB, and
  representative managed shared filesystems.
- Exercise clock skew, attribute caching, abandoned-lock recovery, close-to-open
  visibility, and directory fsync behavior under real contention.
- Add block-device power-loss fault injection for snapshot and pointer publication.
- Design an optional durable-envelope receipt mode for writes that must survive power
  loss before reconcile.
- Expand `fsinspect` from single-host heuristics using evidence from those gates.
- Fall back to copy-then-remove when an envelope move hits `EXDEV`, as it can on an
  overlayfs lower layer (spec O7).
- Keep consumer synchronization folders outside the supported shared-filesystem model
  unless a separate replication and consistency protocol is validated.
- Decide from the evidence whether a monotonic fence or single-host proxy lock is
  necessary.
- Shorten the DirectStore critical section with an optimistic protocol that moves the
  copy and callback outside the lock, reducing the wait for competing publishers.
- Measure the `DELETE`, `TRUNCATE`, and `PERSIST` rollback-journal variants for
  DirectStore, keeping `DELETE` unless the evidence supports an alternative.
- Close two narrow gc races: a stale-transient sweep that could delete a tombstone whose
  restore failed, and a reconcile build copy whose base snapshot gc collects mid-copy.

### Platform and Runtime Portability

- Resolve the Windows mutation blockers first: Node cannot fsync a directory there, and
  SQLite opens snapshots without `FILE_SHARE_DELETE`, so an open snapshot cannot be
  renamed over or unlinked (spec O1). Then validate publication races, or declare
  Windows reader-only.
- Test packed artifacts across supported operating systems, architectures, and exact
  runtime floors, including Node 26 (Active LTS since 2026-10-28) and, under Node’s
  one-major-per-year release model, each October alpha line (Node 27 now, Current from
  2027-04-22).
- Drop Node 22 support at its end of life (2027-04-30) or at 1.0, whichever comes first:
  the 22 line lacks the 2026 `node:sqlite` memory-safety fixes.
- Enforce the no-DDL callback boundary with `node:sqlite`’s `setAuthorizer()` (Node
  24.10 and later) where the binding offers it.
- Prove changeset compatibility across SQLite releases and session-capable bindings.
- Add cross-language writers only after they pass the same independent conformance
  fixtures.
- Define and test Worker Thread coordination for multi-step operations.
- Cover SQLite URI modes plus paths containing symlinks, spaces, Unicode, drive letters,
  and UNC forms.

### Schema, Isolation, and Long-Lived Stores

- Specify deterministic caller-schema migration and implement a supported maintenance
  workflow. Cover quiescence, writer admission, old pending envelopes, ordinary SQLite
  DDL and data transformation, policy transition, validation, rollback, and cutover.
  Keep the application-managed replacement procedure as the documented fallback.
- Bind the normalized conflict policy to a store or schema epoch, or add an equivalent
  admission check, so reconcilers cannot silently use different merge semantics.
- Design declared read-set validation for point-key invariants; document stronger
  patterns for range, predicate, aggregate, and cross-row invariants.
- Design a crash-safe checkpoint for the lifetime `applied_tx` ledger so reconcile time,
  memory, and snapshot bytes do not grow without bound.
- Expose snapshot, retention, lease, pending-envelope, quarantine, and ledger capacity
  metrics so operators can measure the variables that drive cost.

### Performance and Recovery Improvements

- Evaluate SQLite rebaser support without making it a base-format dependency.
- Ask Node to expose `sqlite3changeset_apply_v3()`: SQLite 3.51.0 added it, and its
  per-change filter receives the change iterator (table, operation, and values).
  Node’s binding still calls the original `sqlite3changeset_apply()`, so exposing that
  filter is the smallest upstream change that would give fsqlite the table name without
  changing `onConflict`. Neither 3.51.0 nor 3.53.0’s per-change changegroup builders
  change the changeset blob format.
- Design and measure a safe overlay, shared read-only base, or equivalent writer seed
  that preserves the callback’s observed data and constraints for large stores.
- Measure explicit snapshot compaction and retention without weakening immutable
  publication.
- Research replay-based bit-rot recovery while keeping repair non-destructive and
  fail-closed.

## Stable-Release Bar

The minimum 1.0 bar is a settled public API, independent conformance fixtures and
verifier, real cross-host shared-filesystem evidence, power-loss fault-injection
evidence, changeset compatibility across the SQLite releases the package admits,
explicit format-upgrade semantics, a supported caller-schema maintenance protocol, a
verified conflict-policy identity for each store epoch, bounded or explicitly
rollover-managed ledger growth, and validated publication behavior on every claimed
operating system.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
