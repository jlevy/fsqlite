# Feature: fsqlite Post-Alpha Format and Portability Roadmap

**Date:** 2026-07-31

**Author:** Joshua Levy (with LLM assistance)

**Status:** Future

**Tracking epic:** `fsq-2hpr`

## Overview

Extend the `f1.0` alpha into an independently implementable, migration-safe,
cross-platform storage protocol.
This plan collects the work deliberately deferred from the alpha release so each
commitment has an owner, dependency path, and validation bar.

The alpha release remains governed by `plan-2026-07-31-fsqlite-alpha-release.md`.
Unsupported capabilities must fail closed, normal opens never migrate a store, and
claims not yet validated remain disclosed.
The system constraints and operating boundaries are in `docs/fsqlite-design.md`; this
plan tracks work and does not redefine them.

## Fixed Starting Point

- A store is a dedicated caller-provided directory identified only by root
  `fsqlite.json`.
- The initial format version is the string `f1.0`, using the grammar `f<major>.<minor>`.
- The marker carries `format`, `format_version`, `required_features`, and UUID
  `store_id`.
- Snapshots and transaction manifests repeat the format version and store identity.
- Snapshot SQLite files use the fixed fsqlite `application_id`; callers own
  `PRAGMA user_version` and `schema_hash`.
- In `f1.0`, `schema_version` and the exact-DDL `schema_hash` form one immutable
  caller-schema identity.
  A version bump rejects an existing store; it does not migrate it.
- Conflict policy is deployment configuration rather than stamped metadata.
  Every reconciler in one caller-schema epoch must use the same effective policy.
- Unknown optional metadata is ignored.
  Unknown required features and unsupported versions block operation without repair or
  mutation.
- Major format upgrades are explicit and side-by-side by default.
  They preserve `store_id`, validate the destination, and leave the source untouched
  until cutover.
- Caller-schema migration and fsqlite directory-format migration are separate protocols.
- Until a caller-schema migration protocol exists, the safe procedure is to quiesce and
  drain the old store, validate and seal it, build a separate replacement under the new
  schema, validate it, and move every process in one application-managed cutover.
  The replacement is a new logical store with a new `store_id`.
- SnapshotStore callbacks run against a full copy of the published head.
  The unsafe schema-only shortcut is not part of `f1.0`.
- Write callbacks cannot mutate persistent or temporary schema, identity, schema
  version, or fsqlite-owned tables.
  DirectStore revalidates the candidate before publication.

## Workstreams

| Bead | Work |
| --- | --- |
| `fsq-2reg` | Format conformance fixtures and independent verifier |
| `fsq-65t4` | Explicit side-by-side whole-format upgrades |
| `fsq-at6m` | Real multi-host shared-filesystem correctness gate |
| `fsq-hm6r` | Power-loss fault injection and durable-envelope mode |
| `fsq-kkdi` | Windows atomic publication and race validation |
| `fsq-out1` | Cross-version and cross-binding changeset compatibility |
| `fsq-ch62` | Cross-language writers against the conformance suite |
| `fsq-xma9` | Deterministic caller-schema migration |
| `fsq-ewdf` | Declared read-set validation for point-key invariants |
| `fsq-5nx4` | Worker Thread coordination contract and tests |
| `fsq-qeak` | Expanded shared-filesystem and sync diagnostics |
| `fsq-y627` | Rebaser support and upstream binding enhancements |
| `fsq-gv1o` | Future `base_version` staleness semantics |
| `fsq-39gh` | DirectStore rollback-journal variant measurements |
| `fsq-fp06` | Writer seeding and snapshot-compaction optimization |
| `fsq-bllj` | Applied transaction ledger checkpointing and bounds |
| `fsq-3a09` | Capacity and reconciliation backlog observability |
| `fsq-x5k5` | Replay-based bit-rot recovery research |
| `fsq-a0ct` | SQLite URI and store-path portability validation |
| `fsq-ffdq` | Heartbeat or critical-section redesign for long publish-lock operations |
| `fsq-dwwg` | Remove redundant marker and snapshot identity reads from hot paths |

### Conformance and Format Evolution

- Publish golden stores covering every recognition and health state, envelope outcome,
  and crash-recovery boundary.
- Build a verifier that does not depend on the Node implementation under test.
- Specify and implement explicit side-by-side whole-format upgrades, including stable
  source capture, destination validation, identity preservation, and restart behavior.
- Decide whether `base_version` remains provenance-only or gains staleness semantics in
  a later minor revision.

### Shared-Filesystem and Durability Validation

- Run real cross-host contention on NFSv4.1/EFS, SMB, and representative managed shared
  filesystems.
- Exercise clock skew, attribute caching, stale-lock breaks, close-to-open visibility,
  and directory fsync behavior.
- Add block-device power-loss fault injection for snapshot and pointer publication.
- Specify an optional durable-envelope receipt mode for callers that need accepted
  writes to survive power loss before reconcile.
- Expand `fsinspect` with evidence-based shared-filesystem and cloud-sync diagnostics.
- Keep consumer synchronization folders outside the shared-filesystem support claim
  unless a separate replication and consistency protocol is defined and tested.
- Use the shared-filesystem evidence to decide whether a monotonic fence or a
  single-host proxy-lock gate is warranted.
- Measure `DELETE`, `TRUNCATE`, and `PERSIST` rollback-journal variants for DirectStore,
  retaining `DELETE` as the compatibility baseline unless the evidence supports an
  explicit alternative.
- Research replay-based bit-rot recovery without making repair destructive or
  speculative.
- Add a safe heartbeat or shorter optimistic critical section for DirectStore and repair
  operations that may exceed the lease stale window.

### Platform and Runtime Portability

- Implement and validate atomic rename-replace on Windows under racing publishers.
- Test packed artifacts across supported operating systems, architectures, and the exact
  runtime floor.
- Prove changeset compatibility across SQLite versions and session-capable bindings
  before claiming cross-language writer parity.
- Implement Python, Rust, or Go writers only after they pass the same conformance
  fixtures as the Node reference implementation.
- Add Worker Thread validation and define process-local serialization for multi-step
  operations.
- Validate SQLite URI modes and store paths containing symlinks, spaces, Unicode,
  Windows drive paths, and UNC paths.

### Schema, Isolation, and Scale Evolution

- Specify and implement deterministic caller-schema migration across immutable snapshot
  generations, with writer admission and quarantine rules for participants on the wrong
  schema. The supported maintenance workflow must improve on, or intentionally retain,
  the application-managed replacement fallback.
- Define quiescence or fencing, handling of old committed envelopes, deterministic DDL
  and data transformation using SQLite’s documented schema-change procedures, constraint
  validation, conflict-policy transition, atomic cutover, interruption recovery,
  rollback, and old-writer behavior.
- Design declared read-set validation for point-key invariants.
- Require version-stamped guard rows or DirectStore for range, predicate, and aggregate
  invariants that cannot be made safe by a declared point-key read set.
- Evaluate SQLite rebaser support and upstream binding improvements without making them
  prerequisites for the base format.
- Design and measure a safe overlay, shared read-only base, or equivalent writer seed
  for large stores. It must preserve the data and constraints observed by the callback.
- Remove redundant identity reads only after preserving fail-closed behavior across
  marker replacement and mixed-store tests.
- Measure explicit snapshot compaction and retention for large stores.
- Design a crash-safe checkpoint for `applied_tx`. It must preserve exactly-once
  behavior if an old archived or copied envelope reappears, and it must define repair
  and format compatibility.
- Extend `stats` with current snapshot bytes, retained and leased bytes, pending
  envelope count and bytes, quarantine count and bytes, applied-ledger count, and
  reconcile duration. Keep thresholds workload-specific rather than encoding one
  universal limit.

## Dependency Shape

1. Conformance fixtures and the verifier define the interoperability gate.
2. Format upgrades, Windows publication, changeset compatibility, and durability work
   build against that gate.
3. Cross-language writers depend on changeset compatibility and conformance fixtures.
4. Caller-schema migration depends on the explicit format-upgrade boundary being clear,
   so the two migration classes cannot be conflated.
5. Stronger isolation and binding enhancements can proceed independently after the alpha
   API settles.
6. Performance and recovery investigations begin from conformance fixtures so an
   optimization or repair proposal cannot silently redefine the format.
7. Ledger checkpointing depends on conformance fixtures that replay old envelopes and
   interrupt every checkpoint boundary.

## Validation

- Every format implementation passes the same fixture verifier.
- Upgrade tests prove source preservation, destination validation, stable `store_id`,
  and safe restart after interruption at each write boundary.
- Real shared-filesystem tests use at least two hosts and retain the mount/runtime
  configuration with the result.
- Power-loss tests exercise the required fsync order, not only process termination.
- Cross-language writers round-trip changesets in both directions and converge on
  byte-independent but logically equivalent snapshots.
- Windows tests race publishers through the actual replace primitive.
- Path tests cover URI handling, symlinks, spaces, Unicode, drive-letter paths, and UNC
  paths without conflating path normalization with store identity.
- Caller-schema migration tests cover old pending envelopes, old writers after cutover,
  policy transition, deterministic data transformation, rollback, and every crash
  boundary.
- Performance work records snapshot bytes, pending count and bytes, ledger count,
  retained bytes, writer concurrency, and reconcile cadence with every result.

## Stable-Release Outcomes

Before 1.0, the project must have a settled public API, independent conformance fixtures
and verifier, real cross-host filesystem evidence, explicit whole-format upgrade
semantics, a supported caller-schema maintenance protocol, bounded or explicitly
rollover-managed ledger growth, and validated publication on every claimed operating
system.

## Non-Goals

- A server, catalog service, or consensus layer required for ordinary operation
- Silent fallback when a capability is unsupported
- Automatic migration during open
- Compatibility shims for unpublished development formats

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
