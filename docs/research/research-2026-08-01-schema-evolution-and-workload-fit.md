# fsqlite Schema Evolution and Workload Fit

**Date:** 2026-08-01

**Status:** Current design assessment for the `0.1.0` alpha

## Executive Assessment

fsqlite still fits its intended use: cooperative local processes and agents that record
modest metadata transactions, can accept reconciliation-based visibility, and value
portable SQLite snapshots without a required service.

This is a narrower goal than “make SQLite concurrent.”
Ordinary SQLite should remain the first choice when processes on one computer can safely
share a live database and writers can take turns.
fsqlite is justified when immutable published generations and independent file-native
capture matter enough to pay for full-head copying, delayed visibility, and weaker
multi-writer isolation.

The review does not justify a format redesign or reduce the core value of the approach.
It does narrow the useful operating envelope:

- `f1.0` has one immutable caller-schema identity.
  It detects incompatible schemas but does not migrate them.
- Snapshot capture and publication have a full-copy floor in snapshot bytes.
  The separate effect of table count was not isolated, and changed-row count does not
  remove that floor.
- Capture without the publish lease removes fsqlite’s writer-serialization step, but
  concurrent agents still share disk bandwidth and create one working copy per in-flight
  write.
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

This assessment checked the current source and tests, the
[design constraints](../fsqlite-design.md), the
[format specification](../fsql-format-spec.md), and the [roadmap](../roadmap.md).
It compares the design with SQLite’s current official documentation for
[transactions](https://sqlite.org/lang_transaction.html),
[isolation](https://sqlite.org/isolation.html), [WAL](https://sqlite.org/wal.html),
[sessions](https://sqlite.org/sessionintro.html),
[schema changes](https://sqlite.org/lang_altertable.html),
[network filesystems](https://sqlite.org/useovernet.html), and
[appropriate uses](https://sqlite.org/whentouse.html).

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

## Baseline: Ordinary SQLite and fsqlite

### What Ordinary SQLite Already Provides

SQLite is an embedded database engine.
An application opens one database file and SQLite coordinates connections with a
rollback journal or WAL side files.
Separate connections see only committed transactions.
SQLite allows many readers but only one active writer, so writers queue and commit in a
serial order. WAL mode lets readers continue during that one active write, provided all
participants are on the same host.

This ordinary model is strong and efficient for local data.
A small transaction usually writes only changed pages and index entries.
Its commit is the atomic visibility and durability boundary, subject to the selected
SQLite durability settings and the storage stack honoring sync and lock operations.
Schema DDL runs through the same single-writer transaction mechanism.

SQLite does not make rolling application schemas automatic.
Applications still have to coordinate clients that understand different columns or
invariants. It does, however, provide the database-local transaction and documented
`ALTER TABLE` procedures needed to perform the change once the application has arranged
that coordination.

### What fsqlite Changes

fsqlite replaces one live mutable database with a directory of immutable SQLite
generations. Readers select the published generation through `current`. Writers never
change that file in place.

`DirectStore` copies the current generation, makes and validates an ordinary SQLite
transaction, then atomically publishes the copy.
It preserves serial writer semantics, but it copies and fsyncs the whole head for every
write.

`SnapshotStore` also starts from a complete copy, but captures the transaction as a
SQLite session changeset.
Several processes can capture envelopes at once.
A later reconcile applies them in deterministic order to another complete copy and
publishes that result.
Capture concurrency avoids waiting for a live database writer lock; it does not create
simultaneous commits to one SQLite file.

| Property | Ordinary SQLite | `DirectStore` | `SnapshotStore` |
| --- | --- | --- | --- |
| Commit boundary | SQLite transaction commit | Atomic publication before `write()` returns | Reconcile publication, not successful envelope capture |
| Reader view | Transaction snapshot; a new transaction sees later commits | Immutable published generation; a new read sees a later pointer | The same, but captured envelopes remain invisible until reconcile |
| Writer isolation | Serializable because writers take turns | Serializable for a DirectStore-only stream | Deterministic write-set merge, without general read-set validation |
| Integrity enforcement | SQLite transaction, journal/WAL, and declared constraints | SQLite transaction and constraints, then fsqlite identity, integrity, fsync, and pointer gates | The same publication gates plus changeset conflict policy and quarantine |
| Small-write I/O | Usually changed pages and indexes | Complete-head copy and publication | Complete-head capture plus complete-head reconcile build |
| Filesystem assumption | Reliable SQLite locks and sync; WAL participants on one host | Required fsqlite rename, exclusive directory creation, visibility, and sync primitives | The same fsqlite primitives; real cross-host proof is still pending |

fsqlite therefore neither inherits the exact ACID boundary of an ordinary SQLite call
nor replaces SQLite’s internal integrity machinery.
Each candidate snapshot still uses SQLite transactions and constraints.
fsqlite adds immutable predecessors, explicit identity, quarantine, and fail-closed
publication around them.
SnapshotStore also adds an accepted-but-unpublished state and nonserializable merge
semantics. A successful `SnapshotStore.write()` means “the envelope was captured,” not
“all readers can see a durable database commit.”

On a sound local filesystem, ordinary SQLite is simpler and has less protocol surface.
On a shared filesystem, fsqlite avoids reliance on SQLite’s live-file locks, but
replaces them with its own filesystem assumptions.
That is a different contract, not a general claim of stronger integrity.
The alpha has not yet proved those assumptions across two hosts.

## Finding Dispositions

| Area | Severity | Disposition | Remaining boundary |
| --- | --- | --- | --- |
| Merge closure over primary key, `NOT NULL`, `UNIQUE`, `CHECK`, and foreign keys | High if absent | Addressed | General range, predicate, aggregate, and cross-row invariants are not inferred. |
| Deterministic merge order and exactly-once ledgering | High if absent | Addressed | Conflict policy is deployment configuration and must be consistent across reconcilers. |
| Caller-schema compatibility | Medium for coordinated releases; high for rolling deployments | Addressed for detection and admission | `f1.0` rejects change. It has no migration protocol. |
| Invalid `schemaVersion` values and wrong-schema write handles | Medium | Addressed | Application code should still call `init()` before normal use. |
| Snapshot copy cost | Medium in the intended range; high for large or frequent writes | Disclosed and measured | Safe overlays, shared bases, and compaction are open. |
| Table-count overhead | Low to uncertain in the measured 1-to-250-table range | Disclosed but not independently isolated | Snapshot bytes changed with table count; target schemas need measurement. |
| Accepted-envelope durability before reconcile | Medium when each accepted write must survive power loss | Disclosed | Reconcile, use DirectStore or ordinary SQLite, or wait for durable-envelope mode. |
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

### Why Concurrent Capture Makes Migration Harder

SQLite session changesets contain row inserts, updates, and deletes.
For each affected table they record its name, column count, and primary-key positions.
They do not contain the DDL that created the table, a migration order, or instructions
for reconciling old and new constraints.
SQLite describes changesets as patches for another database with the same schema and
compatible starting data.

That creates questions that do not exist inside one ordinary SQLite write transaction.
If one agent captured an envelope before a column rename and another captured after it,
which schema interprets each value?
What happens to an old insert when the new schema adds a unique constraint?
Which conflict policy applies after a primary-key change?
A safe result requires one admission and cutover protocol around all writers, pending
envelopes, DDL, data transformation, constraints, and rollback.

The exact `f1.0` identity check deliberately rejects even additive or text-only schema
changes. SQLite’s session API can accept some structurally compatible targets, and some
ordinary `ALTER TABLE` operations are cheap, but silently depending on that subset would
make the fsqlite merge contract depend on defaults, participant versions, and accidental
DDL compatibility. The alpha chooses a clear false-negative boundary over an ambiguous
mixed-schema merge.

### Safe Operating Procedure Today

Applications with stable schemas need no special maintenance.
For a real schema change, the available mitigation is a planned, quiescent replacement:

1. Stop all writers and reconcilers that use the old store.
2. Reconcile acceptable pending envelopes and deliberately resolve or retain quarantine
   evidence. Do not carry an unexplained old-schema tail into the new epoch.
3. Run fsqlite validation and seal the final source snapshot for backup and rollback.
4. Create a separate destination store with the new schema.
   Copy or transform data from the pinned source, using SQLite’s directly supported
   `ALTER TABLE` operations or its documented create-copy-drop-rename procedure on a
   working copy where appropriate.
5. Check SQLite integrity, foreign keys, caller constraints, and application invariants,
   then validate the complete fsqlite destination.
6. Switch every process to the destination and prevent old binaries from continuing to
   write the old path. Keep the source until the rollback window closes.

This is an application-level replacement, not a feature implemented by fsqlite.
The new directory receives a new `store_id`, and the package does not make the
application cutover atomic.
Use ordinary SQLite directly during a coordinated maintenance window if that is simpler.
Do not modify a published fsqlite snapshot in place, run DDL in a write callback, or
increment `schemaVersion` expecting an upgrade.

Reducing concurrency during complex schema work is therefore not merely a performance
tip. It removes mixed-schema writers from the correctness problem.
Ordinary SQLite also permits only one schema-writing transaction at a time; the
additional fsqlite step is to drain and fence the asynchronous envelope stream before
that transaction or replacement.

### What a Future Migration Must Add

The absence of automatic migration is a safe alpha boundary, but it is a serious product
limitation for frequent rolling schema deployments.
Section 12 of the
[format specification](../fsql-format-spec.md#12-versioning-and-evolution) is the single
authoritative checklist for a future protocol.
It requires writer admission, treatment of old pending envelopes, deterministic DDL and
data transformation, conflict-policy transition, validation, crash recovery, rollback,
and cutover.

A version bump without those steps must continue to fail.
This limitation is medium severity for compact agent metadata whose schema changes in
coordinated releases and high severity for an always-on system that requires old and new
writers to overlap.

## Performance Model

### Why a One-Row Write Can Copy the Whole Database

Ordinary SQLite changes database pages in place under a rollback journal or appends
changed pages to a WAL. A tiny transaction against a large database does not normally
copy every unchanged page.

fsqlite needs each writer callback to observe the complete published rows and
constraints on which its decision is based.
`SnapshotStore` therefore copies the whole head into a private database before running
the callback and extracting a changeset.
Reconciliation copies the head again to build the next generation.
`DirectStore` skips the envelope but still copies the whole head before publication.

This is an algorithmic floor, not a tuning accident.
Faster storage can reduce elapsed time, and operating-system caching can hide some
reads, but bytes still move and private copies still consume capacity.
A future shared-base or overlay design must preserve the same observed data and
constraints before it can safely remove that floor.

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

Concurrent capture does not take the publish lease, but it is not free.
Peak transient storage can approach `W * B`, plus a reconcile build and retained
snapshots. Concurrent writers also compete for the same storage bandwidth.
A low-contention lock is not the limiting resource in that case; copy bandwidth and free
space are.

### Snapshot Bytes Versus Table Count

The implementation has a full-copy floor in snapshot bytes.
The calibration did not establish a separate linear law in table count.

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

This remains a modest absolute cost at 250 tables on the measured machine, but the tail
and intermediate cases vary enough that the result should not be read as a clean
table-count slope.
The experiment changed both table count and snapshot bytes, so it does
not isolate either variable.
Each table adds schema objects and SQLite pages, while data and indexes often dominate
file size in a populated database.
Constraint complexity and callback queries can also add work that this empty-schema
measurement does not represent.

The practical severity of table count alone is therefore low to uncertain in the
measured range, not proven linear.
The severity of snapshot bytes is higher because the algorithm must copy them for every
capture regardless of how many rows changed.

### Snapshot-Size Measurements

The maintained [seed benchmark](../../packages/fsqlite/benchmarks/seed.ts) uses five
warmups and 30 captures at each size.
Two back-to-back runs measured median capture at 13.7 to 18.2 ms for a 2.0 MiB head and
163.8 to 164.6 ms for a 21.7 MiB head.
The 95th percentiles ranged from 18.7 to 32.1 ms and 227.7 to 314.0 ms, respectively.

The algorithm has a linear-in-bytes copy floor, but these measurements do not establish
a portable milliseconds-per-MiB coefficient or justify a GiB extrapolation.
The variation between runs is itself useful evidence.
Compression, indexes, cache state, callback work, filesystem behavior, free-space
pressure, and durability latency can move the result substantially.

### Independent Local Agents

An agent is one independently running process.
The important workload is not the label “agent” or the process count by itself.
It is the number of captures multiplied by the published bytes, plus how tightly those
captures bunch together.

As an inferred planning example, 12 agents each recording one change against a 5 MiB
head cause about 60 MiB of source-copy traffic and can create about 60 MiB of writer
copies before reconcile, retention, and journal overhead.
One such round per minute is about 1 MiB/s of average source-copy traffic; one round per
second asks the same storage stack to sustain at least 60 MiB/s before any
reconciliation or callback work.
Burst latency and capacity still require measurement.
This example illustrates the model and is not a throughput promise.

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

The 2.0 MiB burst is a useful calibration for the intended lane: 8 agents performed 40
captures in about 0.8 seconds and one reconcile took about another quarter second on the
measured machine. That is reasonable for background coordination and plainly not a
guarantee that every agent receives an immediate globally visible commit.
At 21.7 MiB, the same 40-capture shape took more than eight seconds, which is high
severity for an interactive path even though it may remain acceptable for periodic
background work.

### Practical Operating Envelope

These ranges are inferred starting points, not conformance limits:

| Workload shape | Assessment |
| --- | --- |
| A few to a few dozen processes on one computer, short callbacks, a single-digit-MiB head, occasional writes, and one reconcile after a group of captures | Natural fit; measure the actual schema and disk. |
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

### Mitigations That Preserve the Design

The following changes reduce cost without weakening the documented contract:

- Put several related SQL statements in one `write()` callback when they are one logical
  transaction. This pays one writer seed copy instead of one copy per statement.
- Reconcile a group of envelopes when immediate visibility is unnecessary.
  This amortizes the reconcile build, validation, fsync, and pointer swap, though not
  the writers’ seed copies.
- Shard genuinely independent domains into separate stores so each head stays compact.
  Do not shard a transaction that requires atomic constraints across those stores.
- Keep large immutable payloads outside a frequently written metadata head, or in a
  separately managed store, when the application can validate their references.
- Use ordinary local SQLite, often with WAL, when all processes can use one reliable
  local database and writers can queue.
  This removes fsqlite’s full-copy publication cost and restores ordinary SQLite
  transaction semantics.
- Use a client/server database when many writers need low-latency commits, data access
  crosses a network, or serializable cross-row invariants dominate the workload.

Reducing concurrent writers does not remove SnapshotStore’s per-capture full copy, but
it can reduce burst contention and transient capacity.
Reducing concurrency is most important during schema maintenance, when the goal is also
to eliminate mixed-schema envelopes rather than merely improve speed.

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
A successful `write()` accepts an envelope.
Reconciliation may quarantine it or apply it; only a successfully applied and published
envelope becomes readable from the head and power-loss durable.
`writeWithRetry()` provides a point-row compare-and-retry pattern, but the merge does
not infer range, predicate, aggregate, or business invariants.
Workloads needing those properties should use guard rows, DirectStore, or a database
with transaction isolation that matches the invariant.

### Accepted Work Versus Durable Published Work

An ordinary SQLite commit can be made durable before it returns when its journal and
sync settings request that guarantee and the storage stack honors it.
A successful SnapshotStore capture closes and renames an envelope, so it survives an
ordinary process crash, but `f1.0` does not fsync that envelope tree as a durable
receipt. Power loss may therefore remove accepted work that has not reached a published
snapshot.

Applications that need immediate power-loss durability can reconcile immediately, at the
cost of another full-head build; use DirectStore for a true single writer; or use
ordinary SQLite. An optional durable-envelope receipt is roadmap work.
This boundary is not silent data corruption: the last published snapshot remains the
store commit point.

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

The approach genuinely fills the desired use case when that use case is stated
precisely: compact local state, cooperative independent processes, no required service,
ordinary SQLite artifacts, and acceptance of batched publication.
Its value is coordination and recoverable file publication, not faster SQL. The findings
reduce its addressable workload, but they do not remove that distinctive value.
Reconsider the architecture only if large mutable state, immediate commits, rolling
schemas, or serializable multi-row invariants are central requirements rather than
exceptions.

Prioritize post-alpha work in this order:

1. independent conformance fixtures and the real two-host filesystem gate;
2. deterministic caller-schema migration;
3. `applied_tx` checkpointing and capacity/backlog observability;
4. safe shared-base or overlay seeding for large stores;
5. long-lease liveness and Worker Thread validation.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
