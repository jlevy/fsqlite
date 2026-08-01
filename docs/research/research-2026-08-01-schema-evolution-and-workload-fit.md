# fsqlite Schema Evolution and Workload Fit

**Date:** 2026-08-01

**Status:** Current design assessment for the `0.1.0` alpha

## Executive Assessment

fsqlite still fits its intended use: cooperative local processes and agents that record
modest metadata transactions, can accept reconciliation-based visibility, and value
portable SQLite snapshots without a required service.

The review does not justify a format redesign or reduce the core value of the approach.
It does narrow the useful operating envelope:

- `f1.0` has one immutable caller-schema identity.
  It detects incompatible schemas but does not migrate them.
- Snapshot capture and publication scale primarily with snapshot bytes, not the number
  of tables or changed rows.
- Lock-free capture removes writer serialization, but concurrent agents still share disk
  bandwidth and create one working copy per in-flight write.
- Reconciliation adds costs that grow with pending envelope count, envelope bytes, and
  the lifetime `applied_tx` ledger.
- Multi-host shared-filesystem behavior remains a design target, not a validated alpha
  claim. Consumer synchronization folders are outside the supported model.

The most important residual limitations are medium severity for the intended workload
and high severity outside it.
A large, frequently updated database, rolling schema deployments, serializable business
transactions, or an unvalidated network filesystem should use another design or wait for
the relevant roadmap work.

## Review Scope and Evidence

This assessment checked the full
[PR #1 review](https://github.com/jlevy/fsqlite/pull/1), the current source and tests,
the [design constraints](../fsqlite-design.md), the
[format specification](../fsql-format-spec.md), and the [roadmap](../roadmap.md).

Evidence labels in this document mean:

- **Specified:** required by the normative `f1.0` format
- **Tested:** covered by the current automated suite
- **Measured:** observed in a local benchmark and not promised on other hardware
- **Inferred:** derived from the algorithm or measurements and requiring workload
  validation before adoption
- **Open:** tracked work without sufficient evidence for a broader claim

The local measurements below used Node 24.13.0 on an Apple M1 Pro with APFS solid-state
storage. They are two back-to-back calibrations intended to expose scaling shape and
run-to-run variation, not stable benchmarks or package guarantees.
The maintained commands are:

```sh
pnpm -F fsqlite benchmark:seed
pnpm -F fsqlite benchmark:workload-fit
```

Both commands report the runtime, operating system, CPU, method, snapshot bytes, and
timing fields as JSON.

## Finding Dispositions

| Area | Severity | Disposition | Remaining boundary |
| --- | --- | --- | --- |
| Merge closure over primary key, `NOT NULL`, `UNIQUE`, `CHECK`, and foreign keys | High if absent | Addressed | General range, predicate, aggregate, and cross-row invariants are not inferred. |
| Deterministic merge order and exactly-once ledgering | High if absent | Addressed | Conflict policy is deployment configuration and must be consistent across reconcilers. |
| Caller-schema compatibility | Medium | Addressed for detection and admission | `f1.0` rejects change. It has no migration protocol. |
| Invalid `schemaVersion` values and wrong-schema write handles | Medium | Addressed | Application code should still call `init()` before normal use. |
| Snapshot copy cost | Medium in the intended range; high for large or frequent writes | Disclosed and measured | Safe overlays, shared bases, and compaction are open. |
| Directory fsync capability | High for the published power-loss claim | Addressed fail closed | Block-device power-loss testing remains open. |
| Concurrent `seal()` and aggressive GC | Low availability risk | Addressed with an internal read lease | Callers must still quiesce or reconcile the pending tail when they require a fully settled export. |
| Applied-ledger growth | Medium over long store lifetimes | Open | Reconcile loads the complete ledger; no checkpoint protocol exists. |
| Long DirectStore lease sections | Medium liveness risk | Open | Fencing preserves safety, but stale-window retries can waste work. |
| Multi-host NFS and SMB behavior | High for that deployment | Open and explicitly unsupported as a proven alpha claim | Requires real two-host gates and recorded mount semantics. |
| Worker Thread contract | Low for ordinary separate-process agents | Open | Operations use fresh connections, but dedicated same-process thread tests remain. |

## Caller-Schema Identity

### Two Version Domains

fsqlite has two independent version domains:

1. `format_version: "f1.0"` identifies the directory layout and coordination protocol.
2. `(schema_version, schema_hash)` identifies the caller-owned SQLite schema used by one
   store epoch.

Changing one does not change the other.
A directory-format upgrade does not migrate caller tables.
A caller-schema migration does not inherently require a new fsqlite major format.

### The `f1.0` Schema Contract

An `f1.0` store has one immutable caller-schema identity:

- `schema_version` is an integer from 0 through 2,147,483,647 and is stored in SQLite
  `PRAGMA user_version`. SQLite stores the user version in the database header and
  leaves its meaning to the application.
  See the official
  [SQLite PRAGMA documentation](https://sqlite.org/pragma.html#pragma_user_version).
- `schema_hash` is the first 16 lowercase hexadecimal characters of SHA-256 over the
  exact UTF-8 bytes of the caller’s supplied schema string.
- Snapshots and envelopes repeat those tokens.
  Application write and reconcile paths verify them before mutation, capture, or
  publication.
- A different token is incompatible.
  Opening with `init()` or attempting an application mutation rejects it; a foreign
  envelope that reaches reconciliation is quarantined.
- No normal `f1.0` operation changes either token on an existing store.

These are conservative identity tokens, not a migration mechanism and not a canonical
SQL comparison.
Whitespace, comments, statement order, or equivalent DDL spelling changes
the hash even when SQLite would build an equivalent schema.
The hash also does not prove that arbitrary external code has never modified
`sqlite_schema`; callback boundary and candidate validation protect the supported API
path.

`schemaVersion: 2` against a version 1 store therefore means “incompatible handle,” not
“upgrade this store.”
The implementation now validates the numeric range before touching the store path, so
SQLite cannot coerce a fractional or out-of-range value and leave a partially
initialized store.

### Initialization and Operator Access

Application handles should call `init()` before normal reads and writes.
It creates a new store or proves that an existing store matches the configured exact
schema identity. Mutating application paths repeat compatibility checks so a skipped
`init()` cannot capture wrong-schema work or quarantine compatible work through a
wrong-schema reconciler.

Schema-agnostic operator operations remain distinct.
Recognition, validation, repair, garbage collection, and sealing can inspect the on-disk
identity without the caller’s DDL. That is necessary for independent tools and disaster
recovery.

### What a Future Migration Must Specify

The absence of automatic migration is a safe alpha boundary, but a useful migration
protocol needs more than executing DDL and incrementing `user_version`. It must define:

1. writer admission, quiescence, and fencing during the transition;
2. treatment of committed envelopes from the old schema;
3. a deterministic DDL and data transformation from a pinned, validated source;
4. validation of all caller constraints and fsqlite identity before cutover;
5. atomic cutover, interruption recovery, rollback, and source preservation;
6. admission behavior for old writers after cutover;
7. the transition of per-table conflict policy, which is deployment configuration rather
   than stamped format metadata;
8. conformance fixtures for every crash boundary and mixed-version participant.

A version bump without those steps must continue to fail.
This is a product limitation for applications with frequent rolling schema changes, but
it does not weaken the model for agent metadata stores whose schema changes through
explicit releases.

## Performance Model

### The Dominant Variables

Let:

- `B` be published snapshot bytes;
- `P` be committed pending-envelope count;
- `E` be total pending changeset bytes;
- `A` be lifetime rows in `applied_tx`;
- `W` be concurrent in-flight writers.

The useful cost approximations are:

```text
capture    = fixed session and schema work + copy(B) + callback work + write(envelope)
reconcile  = copy(B) + load(A) + sort(P) + hash/apply(E) + integrity checks + fsync(B)
```

Every SnapshotStore capture copies `B`. Batching reconciliation amortizes one build
copy, integrity gate, fsync, and pointer publication across many envelopes, but it does
not remove the per-capture copy.
Reconciling after every small write pays both full-copy paths and should be reserved for
workloads that need that visibility or durability boundary.

Concurrent capture is lock-free, but it is not free.
Peak transient storage can approach `W * B`, plus a reconcile build and retained
snapshots. Concurrent writers also compete for the same storage bandwidth.
A low-contention lock is not the limiting resource in that case; copy bandwidth and free
space are.

### Snapshot Bytes Versus Table Count

The earlier review measured write cost as linear in snapshot size.
It did not establish a separate linear law in table count.

Table count adds work because session setup and callback-boundary schema fingerprinting
visit schema objects.
Tables also consume SQLite pages, which increases `B`. In a local empty-schema
calibration, each case used five warmup captures followed by 30 measured captures that
inserted into the first table without reconciliation.
The ranges below span two back-to-back runs of the maintained
[workload-fit benchmark](../../packages/fsqlite/benchmarks/workload-fit.ts):

| Caller tables | Snapshot bytes | Median capture | 95th percentile |
| ---: | ---: | ---: | ---: |
| 1 | 28 KiB | 2.5 to 2.6 ms | 3.0 to 3.1 ms |
| 10 | 100 KiB | 3.1 to 6.4 ms | 3.5 to 10.8 ms |
| 50 | 428 KiB | 6.3 to 8.4 ms | 7.5 to 22.6 ms |
| 100 | 836 KiB | 6.7 to 8.1 ms | 9.5 to 9.5 ms |
| 250 | 2.0 MiB | 16.1 to 16.4 ms | 21.4 to 48.2 ms |

This remains a modest absolute cost at 250 tables, but the tail and intermediate cases
vary enough that the result should not be read as a clean table-count slope.
Some of the increase is the larger file.
In typical schemas, data and indexes dominate snapshot bytes before table count itself
becomes the main concern.
Constraint complexity and callback queries can still add work that this empty-schema
measurement does not represent.

### Snapshot-Size Measurements

The maintained [seed benchmark](../../packages/fsqlite/benchmarks/seed.ts) uses five
warmups and 30 captures at each size.
Two back-to-back runs measured median capture at 13.7 to 18.2 ms for a 2.0 MiB head and
163.8 to 164.6 ms for a 21.7 MiB head.
The 95th percentiles ranged from 18.7 to 32.1 ms and 227.7 to 314.0 ms, respectively.
A separate PR reviewer measured 11.8 ms at 2.0 MiB and 183.6 ms at 78.8 MiB under a
different local run.

The algorithm has a linear-in-bytes copy floor, but these measurements do not establish
a portable milliseconds-per-MiB coefficient or justify a GiB extrapolation.
The variation between runs is itself useful evidence.
Compression, indexes, cache state, callback work, filesystem behavior, free-space
pressure, and durability latency can move the result substantially.

### Independent Local Agents

The following process-level calibration used independent Node child processes.
The 2.0 MiB and 21.7 MiB heads contained 500 and 5,500 seeded 2 KiB rows, respectively.
Each agent captured five small two-row envelopes against the same head.
Capture wall time includes child-process startup and each agent’s five sequential
captures.

| Head | Agents | Total writes | Capture wall time | One reconcile |
| ---: | ---: | ---: | ---: | ---: |
| 2.0 MiB | 1 | 5 | 172 to 187 ms | 66 to 109 ms |
| 2.0 MiB | 4 | 20 | 389 to 409 ms | 159 to 186 ms |
| 2.0 MiB | 8 | 40 | 798 to 831 ms | 229 to 248 ms |
| 2.0 MiB | 16 | 80 | 1.63 to 1.65 s | 291 to 299 ms |
| 21.7 MiB | 1 | 5 | 769 to 846 ms | 321 to 355 ms |
| 21.7 MiB | 4 | 20 | 3.72 to 3.80 s | 312 to 366 ms |
| 21.7 MiB | 8 | 40 | 8.39 to 8.88 s | 389 to 397 ms |

The result is compatible with the intended agent workload only when “many agents” means
occasional metadata events against a compact head, not a synchronized write burst
against tens of MiB. It is not a high-throughput transaction system.
At 21.7 MiB, forty captures already move roughly 868 MiB of source snapshot data before
envelope and filesystem overhead.
The observed 8.4 to 8.9 second burst is tolerable only as background work and is poor
for an interactive request that expects every event to publish immediately.
Child-process startup is included, so this is conservative for already-running agents,
but startup does not account for the repeated full-head copies.

### Practical Operating Envelope

These ranges are inferred starting points, not conformance limits:

| Workload shape | Assessment |
| --- | --- |
| A few to a few dozen local agents, short callbacks, a single-digit-MiB head, occasional writes, and batched reconciliation | Natural fit; measure the actual schema and disk. |
| A handful of local agents, head in the low tens of MiB, and background-latency tolerance | Plausible, but the 21.7 MiB burst result makes workload-specific measurement mandatory. |
| A few dozen agents bursting concurrently against a low-tens-of-MiB head | Poor interactive fit; shard or reduce snapshot bytes even if eventual background completion is acceptable. |
| Head from 50 to 100 MiB, frequent writes, or strict reconcile-after-write behavior | Conditional to poor fit; copy cost, free space, visibility needs, and ledger growth require explicit capacity testing. |
| Hundreds of MiB to GiB heads with frequent small writes | Poor default fit. Shard, use DirectStore for a true single writer, use ordinary local SQLite, or use a service. |
| Immediate global visibility, serializable multi-row transactions, or high sustained write throughput | Outside the design target. |

DirectStore removes envelope and reconciliation costs but still copies and fsyncs the
full snapshot for every write while holding the publish lease.
Its stale window must exceed the measured worst-case copy, callback, validation, and
fsync duration. It is a semantic simplification, not a large-database performance escape
hatch.

## Other Significant Challenges

### Lifetime Ledger Growth

Reconciliation loads every `applied_tx` identifier into a JavaScript `Set`. The ledger
is also part of every later snapshot.
Time, memory, and snapshot bytes therefore grow with lifetime accepted-envelope count,
even after envelope directories move to `tx/applied/`. A safe checkpoint must still
reject reappearing old envelopes, so deleting old rows is not sufficient.
This is the most important scale issue not captured by one-write benchmarks.

### Visibility and Isolation

SnapshotStore visibility is asynchronous.
A successful `write()` accepts an envelope; only reconciliation makes it readable from
the published head and power-loss durable.
`writeWithRetry()` provides a point-row compare-and-retry pattern, but the merge does
not infer range, predicate, aggregate, or business invariants.
Workloads needing those properties should use guard rows, DirectStore, or a database
with transaction isolation that matches the invariant.

### Filesystem Evidence

Correctness is conditional on exclusive directory creation, atomic rename replacement,
close-to-open visibility, and working file and directory fsync barriers.
The reference implementation now fails when a required directory fsync is unavailable,
and `fsinspect` includes that barrier in its safe verdict.

A one-host probe cannot prove multi-host behavior.
NFS, SMB, managed shared filesystems, and mount options need real two-host contention
and failure tests. Consumer sync folders can reorder, duplicate, merge, or partially
synchronize directories and are not treated as conforming shared filesystems.

### Disk Capacity and Retention

A store may simultaneously contain the head, retained predecessors, leased snapshots,
writer copies, a reconcile build, transaction envelopes, and quarantine evidence.
Read leases intentionally delay collection.
Low free space should cause loud failures rather than corruption, but the package does
not yet expose enough capacity and backlog metrics for proactive operation.

### Liveness Under Long Operations

Fencing and optimistic concurrency preserve safety if a DirectStore or maintenance lease
is stale-broken. They do not prevent wasted work, retry storms, or timeout when an
operation legitimately exceeds the stale window.
Heartbeats or shorter critical sections remain tracked work.

## When to Reconsider fsqlite

Choose another architecture, or prototype against measured production-like data, when
any of these is central rather than exceptional:

- rolling caller-schema upgrades with old and new writers active together;
- a head consistently above 100 MiB with frequent small writes;
- a GiB-scale mutable database;
- immediate visibility after every write from many processes;
- serializable range, predicate, aggregate, or cross-row transactions;
- hostile or protocol-bypassing processes with file access;
- consumer synchronization folders;
- multi-host NFS or SMB before the target mount passes the real conformance gate.

For one local application writer, compare DirectStore with ordinary SQLite.
For many high-throughput writers or strong transactional invariants, a database service
is usually the clearer design.
For independent local agents recording compact events, indexes, leases, task state, or
content metadata, fsqlite remains a good match.

## Recommendation

Proceed with `0.1.0` as an alpha after the full release gate passes.
Keep the fixed-schema epoch and full-head seed in `f1.0`; both make the correctness
boundary reviewable.
Do not promise general shared-filesystem support or large-store throughput.

Prioritize post-alpha work in this order:

1. independent conformance fixtures and the real two-host filesystem gate;
2. deterministic caller-schema migration;
3. `applied_tx` checkpointing and capacity/backlog observability;
4. safe shared-base or overlay seeding for large stores;
5. long-lease liveness and Worker Thread validation.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
