# fsqlite Design and Constraints

Status: current explanatory design for the implementation in this repository.

The [format specification](fsql-format-spec.md) is the sole normative authority for the
`f1.0` directory format and coordination protocol.
`f1.0` coordinates independent processes through immutable snapshots and transaction
envelopes. The constraints in this design define its operating boundary.
The [QA runbook](qa-runbook.md) maps those claims to evidence.
The dated [research report](research/research-2026-06-06-portable-concurrent-sqlite.md)
records prior art, source analysis, and experiments, but does not define current
behavior. The focused
[schema evolution and workload assessment](research/research-2026-08-01-schema-evolution-and-workload-fit.md)
calibrates the alpha against the current implementation and measurements.

## The Problem

SQLite provides a portable database file format, but its live concurrency mechanisms
assume one local filesystem.
WAL mode allows readers alongside one active writer, but it uses shared memory and
requires every participant to be on the same host.
Rollback journaling relies on filesystem locks whose behavior varies across NFS, SMB,
FUSE, and synchronized folders.

A service can centralize the writer, but that changes the deployment model.
fsqlite is for applications that need a plain SQLite artifact, direct in-process access,
no required server, and multiple independent writers that may share a filesystem.

## Start With Ordinary SQLite

Ordinary SQLite is the default choice when processes can safely open one live database
on a reliable local filesystem.
It already provides serializable transactions by making writers take turns.
WAL mode lets readers continue during the one active write.
A small transaction normally updates only the affected database, journal, WAL, and index
pages.

fsqlite does not make one SQLite file accept several simultaneous writers.
It moves the work to private copies.
A `SnapshotStore` writer copies the published database, makes a normal SQLite
transaction on that copy, and saves the resulting row changes in an envelope.
Reconciliation later applies accepted envelopes to another private copy and atomically
names that copy as the next published version.

This different boundary is valuable when independent processes should not write one live
database file, when immutable generations are useful recovery artifacts, or when a
database service is unacceptable.
It is the wrong trade when ordinary local SQLite already meets the need.

| Property | Ordinary SQLite | `DirectStore` | `SnapshotStore` |
| --- | --- | --- | --- |
| Stored state | One mutable database plus journal or WAL files | Immutable SQLite generations plus an atomic pointer | The same generations and pointer, plus transaction envelopes |
| Small-write cost | Usually proportional to changed pages and indexes | Copies, validates, and fsyncs the complete head | Copies the complete head for capture; reconcile copies and validates it again |
| Writers | SQLite serializes them | fsqlite serializes the complete write and publication | Captures may overlap; reconciliation serializes publication |
| Successful call | SQLite commit is the visibility and durability boundary, subject to its durability settings | `write()` has published the new snapshot | `write()` has accepted an envelope; reconcile either quarantines it or applies and publishes it durably |
| Multi-writer isolation | Serializable because writes take turns | Serializable for a DirectStore-only writer stream | Deterministic write-set merge; not serializable and no general read-set validation |
| Schema changes | Run as ordinary SQLite DDL under application coordination | Fixed schema per `f1.0` store epoch | The same fixed epoch; envelopes contain row changes, not DDL |
| Best fit | Local data with writers that can queue | One application writer that needs immutable publication | Cooperative independent writers with compact state and delayed visibility |

Every fsqlite snapshot remains an ordinary SQLite database and each build uses SQLite
transactions and constraints.
The store-level guarantee is nevertheless different.
fsqlite adds immutable predecessors, fail-closed validation, and an atomic publication
pointer, but it also adds a directory protocol and a later reconciliation boundary.
It is not categorically safer or less safe than SQLite; it protects a different failure
surface. On reliable local storage, ordinary SQLite has less protocol surface.
On a shared filesystem, fsqlite avoids SQLite’s live-file lock protocol but is safe only
when its own required filesystem primitives are correct and validated.

SQLite’s official [isolation](https://sqlite.org/isolation.html),
[WAL](https://sqlite.org/wal.html),
[network filesystem](https://sqlite.org/useovernet.html), and
[appropriate-use](https://sqlite.org/whentouse.html) documentation defines the ordinary
SQLite baseline behind this comparison.

## Goals and Non-Goals

fsqlite is a format plus a Node reference implementation.

Its goals are:

- keep each published state as an ordinary SQLite database
- let readers use normal SQLite tools and bindings
- coordinate independent writers without a required service or SQLite file locking
- bound crash loss at an explicit publication boundary
- detect and reject malformed, incompatible, or constraint-breaking input
- make store identity and format evolution explicit
- keep the Node package small, auditable, and free of runtime dependencies

It does not attempt to provide:

- serializable multi-writer transactions or general predicate conflict detection
- safety from processes that bypass the protocol and mutate store files
- automatic schema or format migration during open
- a claim that every filesystem implements the required primitives correctly
- replication, remote transport, consensus, or a database service
- arbitrary live-directory backup semantics

## Design Constraints

These IDs are the stable system-level registry.
The specification’s `M`, `S`, `P`, `W`, `F`, `L`, `RL`, and `G` rules are the precise
normative requirements beneath them.
Other documents should link to these constraints instead of creating competing versions
of the promise.

| ID | Constraint | How fsqlite meets it | Cost or boundary | Evidence |
| --- | --- | --- | --- | --- |
| `C1` | Published data stays portable and tool-readable. | Every head is a complete SQLite file. Readers need no fsqlite extension. | The live store is a directory, not one mutable database file. | Spec S1-S6; `portability.test.ts`; QA B4 |
| `C2` | Ordinary operation needs no server or background service. | Processes coordinate through immutable files, envelopes, atomic rename, and a `mkdir` lease. | Applications schedule reconciliation themselves. | Spec F1-F6 and L1-L5; multiprocess suites |
| `C3` | Safety must not depend on WAL, advisory locks, or one host’s memory. | Writers never mutate a shared SQLite head. Required filesystem capabilities are atomic exclusive `mkdir`, atomic rename-replace, visibility after close, and durable fsync ordering. Publication fails if a required directory fsync is unavailable. | Correctness is conditional on those capabilities. Cross-host NFS/SMB proof is still a pre-1.0 gate. | `fsinspect`; `nfs-sim.test.ts`; QA Part C |
| `C4` | Readers do not take the publish lease, and independent writers can capture work concurrently. | Readers open immutable heads. `SnapshotStore` writers create unique transaction envelopes without the publish lease. | Cross-writer visibility occurs only after reconcile. | Spec W1-W4 and reader role; `concurrent.test.ts` |
| `C5` | A crash cannot destroy a previously published state. | Immutable snapshots, durable snapshot-before-pointer ordering, atomic pointer replacement, fencing, OCC on `current`, and the in-snapshot ledger define one commit point. | Accepted envelopes are not power-loss durable until publication. Arbitrary recursive copies of a live store are outside the guarantee. | Spec R1, P1-P3, F5, and section 10; crash, kill, and fencing suites |
| `C6` | Detectable inconsistencies fail closed and repair never guesses. | Recognition separates absent, invalid, unsupported, and corrupt stores. Identity, digests, integrity, foreign keys, reserved tables, and schema compatibility are checked before destructive work or publication. | Undetectable hardware or protocol-bypassing corruption remains possible. Repair needs a verified clean recovery point. | Spec R2 and section 11; hardening, store-format, and repair suites |
| `C7` | Merge results are deterministic, exactly once, and closed over declared SQLite constraints. | Envelopes apply in byte-sorted order; action passes are fixed as `replace`, `omit`, `strict`; data and ledger entry share one transaction; nonreplaceable conflicts quarantine the complete envelope; foreign keys are checked at envelope boundaries. | Same-primary-key DATA/CONFLICT cases still require an application policy. General business invariants need stronger patterns. | Spec F1-F6 and merge policy; `merge-constraints.test.ts` |
| `C8` | A store and its evolution are self-identifying. | Root `fsqlite.json`, UUID `store_id`, format string `f1.0`, required features, snapshot metadata, SQLite application ID, and caller-schema identity cross-check one another. | Unknown features, unsupported versions, and a different caller-schema token block mutation. Format and schema migrations are separate explicit operations. | Spec M1-M5 and section 12; `store-format.test.ts`; `init.test.ts` |
| `C9` | The writable surface has an explicit cooperative trust boundary. | Writers use fsqlite APIs, callbacks cannot mutate fsqlite-owned rows, persistent or temporary SQLite schema state, or format identity state, and candidate snapshots are revalidated before publish. Runtime capabilities are probed rather than assumed. | A process with direct filesystem access can still violate the protocol. Callback functions that may be retried must not perform unrecoverable external side effects. | Spec S2-S4 and roles; direct, store-format, and capability suites |
| `C10` | Consistency claims must be precise. | Reads are snapshot-isolated by published version. Merge is optimistic write-set reconciliation with per-table same-row policy. `DirectStore` serializes its write transaction. | `SnapshotStore` is not serializable and does not validate general read sets, ranges, predicates, or aggregates. | `retry.test.ts`; research Finding K |
| `C11` | The format must be operable and recoverable without application schema code. | The CLI recognizes, validates, repairs, seals, collects, and diagnoses stores. Read leases pin snapshots during long reads or exports; `seal()` acquires one internally. | Staleness uses clocks and mtime, so tuning affects liveness. | Spec RL1-RL2, G1-G3, and section 11; CLI goldens and GC/lease suites |
| `C12` | The reference package must remain easy to audit and adopt. | It uses `node:sqlite`, has zero runtime dependencies and no install scripts, retains `node:test`, and publishes a schema-agnostic CLI. | Snapshot writers require the SQLite session extension and the documented Node range. | Package smoke, minimum-Node CI, lint, typecheck, and supply-chain gate |

## Architecture

An fsqlite store has four durable layers:

1. `fsqlite.json` identifies the format and logical store.
2. `snapshots/` holds immutable, versioned SQLite databases.
3. `current` atomically names the published snapshot.
4. `tx/` holds pending, applied, or quarantined transaction envelopes.

`SnapshotStore.write()` copies the current snapshot into a private working database,
runs the caller transaction, records a SQLite session changeset, and publishes a unique
envelope by writing `COMMITTED` last.
No shared SQLite file is open for writing.

`SnapshotStore.reconcile()` builds from the current snapshot, folds committed envelopes
in deterministic order, runs integrity and identity gates, then briefly takes the
publish lease.
It publishes only if `current` still names the base and the lease token is
still owned. A racing reconciler rebuilds from the winner’s head.

Exactly-once behavior does not depend on a perfect lease.
Each applied transaction ID is written into `applied_tx` in the same SQLite transaction
as its data. A build cannot publish unless its base is still current.
After a crash, a later reconciler either sees the ledgered transaction in the published
lineage or applies it to a new build, never both.

## Consistency and Constraint Closure

The merge policy applies only to replaceable same-primary-key SQLite changeset
conflicts:

| Policy | Result for replaceable DATA or CONFLICT cases |
| --- | --- |
| `lww` / `replace` | Incoming row wins. |
| `union` / `omit` | Existing row wins and the conflicting incoming change is omitted. |
| `strict` | The complete envelope is quarantined. |

`strict` is the default for unlisted tables.
`NOTFOUND`, `CONSTRAINT`, and `FOREIGN_KEY` are never replaceable; any of them
quarantines the complete envelope under every policy.
The format specification defines the exact apply order and transaction boundaries.

SQLite constraints can connect rows that do not share a primary key.
Therefore fsqlite does not claim that different rows or tables can never conflict.
It claims that the same-primary-key policy is row-granular, while declared constraints
can reject an entire envelope across keys or tables.

| Declared rule | fsqlite behavior |
| --- | --- |
| Primary key | Required and non-null for every caller table. Same-key replaceable conflicts use the table policy. |
| `NOT NULL`, `UNIQUE`, and `CHECK` | SQLite enforces them during apply. A `CONSTRAINT` outcome quarantines the complete envelope. |
| Foreign key | Enforcement is deferred across the fixed filtered passes, then `foreign_key_check` runs before the ledger entry and again before publication. A persistent violation quarantines the envelope. |
| Cross-row application invariant | Not inferred. Use a version-stamped guard row, a `strict` point-row compare-and-retry pattern, or `DirectStore`. Range, predicate, and aggregate invariants are not protected by ordinary merge policy. |

DDL is not a transaction-envelope operation.
Callbacks that change the SQLite schema, `application_id`, `user_version`, or
fsqlite-owned tables fail.
The caller schema is one immutable compatibility epoch in `f1.0`. Changing
`schemaVersion` makes a handle incompatible; it does not migrate the store.
Application write and reconcile paths verify the configured exact schema identity before
they capture, move, or publish work, even if a caller skipped `init()`. Change
application schemas through a future explicit schema-migration protocol, not a version
bump or write callback.

### Schema Changes in Practice

Ordinary SQLite supports several direct `ALTER TABLE` operations and documents a
transactional create-copy-drop-rename procedure for more general changes.
Those database-local steps remain useful, but they are not enough for SnapshotStore.
SQLite session changesets describe row inserts, updates, and deletes against a
compatible schema; they do not carry DDL or decide how old and new writers should
overlap.

The safe `f1.0` operating rule is therefore one exact schema for one store epoch.
For a schema change today:

1. Stop every writer and reconciler for the old store.
2. Reconcile acceptable pending envelopes and deliberately resolve any quarantine.
3. Validate and seal the final source snapshot.
4. Build a separate replacement store with the new schema and copy or transform the
   source data using ordinary SQLite migration practices.
5. Validate the replacement, switch all processes to it, and retain the source for the
   rollback window.

That is an application-managed replacement with a new `store_id`, not a built-in fsqlite
migration. The application owns cutover and must prevent old writers from continuing
against the old path.
Even an additive DDL change starts a new epoch because `f1.0` requires exact schema
identity. Frequent rolling migrations with old and new writers active together are
therefore outside the alpha’s useful envelope.

The format specification’s
[versioning and evolution section](fsql-format-spec.md#12-versioning-and-evolution) owns
the requirements for a future migration protocol.
SQLite’s [ALTER TABLE guidance](https://sqlite.org/lang_altertable.html) owns the
underlying single-database DDL procedure.

Conflict policy is deployment configuration rather than stamped store metadata.
Every reconciler for one schema epoch must therefore use the same policy.
A future schema migration must define how policy changes with tables and constraints.

Virtual tables are not part of the `f1.0` writable schema contract because SQLite
sessions do not capture them and their shadow tables do not satisfy the caller-table
primary-key rule. Treat search indexes and similar structures as rebuildable projections
outside the concurrent envelope path.

## Two Write Strategies

Both strategies produce the same `f1.0` snapshots and pointer.

### SnapshotStore

Use `SnapshotStore` for independent writers sharing a store directory only after the
filesystem meets the required capability checks.
The alpha is validated for local POSIX multi-process use; real cross-host NFS/SMB
validation remains pending.

- Writer capture does not take the publish lease.
- Readers do not wait for the publish lease.
- Writers need SQLite session support.
- Reconcile either quarantines an envelope or applies it; applied envelopes become
  visible and power-loss durable when the new snapshot is published.
- Merge policy and nonserializable semantics are explicit.
- Each write copies the published snapshot before recording its changeset.

The full-snapshot seed is deliberate for `f1.0`: it ensures the callback observes the
rows and constraints its changeset is based on.
A safe large-store alternative needs a specified overlay or equivalent read base; an
empty database cannot preserve updates, deletes, or the unseen columns of an existing
row.

### DirectStore

Use `DirectStore` only for a local store with one application writer.

- It needs no session extension.
- It copies, mutates, validates, and publishes synchronously under the publish lease.
- A DirectStore-only writer stream is serializable because those writes are globally
  serialized. Mixing in SnapshotStore envelopes inherits the merge model.
- A successful return is immediately visible and power-loss durable.
- It remains interoperable with SnapshotStore because both use OCC on `current` and the
  same publication protocol.

DirectStore deliberately trades concurrency for simpler semantics.
It must never be selected automatically from filesystem detection because a dangerous
shared path can look local.

The lease covers the copy, callback, checks, fsync, and publication.
With the Node defaults, `staleMs` is 20 seconds and `timeoutMs` is 30 seconds.
A deployment must set a stale window longer than its worst-case DirectStore operation or
accept a fenced retry.
The callback can run more than once after an OCC or fencing loss, so it must keep
external side effects outside the retryable function or make them idempotent.
Periodic heartbeat support for long synchronous critical sections remains tracked work.

## Operating Envelope

### Snapshot Size

Ordinary SQLite usually writes changed pages for a small transaction.
Both fsqlite write strategies instead copy the complete published head before changing
it, so even a one-row fsqlite write has an O(snapshot size) I/O floor.
SnapshotStore then pays another head-sized build during reconciliation.
This is the main performance price of immutable publication in `f1.0`.

Two runs of the maintained 2 KB-row benchmark measured median capture at 13.7 to 18.2 ms
for a 2.0 MiB head and 163.8 to 164.6 ms for a 21.7 MiB head.
The algorithm has a linear copy floor, but the measurements do not establish a portable
rate or justify a GiB extrapolation.

Session setup and callback-boundary checks visit schema objects, and every table
consumes some SQLite pages, but data and indexes usually dominate snapshot bytes.
Two local calibration runs from 1 to 250 empty caller tables increased median capture
from about 2.5 ms to about 16.3 ms while the snapshot itself grew from 28 KiB to 2.0
MiB. Because the calibration changed table count and file bytes together, it does not
isolate table count as the primary variable or establish an independent linear
table-count law. Table count adds real schema work, but the severity must be measured
with the target schema rather than inferred from a table total.

Measure the target workload before adopting SnapshotStore for a large database.
Safe copy-on-write, overlay, shared-base, and compaction designs remain on the roadmap.
The
[workload assessment](research/research-2026-08-01-schema-evolution-and-workload-fit.md)
records the measurement method and limits.

### Capacity and Cadence

Snapshot bytes determine the full-copy and integrity-check floor.
Pending envelope count and bytes determine sorting, hashing, apply, and archive work.
The lifetime `applied_tx` count adds another growing term because reconcile loads the
complete ledger into memory and every later snapshot carries it.

Capture without the publish lease permits concurrent agents, but `W` in-flight writers
can require about `W` working copies of the head.
A reconcile build, retained predecessors, active read leases, envelopes, and quarantine
evidence add to peak disk use.

For example, one capture each from 12 agents against a 5 MiB head implies about 60 MiB
of source-copy traffic and can transiently create about 60 MiB of writer copies before
reconciliation and retention overhead.
Repeating that round once a minute produces about 1 MiB/s of average source-copy
traffic. Repeating it once a second requires at least 60 MiB/s before reconciliation or
callback overhead. Agent count is useful only together with head bytes, write frequency,
and burst shape.

Batching several envelopes into one reconcile amortizes the build copy, integrity gate,
fsync, and pointer publication.
It does not amortize each writer’s seed copy.
Reconcile after every small write only when the immediate visibility or durability
boundary is worth both full-copy paths.

### Workload Fit

Here, a local agent means an independently running process on one computer, not a thread
inside one shared SQLite connection and not an unvalidated remote host.
The natural alpha workload is a few to a few dozen such cooperative agents, short data
callbacks, a single-digit-MiB head, occasional writes, and batched reconciliation.
A handful of agents against a head in the low tens of MiB can fit when background
latency is acceptable, but it requires workload-specific measurement.
In the maintained calibration, eight processes issuing 40 total writes against 21.7 MiB
took 8.4 to 8.9 seconds including process startup.
At 50 to 100 MiB, frequent capture or reconcile-after-write is a conditional to poor fit
and needs capacity monitoring.
Hundreds of MiB to GiB heads with frequent small writes, immediate global visibility, or
high sustained transaction rates are poor default fits.

Within this envelope, fsqlite is a coordination format for compact local state, not a
replacement for a general database service.
SnapshotStore removes the need to wait for a live SQLite writer lock during capture; it
does not remove storage-bandwidth, capacity, or serialized-publication limits.

### Filesystems

The protocol requires correct exclusive directory creation, atomic rename-replace,
close-to-open visibility, and fsync behavior.
`fsinspect` probes these properties from one host, and local multiprocess tests simulate
network-shaped visibility.
Directory fsync is part of the safe verdict and publication fails closed when it is
unavailable. Neither is a substitute for the pending two-host NFS/SMB gate.
The alpha is a protocol design and reference implementation, not universal certification
of shared filesystems.
Consumer synchronization folders are not conforming shared filesystems.

### Backup and Copying

Published snapshots are immutable.
A reader can pin one with `readLease()` and copy that file safely.
`seal()` pins its selected source snapshot with an internal read lease and creates an
integrity-checked standalone SQLite artifact.

An arbitrary recursive copy of a live store is not a supported backup API. Such a copy
may include recoverable transients, but fsqlite does not promise that arbitrary
software, copy order, GC races, or an interrupted directory copy will retain a complete
clean snapshot. Use the provided snapshot, lease, seal, or backup surfaces.

### Threading and Processes

Operations open fresh connections and never share a connection across Worker Threads.
The filesystem protocol coordinates processes at a store root.
A formal Worker Thread coordination contract and dedicated tests remain roadmap work.

## Identity and Evolution

Only a valid root `fsqlite.json` identifies a store.
Generic names such as `current` and `snapshots/` do not.
The marker records:

- `format: "fsqlite"`;
- `format_version: "f1.0"`;
- a UUID `store_id`;
- mandatory capabilities in `required_features`.

Snapshots and envelopes repeat format and store identity.
Snapshot files also carry the fixed SQLite `application_id` `0x4653514C` (`FSQL`). The
caller owns `PRAGMA user_version` and the stamped schema hash.

Those caller fields form one immutable schema identity for an `f1.0` store:

- `schemaVersion` is an integer from 0 through 2,147,483,647 and is stored as
  `user_version`;
- `schemaHash` is the first 16 lowercase hexadecimal characters of SHA-256 over the
  exact UTF-8 schema string supplied at initialization;
- exact equality of both tokens is required for application mutation and reconciliation.

The hash is deliberately sensitive to whitespace, comments, order, and other textually
different but possibly equivalent DDL. It is an identity token, not canonical SQL and
not a standalone tamper detector.

The version grammar is `f<major>.<minor>`. Major versions are incompatible.
Minor versions are additive only when an implementation explicitly declares
compatibility.
Unknown mandatory features and unsupported versions block mutation without
being misclassified as corruption.

Opening a store never migrates it.
Whole-format upgrades are explicit and side by side: pin and validate the source, build
and validate a destination, preserve `store_id`, keep the source untouched, then let the
operator cut over.
Caller-schema migration is a separate protocol that must define writer
admission, old pending-envelope handling, deterministic transformation, validation,
recovery, rollback, and cutover.
Section 12 of the format specification is the authoritative requirement list.
Until that protocol exists, use the application-managed replacement workflow above.

## Trust Boundary

fsqlite protects callers from ordinary callback mistakes and all protocol failures it
can detect. It does not sandbox a process that owns the files.

Conforming participants must:

- call `init()` on application handles before ordinary reads and writes so creation and
  schema compatibility are explicit;
- treat published snapshots, the marker, pointer, envelopes, leases, and reserved tables
  as fsqlite-owned;
- open published snapshots read-only;
- use fsqlite write or maintenance APIs for mutation;
- avoid external side effects inside callbacks that may retry;
- validate target filesystem behavior and stay within the documented runtime and
  platform envelope.

The reference implementation protects `applied_tx` and `fsqlite_meta` during callbacks,
rejects persistent or temporary callback DDL and identity changes, and reasserts
candidate identity before publication.
These checks prevent accidental protocol damage.
They are not a security boundary against hostile code in the same process or an external
writer with file access.

## Public Surface and Modules

```ts
import { DirectStore, SnapshotStore } from 'fsqlite'

const store = new SnapshotStore(dir, {
  schema: SCHEMA_SQL,
  schemaVersion: 1,
  conflictPolicy: {
    url_index: 'lww',
    relationships: 'union',
    '*': 'strict',
  },
}).init()

store.write('writer-a', (db) => {
  // INSERT, UPDATE, or DELETE within the fixed caller schema.
})
store.reconcile()
store.read((db) => db.prepare('SELECT ...').all())
store.writeWithRetry('writer-a', (db) => {
  // Retry-safe read-modify-write on strict point rows.
})
store.validate()
store.repair()
store.seal('out.sqlite')

new DirectStore(dir, options).write((db) => {
  // Local single-writer transaction. The callback may be retried.
})
```

| Module | Responsibility |
| --- | --- |
| `src/storeFormat` | Marker recognition, format version, store identity, and required-feature gating |
| `src/snapshotStore` | Concurrent capture, reconcile, reads, leases, GC, validation, repair, and sealing |
| `src/directStore` | Local serialized writer over the same immutable format |
| `src/conflictPolicy` | Deterministic policy routing and conflict classification |
| `src/driver` | `node:sqlite` capability, changeset, integrity, backup, and callback-boundary chokepoint |
| `src/lock` | Fenced `mkdir` lease used for publication and maintenance |
| `src/cli` | Schema-agnostic operator commands and diagnostics |

The CLI provides `info`, `validate`, `gc`, `seal`, `repair`, `stats`, `doctor`, and
`fsinspect` without requiring application schema code.

## Validation and Remaining Work

The [QA runbook](qa-runbook.md) is the evidence index for `C1` through `C12`. The
[roadmap](roadmap.md) records the unresolved work without weakening the alpha contract.
The most important remaining constraints are real cross-host filesystem validation,
Windows publication races, long-operation lease heartbeat strategy, independent format
conformance fixtures, explicit upgrades, Worker Thread coordination, stronger isolation
patterns, and large-store seeding efficiency.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
