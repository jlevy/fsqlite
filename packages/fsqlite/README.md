# fsqlite

[![Follow @ojoshe on X](https://img.shields.io/badge/follow_%40ojoshe-black?logo=x&logoColor=white)](https://x.com/ojoshe)
[![CI](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml/badge.svg)](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml)

**Portable, stable SQLite, packaged for concurrent agents.**

fsqlite is ordinary SQLite with a file-level coordination layer for concurrent agents.
It publishes complete databases as immutable versions, so writers do not share one live
SQLite file.

You keep SQLite’s engine, SQL, transactions, portable file format, standard tools, and
server-free operation.
fsqlite adds concurrency-safe publication for cooperative writers.
`seal()` can make a consistent point-in-time copy while publication continues; a
successful copy contains one complete version, and later work is outside that copy.

This zero-runtime-dependency package uses SQLite built into Node 22.18+ on 22.x, Node
24, or Node 26 and later, through the built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) module.
It requires no separate SQLite installation or native build.
fsqlite and direct `node:sqlite` calls use the same SQLite library; this package is the
first implementation of the language-independent `f1.0` commit protocol.

> **Alpha phase:** `0.1.0` defines the first public API and draft `f1.0` format.
> Both may change before 1.0. Local POSIX multi-process behavior has extensive automated
> coverage, but the real cross-host NFS/SMB gate and Windows publication-race validation
> are still pending.

## Why fsqlite Exists

The
[project README](https://github.com/jlevy/fsqlite/blob/main/README.md#why-fsqlite-exists)
explains the shared-filesystem failure fsqlite addresses, its
[core properties](https://github.com/jlevy/fsqlite/blob/main/README.md#core-properties),
[what it adds to SQLite](https://github.com/jlevy/fsqlite/blob/main/README.md#what-fsqlite-adds-to-sqlite),
and
[why it is practical now](https://github.com/jlevy/fsqlite/blob/main/README.md#why-fsqlite-is-practical-now).

## Should You Use fsqlite?

The
[storage-model guide](https://github.com/jlevy/fsqlite/blob/main/README.md#choose-a-storage-model)
compares ordinary SQLite, `SnapshotStore`, `DirectStore`, and a client/server database
by writer independence, visibility, isolation, snapshot size, and write cadence.

The
[coordination-model design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#choose-by-coordination-model)
develops this decision from visibility, isolation, snapshot size, and writer
independence.

fsqlite buys immutable published states, explicit recovery points, and file-native
coordination without a required service.
It pays for those properties with a full-head copy for every write, delayed cross-writer
visibility, more transient disk use, and a multi-writer merge model that is not
serializable. Agent count alone does not determine fit: snapshot bytes multiplied by
write rate and burst size determine most of the cost.

## Shared Filesystems and Cloud Agents

fsqlite targets shared paths that cannot provide SQLite’s live-file locking contract but
can provide the `f1.0` publication contract.
The
[project README](https://github.com/jlevy/fsqlite/blob/main/README.md#shared-filesystems-and-cloud-agents)
lists the filesystem behavior both strategies require and why it matters in cloud-agent
sandboxes.

The alpha’s one-host `fsinspect` result is useful diagnostic evidence, not proof that an
arbitrary NFS or SMB deployment is safe across hosts.
Once a shared mount has real multi-host evidence, prefer `SnapshotStore` when local or
cloud agents should capture independently and converge later.
Prefer `DirectStore` when those agents can queue and each callback must observe the
latest published state.
Use a database service when the cloud environment makes one practical and the workload
needs immediate visibility, sustained throughput, or stronger transactions.

SQLite’s own guidance defines the baseline for an ordinary live database: use SQLite for
device-local storage with writers that can take turns, and use a client/server engine
when many writers cannot queue or when clients directly access data over a network.
fsqlite changes that boundary by requiring cooperative writers to publish immutable
files; it does not make arbitrary SQLite clients safe on a network drive.
See [Appropriate Uses For SQLite](https://sqlite.org/whentouse.html),
[Isolation In SQLite](https://sqlite.org/isolation.html), and
[Write-Ahead Logging](https://sqlite.org/wal.html).
The
[shared-path design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#shared-paths-and-cloud-agents)
explains the required filesystem evidence and deployment choices in detail.

## Architecture

The [project README](https://github.com/jlevy/fsqlite/blob/main/README.md#architecture)
shows a typical store directory, its data and coordination files, and how the two write
paths publish the same layout.

Replacing `current` is the store commit point.
The snapshot is written and fsynced first, so readers see either the previous complete
SQLite database or the next one.
Fencing, optimistic checks on `current`, and an in-snapshot transaction ledger protect
publication from racing publishers, stale leases, duplicate application, and process
crashes. The
[architecture design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#architecture)
covers the complete store layout, publication races, and consistency boundaries.

## Reference Implementation

This package’s reference implementation is roughly 4,100 lines of TypeScript code
(November 2026), including the CLI and excluding tests and generated output.
It uses only Node built-ins and has zero runtime dependencies.
Supported Node releases include SQLite and expose it through the built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) module; fsqlite uses that module
with Node’s filesystem and cryptography APIs.
Node supplies the database engine and native integration, while the npm package supplies
the `f1.0` protocol implementation and CLI. Installing it requires no separate SQLite
installation, native add-on, or install-time build.

The
[project README](https://github.com/jlevy/fsqlite/blob/main/README.md#reference-implementation)
describes what an implementation in another language needs to read or write the same
store.

## Install

```bash
npm install fsqlite@alpha
```

Requires Node `>=22.18.0 <23 || ^24.0.0 || >=26.0.0`. The split range is intentional:
fsqlite statically imports the `node:sqlite` backup API introduced in Node 22.16, and
its source development loop also relies on type stripping stabilized in Node 22.18. Node
23 is not an LTS line and versions before 23.8 cannot load the package.
Node 25, a non-LTS line, reached end of life on 2026-06-01 and is excluded too.

Prefer Node 24.22 or later, or Node 26.8 or later: those releases carry the 2026
`node:sqlite` memory-safety fixes, including the guard against closing a database from
inside a SQLite callback.
Node 26 has been the Active LTS line since 2026-10-28, and Node 24 has been in
Maintenance since 2026-10-20; both lines mark `node:sqlite` as a release candidate and
print no experimental warning.
Node 22 (Maintenance, end of life 2027-04-30) lacks those fixes, still marks
`node:sqlite` as in active development, and prints
`ExperimentalWarning: SQLite is an experimental feature` once per process.
The warning comes from Node, not from fsqlite; the `fsqlite` CLI hides that one notice,
and an application can start Node with `--disable-warning=ExperimentalWarning`. See the
[Node release schedule](https://github.com/nodejs/Release) and the
[`node:sqlite` stability notes](https://nodejs.org/api/sqlite.html).

## Quick Start

```ts
import { SnapshotStore } from 'fsqlite'

const store = new SnapshotStore('./knowledge.fsqlite', {
  schema: `
    CREATE TABLE facts (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `,
  schemaVersion: 1,
  conflictPolicy: { facts: 'lww', '*': 'strict' },
}).init()

// A writer records an envelope without taking the publish lease.
store.write('research-agent', (db) => {
  db.prepare(
    'INSERT INTO facts VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('answer', '42')
})

// Reconciliation folds pending envelopes into a new immutable snapshot.
store.reconcile()

const answer = store.read(
  (db) => db.prepare('SELECT value FROM facts WHERE key = ?').get('answer')?.value,
)
console.log(answer) // 42
```

Every table must have a non-null primary key.
The `f1.0` writer contract does not support virtual tables or DDL inside write
callbacks. `SnapshotStore` also rejects a schema that declares triggers, because
reconciliation would fire them a second time, and an `ON CONFLICT REPLACE` or `IGNORE`
clause on a primary key or `UNIQUE` constraint, which would let reconciliation resolve a
clash silently instead of applying the merge policy; use `DirectStore` for such a
schema. Foreign-key actions such as `ON DELETE CASCADE` work with both strategies.
Give tables that concurrent `SnapshotStore` writers insert into caller-generated keys,
such as UUIDs: writers seeded from the same snapshot allocate the same next rowid or
`AUTOINCREMENT` value, so their inserts always conflict.
Conflict actions are `lww` (replace), `union` (keep the existing row), and `strict`
(quarantine the conflicting envelope).
The `'*'` default is `strict` when omitted.
The policy is deployment configuration rather than stamped `f1.0` store metadata, so
every reconciler for one store epoch must use the same effective policy.
`lww` means the incoming row wins in deterministic envelope application order; it is not
a causal or globally clock-ordered last-write guarantee across hosts.

Call `init()` on each application handle before ordinary use.
On an existing store it verifies the exact caller-schema identity rather than executing
the DDL again. If the store still holds snapshots but has lost `current`, `init()`
refuses to create a new empty snapshot 0; run `fsqlite repair` to restore the pointer.
`schemaVersion` is an integer from 0 through 2,147,483,647. Incrementing it does not
migrate a store; a different version or exact schema string is incompatible until a
future explicit migration protocol exists.

## Choose a Write Strategy

|  | `SnapshotStore` | `DirectStore` |
| --- | --- | --- |
| Best for | Independent agents that benefit from overlapping capture and can accept reconcile-based visibility | Cooperative callers that can queue through one synchronous publication lane |
| Write path | Capture an envelope, then reconcile | Copy, mutate, and publish synchronously |
| Session extension | Required for writers | Not required |
| Read path | Immutable published SQLite snapshot | The same |
| On-disk format | `f1.0` | `f1.0` |

Both strategies can open the same store.
`DirectStore` keeps the immutable publication and recovery model while removing the
envelope/reconcile step.
Several processes may call it, but the publish lease serializes their complete copy,
callback, validation, and publication path.
It still copies and fsyncs the complete published snapshot for each write, so it is a
semantic simplification rather than a large-database performance optimization.
Its callback may run more than once after a fencing or publication race, so keep
external side effects outside the callback or make them idempotent.
The
[write-strategy design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#two-write-strategies)
details each strategy’s lifecycle and guarantees.

## Changing an Application Schema

An `f1.0` store has one fixed caller-schema epoch.
The schema string and `schemaVersion` identify that epoch; changing either value rejects
the handle.
This is stricter than ordinary SQLite, where an application can run supported
`ALTER TABLE` operations in a normal write transaction.

The restriction exists because a SnapshotStore envelope contains row changes, not DDL.
SQLite’s session extension expects a compatible target schema.
Mixing envelopes from old and new schemas could otherwise reinterpret columns, defaults,
constraints, primary keys, or conflict policy without a safe ordering rule.

Until fsqlite has an explicit migration command, use an application-managed replacement:

1. Stop every writer and reconciler for the old store.
2. Reconcile acceptable pending envelopes and resolve any quarantine so the source has
   one deliberate final state.
3. Validate and seal that state for backup and rollback.
4. Create a separate store with the new schema.
   Copy or transform data through a working SQLite database that follows SQLite’s
   documented schema-change procedure when needed; never alter a published fsqlite
   snapshot in place.
5. Validate the destination, switch every process to it, and keep the old store until
   the rollback window closes.

This creates a replacement store with a new `store_id`; it is not an in-place fsqlite
migration or an atomic cross-process cutover supplied by this package.
The application must prevent old writers from continuing on the old path.
Even a normally compatible change such as adding a column starts a new epoch in `f1.0`.

The
[schema-change design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#schema-changes-in-practice)
explains the fsqlite protocol requirements.
SQLite documents its directly supported alterations and its general
create-copy-drop-rename procedure in
[ALTER TABLE](https://sqlite.org/lang_altertable.html).
A future fsqlite migration protocol must add writer admission, pending-envelope
treatment, validation, rollback, and cutover around those ordinary SQLite steps.

## A Store Identifies Itself

The directory passed to the constructor is the store root.
It contains a visible, machine-owned `fsqlite.json` marker:

```json
{
  "format": "fsqlite",
  "format_version": "f1.0",
  "required_features": [],
  "store_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Snapshots and transaction manifests repeat the format version and `store_id`, so mixed
or copied contents fail closed.
Snapshot databases carry SQLite `application_id` `0x4653514C` (`FSQL`); your schema owns
`PRAGMA user_version`.

The directory format and caller schema have separate identities.
`format_version: "f1.0"` identifies the fsqlite protocol.
The caller-schema identity is `schemaVersion` plus the first 16 lowercase hexadecimal
characters of SHA-256 over the exact UTF-8 schema string.
Whitespace or comments change that token even if the resulting SQLite schema would be
equivalent.

`recognizeStore()` distinguishes a missing marker, invalid metadata, unsupported
versions/features, and a supported store.
Opening a store never upgrades it.
Future format upgrades will be explicit, side-by-side operations that preserve
`store_id` and leave the source untouched until cutover.

The
[store-layout specification](https://github.com/jlevy/fsqlite/blob/main/docs/fsql-format-spec.md#2-store-layout)
defines the complete directory identity and structure.

## API Reference

Everything below is exported from `fsqlite`, along with every option and result type
named here. Invalid arguments throw `TypeError`; every other deliberate failure is an
[`FsqliteError`](#errors).

### Store Handles

`new SnapshotStore(dir, options)` and `new DirectStore(dir, options)` create handles on
the store root `dir` without touching the filesystem.
`StoreOptions` holds `schema` (the caller DDL), `schemaVersion` (default 1),
`conflictPolicy` (SnapshotStore only), `toolVersion` (recorded on envelopes), and
`maxEnvelopeBytes` (SnapshotStore only; default 1 GiB). `DirectStoreOptions` is
`StoreOptions` without the last two.

| Method | Returns | Contract |
| --- | --- | --- |
| `init()` | the handle | Creates the store in an empty or missing directory, or verifies the exact schema identity of an existing one |
| `write(writerId, fn)` | tx id or `null` | SnapshotStore: runs `fn` on a private copy and commits its changeset as a pending envelope; `null` when `fn` changed nothing |
| `writeWithRetry(writerId, fn, { maxRetries })` | `WriteWithRetryResult` | SnapshotStore: writes, reconciles, and re-runs `fn` on a newer head after a `strict` conflict (default 5 attempts) |
| `reconcile({ maxRetries, lockOpts })` | `ReconcileResult` | SnapshotStore: folds the pending tail into the next published version (`published`, `applied`, `quarantined`, `attempts`) |
| `pendingTxns()` | `string[]` | SnapshotStore: committed pending envelope names in the order reconcile applies them |
| `write(fn, { lockOpts, maxRetries })` | version | DirectStore: copies, mutates, validates, and publishes under the publish lock; may re-run `fn` after a lost race |
| `read(fn)` | `fn`’s result | Runs `fn` on a read-only connection to the published head |
| `currentVersion()` | version | The version `current` names |
| `readLease({ maxRetries })` | `ReadLease` | Pins the head against `gc`; `heartbeat()` keeps the pin fresh, `release()` drops it |
| `snapshotPath(version)` | path | The file of a published version |
| `validate()` | `ValidateResult` | Classifies the store as `sealed`, `live`, `in-flight-capture`, `corrupt`, or a recognition failure, with issues |
| `gc({ retain, leaseStaleMs, transientStaleMs, lockOpts })` | `GcResult` | Deletes superseded snapshots and stale transients under the publish lock; refuses an unhealthy store |
| `planRepair({ lockOpts })` | `RepairResult` | Lists the steps `repair()` would take without changing anything |
| `repair({ lockOpts })` | `RepairResult` | Restores the last consistent published state without deleting a recovery point first, and returns archived envelopes the restored head lacks to the pending tail; refuses while a live publisher holds the lock |
| `seal(destPath)` | `destPath` | Writes an integrity-checked standalone copy of the head; refuses while envelopes are pending |

`lockOpts` is a `LockOptions` with `timeoutMs` (default 30 s), `pollMs` (25 ms),
`staleMs` (20 s), and an `onStaleBreak` callback.
Each window must be a positive finite number of milliseconds and `timeoutMs` must exceed
`staleMs`; every method that takes `lockOpts` throws `TypeError` otherwise, before it
touches the store.
`gc` keeps `DEFAULT_RETAINED_SNAPSHOTS` (3) predecessors by default and treats leases
and transients older than 60 s as abandoned.
A `ReadLease` is disposable, so `using lease = store.readLease()` releases it at the end
of the scope where the runtime supports `using` declarations (Node 22 does not).

A `DirectStore` write returns the version it published:

```ts
import { DirectStore } from 'fsqlite'

const direct = new DirectStore('./catalog.fsqlite', {
  schema: 'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)',
  schemaVersion: 1,
}).init()

const version = direct.write((db) => {
  db.prepare('INSERT OR REPLACE INTO items VALUES (?, ?)').run('a1', 'First item')
})
console.log(version, direct.read((db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n))
```

A lease pins a version while another tool copies it:

```ts
import { copyFileSync } from 'node:fs'

const lease = store.readLease()
try {
  copyFileSync(store.snapshotPath(lease.version), './backup.sqlite')
} finally {
  lease.release()
}
```

### Helpers

| Export | Contract |
| --- | --- |
| `recognizeStore(dir)` | Returns `{ state: 'supported', marker }` or a `not-a-store`, `invalid`, or `unsupported` state with an issue, without throwing |
| `readStoreMarker(dir)` | Returns the `StoreMarker` or throws `StoreFormatError` |
| `backupDatabase(source, dest, { rate, progress })` | Copies a live SQLite database with SQLite’s online backup API (async) |
| `isSqliteFile(path)`, `sqliteFacts(path)`, `integrityReport(path)` | Schema-agnostic facts and integrity problems for any SQLite file |
| `inspectFilesystem(dir)`, `formatInspectReport(report)` | The `fsinspect` probes and verdict for an existing directory, and their text rendering |
| `capabilities()` | Whether the `node:sqlite` binding has the session extension, changeset apply, backup, and a rebaser |
| `FSQLITE_APPLICATION_ID`, `STORE_FORMAT_NAME`, `STORE_FORMAT_VERSION`, `STORE_MARKER_FILENAME` | The `f1.0` identity constants |

`fsqlite/cli` exports `main(argv)`, which runs one CLI invocation in-process (with
`argv` excluding the node and script paths) and returns its exit code.

## CLI

The CLI can inspect and maintain a store without application schema code:

```text
fsqlite info      <dir>
fsqlite validate  <dir>
fsqlite stats     <path>
fsqlite gc        <dir> [--retain N]
fsqlite seal      <dir> <out.sqlite>
fsqlite repair    <dir> [--dry-run]
fsqlite doctor    <path> [--fix]
fsqlite fsinspect <dir>
```

Every command takes `--json` and `--help`; `fsqlite --help` and `fsqlite --version` work
too. Arguments are parsed strictly: an unknown command or option, a missing or extra
argument, or an invalid `--retain` is a usage error that changes nothing.

| Exit code | Meaning |
| --- | --- |
| `0` | Success; a reported store is `sealed` or `live` |
| `1` | The operation failed |
| `2` | In flight: a capture, publication, or maintenance step is mid-flight |
| `3` | The store is invalid or corrupt |
| `4` | The store needs a newer format version or feature |
| `5` | `fsinspect`: the filesystem cannot host a store |
| `64` | Usage error, or the path is not an fsqlite store |

A command that reports on a store (`info`, `validate`, `stats`, `doctor`, `repair`)
exits with the code of the state it reports, and a command that fails exits with the
code of its error, so `gc` on an unsupported store exits `4` like `validate` does.
`repair --dry-run` prints the steps repair would take without changing anything.
`repair` and `doctor --fix` delete every transient file, so run them only when no writer
or reconciler is active.
Errors print their cause chain; set `FSQLITE_DEBUG=1` for the stack.

`seal` produces a standalone SQLite copy and replaces its output path atomically, so
that path holds either the previous file or the complete export; it refuses a
destination the store owns.
`gc` holds the publish lock for every deletion and refuses a store whose head fails
validation. `stats` and `doctor` also accept a plain SQLite file.
`fsinspect` probes the local filesystem operations fsqlite depends on, but it is a
heuristic from one host, not a substitute for the pending multi-host gate.
Its safe verdict requires working directory fsync and a filesystem whose fsync persists
as well as the coordination primitives, so it refuses tmpfs, ramfs, and overlayfs
mounted with `volatile`. It probes an existing directory and never creates one.
The QA runbook includes a
[manual CLI walkthrough](https://github.com/jlevy/fsqlite/blob/main/docs/qa-runbook.md#b3-cli-walkthrough-on-a-real-store)
and filesystem capability check.

## Errors

Every error fsqlite raises on purpose is an `FsqliteError` with a stable `code` and a
`retryable` flag, so callers branch on those rather than on message text.
Argument mistakes throw `TypeError`.

| `code` | Meaning | What to do |
| --- | --- | --- |
| `not-a-store` | The path has no `fsqlite.json` | Check the path |
| `invalid` | `fsqlite.json` is malformed | Inspect the marker; nothing may mutate the store |
| `unsupported` | A newer format version or required feature | Use a newer fsqlite |
| `corrupt` | Torn or dangling pointer, identity mismatch, a head that fails integrity checks, or archived envelopes the head’s ledger lacks | Run `repair` |
| `in-flight` | A live publisher holds the lock, or a captured write is still pending | Wait, then retry (see `TransactionError`) |
| `conflict` | A changeset conflicted under the merge policy | `StrictConflictError` is retryable; `PermanentConflictError` is not |
| `retryable` | Bounded contention ran out (`LockTimeoutError`, lost lock ownership, publish retries) | Retry later |
| `post-publish` | A step failed after `current` named the new version (`PostPublishError.published`) | Do not re-run the write |
| `incompatible` | The handle’s schema, schema version, or SQLite binding cannot serve the store | Fix the caller |
| `refused` | A precondition failed, such as sealing a pending tail or a callback that changed the schema | Fix the call |
| `io` | A required filesystem step failed; `cause` holds the system error | Fix the environment |

`StoreFormatError` (the recognition codes, with `state`), `ConflictError` (with
`conflictTypes`), `LockTimeoutError` (with `lockPath` and `timeoutMs`), and
`TransactionError` (with `txId` and `quarantineReason`) are subclasses.

## Correctness Model

Published snapshots are immutable, `current` is the atomic commit pointer, and every
changeset shares one SQLite transaction with its `applied_tx` ledger entry.
Replaceable same-primary-key conflicts follow the table policy.
NOTFOUND, CONSTRAINT, and FOREIGN_KEY outcomes quarantine the complete envelope, and
foreign keys are checked at envelope and publication boundaries.

Callbacks cannot change the SQLite schema, format identity, caller schema version, or
fsqlite-owned tables.
Maintenance fails closed on malformed identity, unsupported capabilities, unreadable
leases, or a missing clean recovery point.

Publication fsyncs the snapshot, pointer, and containing directories.
A required directory fsync failure aborts initialization or publication rather than
silently weakening the durability claim.
A successfully captured envelope survives process failure but is only guaranteed
power-loss durability after reconciliation publishes it.
An optional durable-envelope mode is future work.

The
[design constraints](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#design-constraints)
state the complete guarantees, costs, and trust boundaries.
The
[format specification](https://github.com/jlevy/fsqlite/blob/main/docs/fsql-format-spec.md)
is the normative protocol authority.

## Limitations

- The format and API are alpha and may change.
- POSIX filesystems are the supported target for this alpha; Windows publication races
  are not yet validated.
- Cross-host NFS/SMB behavior is designed into the protocol but not yet proven by the
  real multi-host gate.
  Do not treat the alpha as that proof.
- The natural workload is a few to a few dozen cooperative local agents, short data
  callbacks, a single-digit-MiB head, occasional writes, and batched reconciliation.
  A handful of agents against a low-tens-of-MiB head can fit with background-latency
  tolerance, but requires measurement.
  Large or high-frequency workloads are a poor default fit.
- Reconciliation serializes publication, and visibility across writers occurs when
  reconciliation completes rather than immediately after envelope capture.
- Row-level policies do not by themselves protect arbitrary range, aggregate, or
  cross-row invariants.
  Use `strict` with retry for supported point-row invariants, or the serialized
  `DirectStore` strategy.
- `f1.0` requires every reconciler to receive the same effective conflict policy; the
  store does not yet verify policy identity.
- `SnapshotStore` seeds each default writer by copying the published snapshot, so write
  latency grows with snapshot size.
  Two runs of the maintained 2 KB-row benchmark measured median capture at 13.7 to 18.2
  ms for 2.0 MiB and 163.8 to 164.6 ms for 21.7 MiB. Eight child processes issuing 40
  total writes against 21.7 MiB took 8.4 to 8.9 seconds including startup.
  Treat these hardware-specific measurements as sizing evidence, not a portable rate or
  performance guarantee.
  Any faster seed must preserve the data and constraints the callback observes; safe
  large-store overlays, compaction, and shared-base alternatives remain on the
  [roadmap](https://github.com/jlevy/fsqlite/blob/main/docs/roadmap.md).
  Snapshot bytes create the unavoidable full-copy floor.
  Table count adds schema setup work and SQLite pages, but the calibration did not
  isolate an independent table-count slope.
  Batching reconciliation amortizes the build and publication, not the per-writer seed
  copy.
- Concurrent writers can transiently require one head-sized working copy each, in
  addition to retained snapshots, read leases, a reconcile build, and envelopes.
  Reconcile also loads the lifetime `applied_tx` ledger, which is not yet checkpointed.
  Monitor free space and pending backlog.
- DirectStore holds its lease across copy, callback, checks, fsync, and publication, and
  renews it at each step boundary.
  Configure a stale window longer than the longest single step (one head copy, one
  callback, or one fsync).
  A stolen lease is fenced safely but can cause the callback to retry.
- `seal()` pins one published snapshot and creates an integrity-checked point-in-time
  SQLite file while writers continue.
  It refuses to start while committed envelopes are pending, so reconcile first;
  envelopes committed and versions published after it selects the snapshot are outside
  that export. Use `readLease()` or `backupDatabase()` for other live-copy workflows; an
  arbitrary recursive directory copy racing publication or garbage collection is not
  supported. The
  [backup and copying design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#backup-and-copying)
  defines the supported workflows.
- Write callbacks are data transactions over a fixed schema.
  Persistent and temporary DDL, including temporary tables and triggers, and virtual
  tables are outside the `f1.0` concurrent-writer contract.
  Caller-schema migration, including admission of old writers and handling old pending
  envelopes, is post-alpha work.

The
[schema and workload assessment](https://github.com/jlevy/fsqlite/blob/main/docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md#practical-operating-envelope)
gives detailed severity, measurements, and adoption guidance.

## License

MIT © 2026 Joshua Levy.
See [LICENSE](https://github.com/jlevy/fsqlite/blob/main/LICENSE).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
