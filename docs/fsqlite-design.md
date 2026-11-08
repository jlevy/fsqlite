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

SQLite provides a portable database file format and an efficient live concurrency model
for reliable local filesystems.
On Unix, the default VFS coordinates a live database with POSIX advisory byte-range
locks, normally through `fcntl()`. WAL mode allows readers alongside one active writer
and adds a `-shm` shared-memory wal-index.
These mechanisms work well when every client sees coherent locks and shared memory.

Network-backed and virtualized paths may not provide that contract across clients.
`busy_timeout` and retry can wait for a working SQLite lock, but they cannot create lock
coherence that the filesystem lacks.
NFS, SMB, FUSE, synchronized folders, and cloud workspace mounts therefore require
evidence about the exact path rather than an assumption that a path which looks local
behaves like a local disk.

A service can centralize the writer, but that changes the deployment model.
fsqlite is for applications that need a plain SQLite artifact, direct in-process access,
no required server, and multiple independent writers that may share a filesystem.
One computer is enough to create the motivating case: an interactive application, coding
agents, indexers, research agents, and automation processes can all update one compact
knowledge base.

fsqlite changes the shared unit from one live writable database to immutable complete
SQLite generations. Cooperative writers work in private SQLite files and publish a new
generation through the `f1.0` protocol.
Cross-client safety no longer depends on SQLite locks for one shared writable file; it
depends on exclusive directory creation, atomic rename-replace, no-replace hard links,
visibility, and durability from the store’s filesystem.

## Choose by Coordination Model

Writer coordination, publication timing, and isolation determine the storage model.
A single machine can have many independent writer clients, while several callers can
sometimes share one serialized writer lane.
The relevant questions are whether callbacks may queue, whether publication must be
immediate, which isolation model the application needs, and whether immutable portable
generations justify copying the complete head.

A fixed dataset needs no writer coordination and can be shared directly as a read-only
SQLite file. The choices below apply when the shared data continues to evolve.

Ordinary SQLite is the default for one embedded application on a reliable local
filesystem and remains a strong choice for several processes whose writers can queue on
one live database.
It provides immediate serializable transactions by making writers take
turns. WAL mode lets readers continue during the one active write.
That WAL baseline should run SQLite 3.51.3 or later (Node 22.22.3, 24.15.0, or any 26
release): SQLite 3.7.0 through 3.51.2 has a WAL-reset race between a checkpoint and a
committing writer that can corrupt a database used by two or more connections, fixed in
3.51.3 with backports in 3.44.6 and 3.50.7. fsqlite never runs WAL on store files,
because every build uses the `DELETE` journal.
A small transaction normally updates only the affected database, journal, WAL, and index
pages.

SnapshotStore addresses a common multi-agent workload: several independent agents need
to capture compact changes without sharing one writable SQLite file, can accept
reconcile-based visibility, and do not have a convenient database service.
Those agents may be local processes or may share a capability-validated cloud or network
path. DirectStore is the serialized fsqlite lane for callers that need immediate
publication and immutable generations, including callers on a validated path that cannot
provide SQLite’s live-file locking contract.
Ordinary SQLite remains the simpler choice for an embedded single-client database.

fsqlite gives simultaneous writers separate private SQLite copies and publishes complete
generations. A `SnapshotStore` writer copies the published database, makes a normal
SQLite transaction on that copy, and saves the resulting row changes in an envelope.
Reconciliation later applies accepted envelopes to another private copy and atomically
names that copy as the next published version.

This different boundary is valuable when a path cannot safely coordinate a live SQLite
file across clients, when independent processes should capture without queuing on one
SQLite writer, when immutable generations are useful recovery artifacts, or when a
database service is unacceptable.
Ordinary local SQLite remains the better trade when it already meets the need.

| Property | Ordinary SQLite | `DirectStore` | `SnapshotStore` |
| --- | --- | --- | --- |
| Stored state | One mutable database plus journal or WAL files | Immutable SQLite generations plus an atomic pointer | The same generations and pointer, plus transaction envelopes |
| Small-write cost | Usually proportional to changed pages and indexes | Copies, validates, and fsyncs the complete head | Copies the complete head for capture; reconcile copies and validates it again |
| Writers | SQLite serializes them | fsqlite serializes the complete write and publication | Captures may overlap; reconciliation serializes publication |
| Successful call | SQLite commit is the visibility and durability boundary, subject to its durability settings | `write()` has published the new snapshot | `write()` has accepted an envelope; reconcile either quarantines it or applies and publishes it durably |
| Multi-writer isolation | Serializable because writes take turns | Serializable for a DirectStore-only writer stream | Deterministic write-set merge; not serializable and no general read-set validation |
| Schema changes | Run as ordinary SQLite DDL under application coordination | Fixed schema per `f1.0` store epoch | The same fixed epoch; envelopes contain row changes, not DDL |
| Best fit | Embedded applications and processes that can reliably queue on one live database | Cooperative callers that need fsqlite publication and can serialize through one lane | Independent agent processes with compact state and reconcile-based visibility |

Every fsqlite snapshot remains an ordinary SQLite database and each build uses SQLite
transactions and constraints.
The store-level guarantee is nevertheless different.
fsqlite adds immutable predecessors, fail-closed validation, and an atomic publication
pointer, but it also adds a directory protocol and a later reconciliation boundary.
These mechanisms protect a different failure surface from ordinary SQLite.
On reliable local storage, ordinary SQLite has less protocol surface.
On a shared filesystem, fsqlite does not use SQLite’s live-file lock protocol as its
cross-client coordination mechanism, but it is safe only when its own required
filesystem primitives are correct and validated.
Each private working database still uses ordinary SQLite internally.

SQLite’s official [isolation](https://sqlite.org/isolation.html),
[WAL](https://sqlite.org/wal.html),
[network filesystem](https://sqlite.org/useovernet.html), and
[appropriate-use](https://sqlite.org/whentouse.html) documentation defines the ordinary
SQLite baseline behind this comparison.

## Goals and Non-Goals

fsqlite has two artifacts: the language-independent `f1.0` format and coordination
protocol, and a small TypeScript reference library and CLI packaged for npm.
Node releases supported by the reference package include SQLite and expose it through
the built-in `node:sqlite` module.
Every database operation therefore uses the same SQLite library supplied by Node that
application code reaches through a direct `node:sqlite` call.
Node’s filesystem and cryptography APIs supply the surrounding directory protocol.
The package has zero runtime dependencies and no install-time scripts; installing it
requires no separate SQLite installation or native build.

The `f1.0` format and conformance rules are language-independent.
Any SQLite binding can read a published generation.
Another language can implement `SnapshotStore` with SQLite compiled using
`SQLITE_ENABLE_SESSION` and `SQLITE_ENABLE_PREUPDATE_HOOK` and a binding that exposes
the session APIs, or implement `DirectStore` with ordinary SQLite.
Supported Node versions already include and expose the two compile-time features.
Both strategies can interoperate through the same files and protocol rules.

Its goals are:

- keep each published state as an ordinary SQLite database
- let readers use normal SQLite tools and bindings
- coordinate independent writers without depending on SQLite locks across clients that
  share one live writable file
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
| `C3` | Safety must not depend on WAL, advisory locks, or one host’s memory. | Writers never mutate a shared SQLite head. Required filesystem capabilities are atomic exclusive `mkdir`, atomic rename-replace, no-replace hard links, visibility after close, and durable fsync ordering. Publication fails if a required directory fsync is unavailable. | Correctness is conditional on those capabilities. Cross-host NFS/SMB proof is still a pre-1.0 gate. | `fsinspect`; `nfs-sim.test.ts`; QA Part C |
| `C4` | Readers do not take the publish lease, and independent writers can capture work concurrently. | Readers open immutable heads. `SnapshotStore` writers create unique transaction envelopes without the publish lease. | Cross-writer visibility occurs only after reconcile. | Spec W1-W4 and reader role; `concurrent.test.ts` |
| `C5` | A crash cannot destroy a previously published state. | Immutable snapshots, durable snapshot-before-pointer ordering, no-replace snapshot commits with identity checks around the pointer swap, atomic pointer replacement, fencing, OCC on `current`, the in-snapshot ledger, and archiving only what the published ledger holds define one commit point. | Accepted envelopes are not power-loss durable until publication. Arbitrary recursive copies of a live store are outside the guarantee. A holder frozen between its final checks and its pointer rename can still move `current` backward (spec L5, O6). | Spec R1, P1-P3, F5, and section 10; crash, kill, and fencing suites |
| `C6` | Detectable inconsistencies fail closed and repair never guesses. | Recognition separates absent, invalid, unsupported, and corrupt stores. Identity, digests, integrity, foreign keys, reserved tables, and schema compatibility are checked before destructive work or publication. | Undetectable hardware or protocol-bypassing corruption remains possible. Repair needs a verified clean recovery point. | Spec R2 and section 11; hardening, store-format, and repair suites |
| `C7` | Merge results are deterministic, exactly once, and closed over declared SQLite constraints. | Envelopes apply in byte-sorted order; action passes are fixed as `replace`, `omit`, `strict`; data and ledger entry share one transaction; nonreplaceable conflicts quarantine the complete envelope; foreign keys are checked at envelope boundaries. | Same-primary-key DATA/CONFLICT cases still require an application policy. General business invariants need stronger patterns. | Spec F1-F6 and merge policy; `merge-constraints.test.ts` |
| `C8` | A store and its evolution are self-identifying. | Root `fsqlite.json`, UUID `store_id`, format string `f1.0`, required features, snapshot metadata, SQLite application ID, and caller-schema identity cross-check one another. | Unknown features, unsupported versions, and a different caller-schema token block mutation. Format and schema migrations are separate explicit operations. | Spec M1-M5 and section 12; `store-format.test.ts`; `init.test.ts` |
| `C9` | The writable surface has an explicit cooperative trust boundary. | Writers use fsqlite APIs, callbacks cannot mutate fsqlite-owned rows, persistent or temporary SQLite schema state, or format identity state, and candidate snapshots are revalidated before publish. Runtime capabilities are probed rather than assumed. | A process with direct filesystem access can still violate the protocol. Callback functions that may be retried must not perform unrecoverable external side effects. | Spec S2-S4 and roles; direct, store-format, and capability suites |
| `C10` | Consistency claims must be precise. | Reads are snapshot-isolated by published version. Merge is optimistic write-set reconciliation with per-table same-row policy. `DirectStore` serializes its write transaction. | `SnapshotStore` is not serializable and does not validate general read sets, ranges, predicates, or aggregates. | `retry.test.ts`; research Finding K |
| `C11` | The format must be operable and recoverable without application schema code. | The CLI recognizes, validates, repairs, seals, collects, and diagnoses stores. Read leases pin snapshots during long reads or exports; `seal()` acquires one internally. | Staleness uses clocks and mtime, so tuning affects liveness. | Spec RL1-RL2, G0-G3, and section 11; CLI goldens and GC/lease suites |
| `C12` | The reference package must remain easy to audit and adopt. | It uses `node:sqlite`, has zero runtime dependencies and no install scripts, retains `node:test`, and publishes a schema-agnostic CLI. | Snapshot writers require the SQLite session extension and the documented Node range. | Package smoke on the Node 24.0.0 floor; CI on the Node 22.18.0 floor and the newest 22, 24, and 26 releases; lint, typecheck, and supply-chain gate |

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
The `lww` alias means that the incoming row wins as byte-sorted envelopes are applied.
Envelope IDs use timestamps for approximately chronological ordering, but `f1.0` does
not promise causal or globally clock-ordered last-write semantics across hosts.

SQLite constraints can connect rows that do not share a primary key.
Therefore fsqlite does not claim that different rows or tables can never conflict.
It claims that the same-primary-key policy is row-granular, while declared constraints
can reject an entire envelope across keys or tables.

| Declared rule | fsqlite behavior |
| --- | --- |
| Primary key | Required and non-null for every caller table. Same-key replaceable conflicts use the table policy. |
| `NOT NULL`, `UNIQUE`, and `CHECK` | SQLite enforces them during apply. A `CONSTRAINT` outcome quarantines the complete envelope. |
| Foreign key | The writer enforces foreign keys, so actions such as `ON DELETE CASCADE` or `SET NULL` run at capture and the changeset records their effects. Reconcile applies with enforcement off, so those effects land once instead of the action running again, then `foreign_key_check` runs before the ledger entry and again before publication. A violation, including one a merge creates by adding a child under a parent another envelope’s cascade deleted, quarantines the envelope. |
| Trigger | `SnapshotStore` rejects a schema that declares one, at `init()` and on every open, naming the trigger. Changeset apply runs ordinary statements, so a trigger would fire again and its recorded effects would conflict, and `node:sqlite` cannot disable triggers. `DirectStore` runs callbacks directly and supports triggers. |
| `ON CONFLICT REPLACE` or `IGNORE` on a primary key or `UNIQUE` | `SnapshotStore` rejects it, at `init()` and on every open, naming the table. Apply statements would resolve the clash by that clause, deleting or dropping rows silently under any policy, instead of reporting a conflict. `DirectStore` supports it. A `NOT NULL` conflict clause is accepted. |
| Cross-row application invariant | Not inferred. Use a version-stamped guard row, a `strict` point-row compare-and-retry pattern, or `DirectStore`. Range, predicate, and aggregate invariants are not protected by ordinary merge policy. |

Rowid and `AUTOINCREMENT` keys collide across concurrent `SnapshotStore` writers by
construction. Each writer’s private copy allocates the next key from the same published
base, so two concurrent inserts claim the same key, and the later envelope meets a
same-key CONFLICT: `strict` quarantines it, `lww` overwrites the earlier row, and
`union` drops the later one.
Tables that concurrent writers insert into should use caller-generated keys such as
UUIDs. `DirectStore` serializes writes, so its rowid keys do not collide.

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
SQLite 3.53.0 (Node 22.23.4 and later, 24.16 and later, and 26.1 and later) extends the
direct operations to adding and dropping `NOT NULL` and `CHECK` constraints; the
create-copy-drop-rename procedure remains the general path.
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
The first-principles distinction is whether the caller’s complete transaction callback
may run inside one serialized publication lane:

| Question | `DirectStore` | `SnapshotStore` |
| --- | --- | --- |
| When does the callback run? | After acquiring the publish lease, against the latest head | Without the publish lease, against the head selected at capture time |
| Can independent callbacks overlap? | No. Cooperative callers queue across the complete copy, callback, validation, and publication. | Yes. Each caller works on a private copy and emits a unique envelope. |
| When is a successful write visible and power-loss durable? | Before `write()` returns | After reconciliation accepts and publishes the envelope |
| Isolation across writers | Serializable for a DirectStore-only stream | Deterministic write-set merge without general read-set validation |
| Main cost | One full-head copy and fsync per write while holding the lease | One full-head copy per capture, plus a full-head reconciliation build |
| Natural agent use | Agents can queue and each transaction must observe the latest published state | Agents should capture independently and can accept batched publication |

On a normal local filesystem, ordinary SQLite is more efficient than DirectStore when
immutable publication is not needed and its live-file coordination fits the workload.
On a capability-validated shared path, either fsqlite strategy avoids writing one live
SQLite head. DirectStore serializes callback execution through the publication lease;
SnapshotStore moves that coordination to later reconciliation so captures can overlap.
Real cross-host behavior is still a pre-1.0 evidence gate.

### Shared Paths and Cloud Agents

The exact coordination requirements and measured mount capabilities select the strategy
for a network drive.
Both require correct exclusive directory creation, atomic rename-replace, no-replace
hard links, close-to-open visibility, and file and directory fsync behavior from the
exact mount.

Cloud-agent workspaces make this capability distinction practical rather than
hypothetical: their paths may be network-backed or virtualized even when an agent sees a
normal directory. The dated
[research report](research/research-2026-06-06-portable-concurrent-sqlite.md#d-why-nfssmbfusesync-folders-can-break-live-sqlite)
records one independently observed Claude Code on the web environment with a 9p-mounted
root filesystem.
That observation is a motivating example, not a stable product guarantee
or proof that a particular mount satisfies fsqlite.

After those capabilities have real multi-host evidence:

- Prefer SnapshotStore when agents are independent, callbacks may be slow or bursty, and
  it is valuable for each agent to capture work without holding the publication lease.
  Account for one head-sized working copy per in-flight capture and for delayed
  visibility until reconciliation.
- Prefer DirectStore when all agents can queue, each callback should observe the latest
  published head, and every successful return must be immediately visible and durable.
  Account for holding the lease across the complete copy, callback, validation, fsync,
  and publication path.
- Prefer a database service or coordinator when immediate shared visibility, sustained
  write throughput, rolling schemas, or stronger cross-row transactions dominate.
  Cloud deployment may make that service easier to operate than it is in a local
  workspace.

The current alpha evidence covers automated local multiprocess behavior and one-host
filesystem diagnostics.
The required two-host NFS/SMB proof remains a pre-1.0 gate, so shared-path use is an
architectural target rather than a blanket deployment recommendation.

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

Use `DirectStore` when every cooperative caller can queue while its complete operation
runs under one publication lease and each successful return must expose a durable new
generation. Several processes may call it; the local multiprocess suite verifies that
their writes serialize without loss.
“Serialized writer” means one active write lane, not one configured client.

- It needs no session extension.
- It copies, mutates, validates, and publishes synchronously under the publish lease.
- A DirectStore-only writer stream is serializable because those writes are globally
  serialized. Mixing in SnapshotStore envelopes inherits the merge model.
- A successful return is immediately visible and power-loss durable.
- It remains interoperable with SnapshotStore because both use OCC on `current` and the
  same publication protocol.

DirectStore deliberately trades overlapping capture for simpler semantics.
It must never be selected automatically from filesystem detection because a dangerous
shared path can look local.

The lease covers the copy, callback, checks, fsync, and publication.
With the Node defaults, `staleMs` is 20 seconds and `timeoutMs` is 30 seconds.
The writer renews the lease at each step boundary (after the copy, after the callback
and checks, after the fsync) and fences before each destructive step, so the stale
window must exceed the longest single step rather than the whole operation.
Repair renews it after scanning each snapshot.
A step that outlasts the window can still be broken, which costs a fenced retry, not
data. The callback can run more than once after an OCC or fencing loss, so it must keep
external side effects outside the retryable function or make them idempotent.
An optimistic DirectStore that runs the copy and callback outside the lease remains a
roadmap option.

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

Here, a local agent is an independently running process on one computer.
Threads inside one shared SQLite connection and remote hosts without validated storage
belong to different operating models.
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
no-replace hard links for snapshot commits, close-to-open visibility, and fsync
behavior.
`fsinspect` probes these properties from one host, and local multiprocess tests
simulate network-shaped visibility.
Every durability barrier is a file or directory fsync that fsqlite issues through Node
after SQLite has closed the file, so SQLite’s own sync settings do not matter for
publication. On macOS, Node’s fsync uses `F_FULLFSYNC`, which plain `fsync(2)` does not
(spec section 10). Directory fsync is part of the safe verdict and publication fails
closed when it is unavailable.
Neither is a substitute for the pending two-host NFS/SMB gate.
The alpha supplies a protocol design, a reference implementation, and local evidence;
universal shared-filesystem certification remains outside that scope.
Consumer synchronization folders are not conforming shared filesystems.

Known platform behavior shapes that boundary:

- **Containers and overlayfs.** Reconcile and repair move envelope directories with
  `rename()`. overlayfs fails a rename of a lower-layer directory with `EXDEV` unless
  its `redirect_dir` feature is enabled (by mount option, or by kernel config
  `OVERLAY_FS_REDIRECT_DIR`), so a store whose envelopes came from an image layer can
  fail to archive them on every reconcile (spec O7). The `volatile` mount option omits
  every sync to the upper filesystem, so fsync normally succeeds without persisting,
  surfacing an error only after an upper-filesystem writeback error; tmpfs never
  persists. Neither meets the spec section 10 barriers.
- **NFS staleness.** With default attribute caching (`acdirmin` 30 s, `acdirmax` 60 s)
  and `lookupcache=all`, a client can resolve `current` to the previous file for up to a
  minute after another host’s rename; on NFSv4 the `cto` option governs directory
  caching only. This costs liveness, not safety, but `retain` must exceed the staleness
  window, and a reader should treat a collected snapshot as a stale pointer to re-read
  (spec section 13); the reference reader fails loudly instead.
- **macOS.** Node’s `fs.fsyncSync` uses `F_FULLFSYNC`, which is stronger than SQLite’s
  default (`PRAGMA fullfsync` off).
  Because fsqlite’s own fsync runs after the SQLite connection closes, it supplies the
  stronger barrier.
- **Windows.** Directory fsync is unavailable from Node (`EPERM`), so publication fails
  closed by design, and SQLite opens snapshots without `FILE_SHARE_DELETE`, so an open
  snapshot cannot be renamed over or unlinked (spec O1).

### Backup and Copying

Published snapshots are immutable.
A reader can pin one with `readLease()` and copy that file safely.
`seal()` pins its selected source snapshot with an internal read lease and creates an
integrity-checked standalone SQLite artifact, published through an fsynced temp and an
atomic rename so the destination never holds a partial export.

Supported backup paths use a published snapshot, read lease, `seal()`, or the backup
helpers. An arbitrary recursive live-store copy may include recoverable transients, and
its software, copy order, GC races, or interruption can omit a complete clean snapshot.

### Threading and Processes

Operations open fresh connections and never share a connection across Worker Threads.
The filesystem protocol coordinates processes at a store root.
A formal Worker Thread coordination contract and dedicated tests remain roadmap work.
fsqlite owns the connections it passes to callbacks, so a callback must not close one.
Node 24.22, 26.8, and later reject `close()` from inside any SQLite callback with
`ERR_INVALID_STATE`; earlier releases, including every 22.x, can crash the process
(nodejs/node#63180).

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
It also opens every connection with SQLite’s defensive flag pinned on wherever
`node:sqlite` offers it (the `defensive` option, Node 24.12 and later, on by default
from 24.14), so `PRAGMA writable_schema`, `journal_mode = OFF`, `schema_version` writes,
and direct shadow-table writes are refused identically on every such line whatever its
default.
Node 22 has no such option; there those statements stay available to a callback,
and the checks above are the only guard.
These checks prevent accidental protocol damage.
They are not a security boundary against hostile code in the same process or an external
writer with file access.

Reconcile applies changeset blobs that other processes produced.
SQLite’s session module received memory-safety fixes for corrupt changesets in 2026
(CVE-2026-50812, a NULL dereference, and CVE-2026-50813, a buffer over-read, with
further rebaser and session over-read fixes in 3.53.3 and 3.53.4). The
`changeset_sha256` check detects accidental corruption, not a hostile writer, so a
malformed envelope from a process with store access remains outside the trust boundary
and can crash a reconciler running a SQLite release that predates those fixes.

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
  // Serialized publication transaction. The callback may be retried.
})
```

| Module | Responsibility |
| --- | --- |
| `src/storeFormat` | Marker recognition, format version, store identity, and required-feature gating |
| `src/snapshotStore` | Concurrent capture, reconcile, reads, leases, GC, validation, repair, and sealing |
| `src/directStore` | Local serialized writer over the same immutable format |
| `src/publication` | No-replace snapshot commit and identity-checked pointer swap shared by both strategies |
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
Windows mutation (blocked first by directory fsync and open-file rename and unlink, spec
O1), single steps longer than the lease stale window, independent format conformance
fixtures, explicit upgrades, Worker Thread coordination, stronger isolation patterns,
and large-store seeding efficiency.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
