# fsqlite Design and Constraints

Status: current explanatory design for the implementation in this repository.

The [format specification](fsql-format-spec.md) is the sole normative authority for the
`f1.0` directory format and coordination protocol.
This document explains the system constraints, how the design meets them, and where the
design deliberately stops.
The [QA runbook](qa-runbook.md) maps those claims to evidence.
The dated [research report](research/research-2026-06-06-portable-concurrent-sqlite.md)
records prior art, source analysis, and experiments, but does not define current
behavior.

## The Problem

SQLite is an excellent portable file format, but its live concurrency mechanisms assume
one local filesystem.
WAL mode uses a shared-memory file and does not support network filesystems.
Rollback journaling relies on filesystem locks whose behavior varies across NFS, SMB,
FUSE, and synchronized folders.

A service can centralize the writer, but that changes the deployment model.
fsqlite is for applications that need a plain SQLite artifact, direct in-process access,
no required server, and multiple independent writers that may share a filesystem.

## Goals and Non-Goals

fsqlite is a format plus a Node reference implementation.

Its goals are:

- keep each published state as an ordinary SQLite database;
- let readers use normal SQLite tools and bindings;
- coordinate independent writers without a required service or SQLite file locking;
- bound crash loss at an explicit publication boundary;
- detect and reject malformed, incompatible, or constraint-breaking input;
- make store identity and format evolution explicit;
- keep the Node package small, auditable, and free of runtime dependencies.

It does not attempt to provide:

- serializable multi-writer transactions or general predicate conflict detection;
- safety from processes that bypass the protocol and mutate store files;
- automatic schema or format migration during open;
- a claim that every filesystem implements the required primitives correctly;
- replication, remote transport, consensus, or a database service;
- arbitrary live-directory backup semantics.

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
| `C3` | Safety must not depend on WAL, advisory locks, or one host’s memory. | Writers never mutate a shared SQLite head. Required filesystem capabilities are atomic exclusive `mkdir`, atomic rename-replace, visibility after close, and durable fsync ordering. | Correctness is conditional on those capabilities. Cross-host NFS/SMB proof is still a pre-1.0 gate. | `fsinspect`; `nfs-sim.test.ts`; QA Part C |
| `C4` | Readers stay lock-free and independent writers can capture work concurrently. | Readers open immutable heads. `SnapshotStore` writers create unique transaction envelopes without the publish lease. | Cross-writer visibility occurs only after reconcile. | Spec W1-W4 and reader role; `concurrent.test.ts` |
| `C5` | A crash cannot destroy a previously published state. | Immutable snapshots, durable snapshot-before-pointer ordering, atomic pointer replacement, fencing, OCC on `current`, and the in-snapshot ledger define one commit point. | Accepted envelopes are not power-loss durable until publication. Arbitrary recursive copies of a live store are outside the guarantee. | Spec R1, P1-P3, F5, and section 10; crash, kill, and fencing suites |
| `C6` | Detectable inconsistencies fail closed and repair never guesses. | Recognition separates absent, invalid, unsupported, and corrupt stores. Identity, digests, integrity, foreign keys, reserved tables, and schema compatibility are checked before destructive work or publication. | Undetectable hardware or protocol-bypassing corruption remains possible. Repair needs a verified clean recovery point. | Spec R2 and section 11; hardening, store-format, and repair suites |
| `C7` | Merge results are deterministic, exactly once, and closed over declared SQLite constraints. | Envelopes apply in byte-sorted order; action passes are fixed as `replace`, `omit`, `strict`; data and ledger entry share one transaction; nonreplaceable conflicts quarantine the complete envelope; foreign keys are checked at envelope boundaries. | Same-primary-key DATA/CONFLICT cases still require an application policy. General business invariants need stronger patterns. | Spec F1-F6 and merge policy; `merge-constraints.test.ts` |
| `C8` | A store and its evolution are self-identifying. | Root `fsqlite.json`, UUID `store_id`, format string `f1.0`, required features, snapshot metadata, and SQLite application ID cross-check one another. | Unknown required features and unsupported versions block mutation. Upgrades are explicit and side by side. | Spec M1-M5 and section 12; `store-format.test.ts` |
| `C9` | The writable surface has an explicit cooperative trust boundary. | Writers use fsqlite APIs, callbacks cannot mutate fsqlite-owned rows, persistent or temporary SQLite schema state, or format identity state, and candidate snapshots are revalidated before publish. Runtime capabilities are probed rather than assumed. | A process with direct filesystem access can still violate the protocol. Callback functions that may be retried must not perform unrecoverable external side effects. | Spec S2-S4 and roles; direct, store-format, and capability suites |
| `C10` | Consistency claims must be precise. | Reads are snapshot-isolated by published version. Merge is optimistic write-set reconciliation with per-table same-row policy. `DirectStore` serializes its write transaction. | `SnapshotStore` is not serializable and does not validate general read sets, ranges, predicates, or aggregates. | `retry.test.ts`; research Finding K |
| `C11` | The format must be operable and recoverable without application schema code. | The CLI recognizes, validates, repairs, seals, collects, and diagnoses stores. Read leases pin snapshots during long reads or exports. | Staleness uses clocks and mtime, so tuning affects liveness. | Spec RL1-RL2, G1-G3, and section 11; CLI goldens and GC/lease suites |
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
Change application schemas through a future explicit schema-migration protocol, not a
write callback. Virtual tables are not part of the `f1.0` writable schema contract
because SQLite sessions do not capture them and their shadow tables do not satisfy the
caller-table primary-key rule.
Treat search indexes and similar structures as rebuildable projections outside the
concurrent envelope path.

## Two Write Strategies

Both strategies produce the same `f1.0` snapshots and pointer.

### SnapshotStore

Use `SnapshotStore` for independent writers or a shared filesystem.

- Writer capture is lock-free.
- Readers never block.
- Writers need SQLite session support.
- Writes become visible and power-loss durable when reconciled.
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

### Snapshot size

SnapshotStore writer capture is O(snapshot size) because it copies the current head.
A reviewer-local benchmark with 2 KB rows measured 11.8 ms per write at 2.0 MiB and
183.6 ms at 78.8 MiB, about 2.3 ms per MiB. A linear 1 GiB extrapolation is roughly 2.4
seconds for one single-row write.
These are hardware-specific sizing observations, not a performance guarantee.

Measure the target workload before adopting SnapshotStore for a large database.
Safe copy-on-write, overlay, shared-base, and compaction designs remain on the roadmap.

### Filesystems

The protocol requires correct exclusive directory creation, atomic rename-replace,
close-to-open visibility, and fsync behavior.
`fsinspect` probes these properties from one host, and local multiprocess tests simulate
network-shaped visibility.
Neither is a substitute for the pending two-host NFS/SMB gate.
The alpha is a protocol design and reference implementation, not universal certification
of shared filesystems.

### Backup and copying

Published snapshots are immutable.
A reader can pin one with `readLease()` and copy that file safely.
`seal()` and the backup helpers create integrity-checked standalone SQLite artifacts.

An arbitrary recursive copy of a live store is not a supported backup API. Such a copy
may include recoverable transients, but fsqlite does not promise that arbitrary
software, copy order, GC races, or an interrupted directory copy will retain a complete
clean snapshot. Use the provided snapshot, lease, seal, or backup surfaces.

### Threading and processes

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

The version grammar is `f<major>.<minor>`. Major versions are incompatible.
Minor versions are additive only when an implementation explicitly declares
compatibility.
Unknown mandatory features and unsupported versions block mutation without
being misclassified as corruption.

Opening a store never migrates it.
Whole-format upgrades are explicit and side by side: pin and validate the source, build
and validate a destination, preserve `store_id`, keep the source untouched, then let the
operator cut over. Caller-schema migration is a separate protocol.

## Trust Boundary

fsqlite protects callers from ordinary callback mistakes and all protocol failures it
can detect. It does not sandbox a process that owns the files.

Conforming participants must:

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

The CLI is part of the reference implementation, not an afterthought.
It provides `info`, `validate`, `gc`, `seal`, `repair`, `stats`, `doctor`, and
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
