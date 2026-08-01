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
Deferring the work here does not weaken the alpha contract: unsupported capabilities
must fail closed, normal opens never migrate a store, and claims not yet validated
remain disclosed.

## Fixed Starting Point

- A store is a dedicated caller-provided directory identified only by root
  `fsqlite.json`.
- The initial format version is the string `f1.0`, using the grammar `f<major>.<minor>`.
- The marker carries `format`, `format_version`, `required_features`, and UUID
  `store_id`.
- Snapshots and transaction manifests repeat the format version and store identity.
- Snapshot SQLite files use the fixed fsqlite `application_id`; callers own
  `PRAGMA user_version` and `schema_hash`.
- Unknown optional metadata is ignored.
  Unknown required features and unsupported versions block operation without repair or
  mutation.
- Major format upgrades are explicit and side-by-side by default.
  They preserve `store_id`, validate the destination, and leave the source untouched
  until cutover.
- Caller-schema migration and fsqlite directory-format migration are separate protocols.

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
| `fsq-x5k5` | Replay-based bit-rot recovery research |
| `fsq-a0ct` | SQLite URI and store-path portability validation |

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
- Use the shared-filesystem evidence to decide whether a monotonic fence or a
  single-host proxy-lock gate is warranted.
- Measure `DELETE`, `TRUNCATE`, and `PERSIST` rollback-journal variants for DirectStore,
  retaining `DELETE` as the compatibility baseline unless the evidence supports an
  explicit alternative.
- Research replay-based bit-rot recovery without making repair destructive or
  speculative.

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

### Schema and Isolation Evolution

- Specify deterministic caller-schema migration across immutable snapshot generations,
  with quarantine rules for writers on the wrong schema.
- Design declared read-set validation for point-key invariants.
- Require version-stamped guard rows or DirectStore for range, predicate, and aggregate
  invariants that cannot be made safe by a declared point-key read set.
- Evaluate SQLite rebaser support and upstream binding improvements without making them
  prerequisites for the base format.
- Measure schema-only writer seeding, safe read-only-base approaches, and explicit
  snapshot compaction/retention for large stores.

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

## Non-Goals

- A server, catalog service, or consensus layer required for ordinary operation
- Silent fallback when a capability is unsupported
- Automatic migration during open
- Compatibility shims for unpublished development formats

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
