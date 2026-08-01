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
- Separate caller-schema migration from fsqlite directory-format migration.
- Settle whether envelope `base_version` remains provenance or gains staleness rules.

### Shared Filesystems and Durability

- Run the correctness suite across at least two hosts on NFSv4.1/EFS, SMB, and
  representative managed shared filesystems.
- Exercise clock skew, attribute caching, stale-lock breaks, close-to-open visibility,
  and directory fsync behavior under real contention.
- Add block-device power-loss fault injection for snapshot and pointer publication.
- Design an optional durable-envelope receipt mode for writes that must survive power
  loss before reconcile.
- Expand `fsinspect` from single-host heuristics using evidence from those gates.
- Decide from the evidence whether a monotonic fence or single-host proxy lock is
  necessary.
- Add a heartbeat or shorter optimistic critical section for DirectStore and repair so
  operations longer than the lease stale window do not livelock.

### Platform and Runtime Portability

- Validate publication races and atomic replace behavior on Windows.
- Test packed artifacts across supported operating systems, architectures, and exact
  runtime floors.
- Prove changeset compatibility across SQLite releases and session-capable bindings.
- Add cross-language writers only after they pass the same independent conformance
  fixtures.
- Define and test Worker Thread coordination for multi-step operations.
- Cover SQLite URI modes plus paths containing symlinks, spaces, Unicode, drive letters,
  and UNC forms.

### Schema, Isolation, and Performance

- Specify deterministic caller-schema migration and quarantine writers using the wrong
  schema.
- Design declared read-set validation for point-key invariants; document stronger
  patterns for range, predicate, aggregate, and cross-row invariants.
- Evaluate SQLite rebaser support without making it a base-format dependency.
- Design and measure a safe overlay, shared read-only base, or equivalent writer seed
  that preserves the callback’s observed data and constraints for large stores.
- Measure explicit snapshot compaction and retention without weakening immutable
  publication.
- Research replay-based bit-rot recovery while keeping repair non-destructive and
  fail-closed.

## Stable-Release Bar

The minimum 1.0 bar is a settled public API, independent conformance fixtures and
verifier, real cross-host shared-filesystem evidence, explicit format-upgrade semantics,
and validated publication behavior on every claimed operating system.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
