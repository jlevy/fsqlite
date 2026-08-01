# fsqlite

[![CI](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml/badge.svg)](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml)
[![npm alpha](https://img.shields.io/npm/v/fsqlite/alpha.svg?label=npm%20alpha)](https://www.npmjs.com/package/fsqlite)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Server-free, file-first concurrent SQLite for local agents.**

fsqlite is a language-independent store format and a zero-runtime-dependency Node.js
library for cooperative processes that share compact state without writing one live
SQLite database file.
Writers capture transactions independently, reconciliation publishes immutable SQLite
snapshots with atomic filesystem operations, and readers use ordinary SQLite tools and
bindings.

> **Alpha phase:** `0.1.0` defines the first public API and draft `f1.0` format.
> Both may change before 1.0. Local POSIX multi-process behavior has extensive automated
> coverage, but the real cross-host NFS/SMB gate and Windows publication-race validation
> are still pending.

## Why fsqlite Exists

One computer no longer implies one database client.
A local workspace may have an interactive application, coding agents, background
indexers, research agents, and automation processes updating the same knowledge base,
task graph, document catalog, or cache.
Those writers may have substantial contention even though every process is local, and
running a database server beside every workspace is often disproportionate.

The usual choices leave a gap:

- Ordinary SQLite is excellent when writers can queue on one live database file.
  It provides immediate, serializable commits and efficient page-level writes, but it
  still has one active writer and relies on the live-file locking and journaling model
  of the target filesystem.
- Distributed SQLite systems commonly add a primary, daemon, consensus cluster, storage
  service, custom engine, or reader extension.
  Those are reasonable designs, but they change deployment or artifact portability.
- JSON, JSONL, and ad hoc lock files remain easy to move, but they do not provide
  SQLite’s schema, queries, constraints, transactions, and tooling.

fsqlite combines a different set of properties:

- cooperative local processes capture row transactions without sharing a writable SQLite
  file or waiting for the publication lease
- immutable generations, an atomic `current` pointer, fencing, optimistic publication,
  and an exactly-once ledger protect published state from process crashes and racing
  publishers
- no database server, daemon, or background service is required
- every published generation is a standard SQLite file that can be inspected, sealed,
  archived, handed to another agent environment, or carried by an application-defined
  replication transport
- the format and commit protocol are language-independent; Node is the first reference
  implementation, not a new database engine or query language

The
[portable concurrent SQLite research](docs/research/research-2026-06-06-portable-concurrent-sqlite.md)
develops this argument from first principles.
Its
[landscape review](docs/research/research-2026-06-06-portable-concurrent-sqlite.md#e-the-prior-art-landscape-and-the-gap)
compares WAL, external locks, LiteFS, Litestream, rqlite, dqlite, libSQL, Turso,
changeset sync, and CRDT approaches.
The
[key insights](docs/research/research-2026-06-06-portable-concurrent-sqlite.md#key-insights)
and
[comparison matrix](docs/research/research-2026-06-06-portable-concurrent-sqlite.md#comparison-matrix)
explain why SQLite session changesets, immutable snapshots, and atomic publication fit
the server-free agent use case.
As of the report’s 2026-08-01 update, no surveyed alternative combined direct
server-free access, independent cooperative capture, filesystem publication, and stock
SQLite snapshots for unmodified readers.

## Choose by Writer Relationship

Host count is not the first decision branch.
A single machine can have many independent writers, while several callers can sometimes
share one serialized writer lane.
Choose from writer independence, visibility, isolation, snapshot size, and write
cadence:

Here, an “agent” is an independently running cooperative process with its own store
handle, not several threads sharing one SQLite connection.

| Situation | Default choice | Why |
| --- | --- | --- |
| One embedded application owns a database on a reliable local filesystem | Ordinary SQLite, often with WAL | It is simpler, provides immediate serializable transactions, and writes changed pages instead of copying a complete snapshot. |
| Several independent local agents update compact shared state, captures may overlap, and visibility may wait for reconciliation | `SnapshotStore` | Each agent captures its transaction without the publish lease or a shared writable SQLite file; reconciliation merges and publishes the next immutable generation. |
| Cooperative callers can serialize the complete callback, need each return to be immediately published, and specifically value immutable generations or the fsqlite format | `DirectStore` | A filesystem lease serializes copy, transaction, validation, and publication. Multiple callers may queue, but only one write lane runs at a time. |
| Many writers need low-latency globally visible commits, high sustained throughput, rolling schemas, or serializable range and cross-row invariants | A client/server database or coordinator | Those requirements need a live coordination service or a different concurrency-control model. |

`SnapshotStore` is the main fsqlite strategy for the common multi-agent case.
It trades immediate visibility and serializability for independent capture and
file-native handoff.
`DirectStore` is a serialized fsqlite publication strategy, not a reason to wrap an
otherwise ordinary single-client SQLite application.

Both strategies are designed around capability-defined filesystem operations rather than
filesystem names. That makes shared network storage an important target, but not an
automatic guarantee: the exact mount must provide correct exclusive directory creation,
atomic rename-replace, close-to-open visibility, and file and directory fsync behavior.
The alpha’s one-host `fsinspect` result is useful diagnostic evidence, not proof that an
arbitrary NFS or SMB deployment is safe across hosts.
Once a shared mount has real multi-host evidence, prefer `SnapshotStore` when local or
cloud agents should capture independently and converge later.
Prefer `DirectStore` when those agents can queue and each callback must observe the
latest published state.
Use a database service when the cloud environment makes one practical and the workload
needs immediate visibility, sustained throughput, or stronger transactions.

## Install

```bash
npm install fsqlite@alpha
```

Requires Node `>=22.18.0 <23 || >=24.0.0`.

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

// Independent agents can capture envelopes without taking the publish lease.
store.write('research-agent', (db) => {
  db.prepare('INSERT INTO facts VALUES (?, ?)').run('answer', '42')
})

// Any cooperative participant or an orchestrator may reconcile the pending tail.
store.reconcile()

const row = store.read((db) =>
  db.prepare('SELECT value FROM facts WHERE key = ?').get('answer'),
)
console.log(row)
```

Every caller table needs a non-null primary key.
`SnapshotStore` callbacks may perform data changes but not DDL; an `f1.0` store has one
fixed caller-schema epoch.
The [package README](packages/fsqlite/README.md) documents installation, the full writer
contract, conflict policies, schema replacement, CLI operations, and limitations.

## How Publication Works

An fsqlite store is a caller-provided directory identified by `fsqlite.json`:

```text
agent A capture \
agent B capture  -> committed transaction envelopes -> reconcile -> snapshot N+1
agent C capture /                                              |
                                                  atomic current pointer
                                                              |
                                              ordinary SQLite readers
```

Each `SnapshotStore.write()` copies the current immutable snapshot into a private
working database, runs one SQLite transaction, and stores its session changeset in a
uniquely named envelope.
`reconcile()` applies committed envelopes in deterministic order to a new private copy,
quarantines incompatible or constraint-breaking envelopes, validates the result, and
atomically publishes it by replacing `current`.

The protocol protects cooperative writers against capture-path contention, racing
reconcilers, duplicate application, stale publication leases, torn reads, and process
crashes.
It does not make raw tools safe to write into the store, and SnapshotStore merge
is not serializable across writers because changesets record write sets rather than
general read sets. The [design constraints](docs/fsqlite-design.md#design-constraints)
state the complete guarantees and trust boundary.

## Portable Sharing and Replication

The live store is a directory, but each published head is a complete ordinary SQLite
file. `seal()` pins a generation and creates an integrity-checked standalone SQLite copy
for handoff, archival, upload, or import into another environment.
Readers need no fsqlite extension.

fsqlite does not provide remote transport, consensus, or automatic bidirectional
replication.
It provides a stable file boundary that an application can move with its own
transport. Reconcile the desired pending work before sealing when the exported artifact
must include the complete accepted tail.

## Costs and Boundaries

- Each `SnapshotStore` capture copies the complete published head, and reconciliation
  copies it again. The natural alpha workload is compact state, occasional or bursty
  writes, and batched reconciliation, not a large high-throughput transactional
  database.
- A successful `SnapshotStore.write()` means the envelope was accepted.
  It becomes visible and power-loss durable only after reconciliation publishes it.
- `SnapshotStore` conflict policy resolves supported same-primary-key cases.
  It does not infer range, aggregate, predicate, or arbitrary cross-row invariants.
  `f1.0` also requires every reconciler to receive the same effective conflict policy;
  the store does not yet verify policy identity.
- Published snapshots are immutable and recoverable, but arbitrary recursive copying of
  a live store is not a supported backup contract.
- Multi-host NFS/SMB behavior, Windows publication races, schema migration, bounded
  ledger growth, a formal Worker Thread contract, and stronger isolation remain pre-1.0
  work.

The
[schema evolution and workload assessment](docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md)
contains current measurements and adoption boundaries.

## Documentation

| Need | Document |
| --- | --- |
| Install the package and use its API or CLI | [Package README](packages/fsqlite/README.md) |
| Understand the architecture and choose a strategy | [Design and Constraints](docs/fsqlite-design.md) |
| Implement or inspect the on-disk protocol | [FSQL Format Specification](docs/fsql-format-spec.md) |
| Review the file-first database landscape and technical rationale | [Portable Concurrent SQLite Research](docs/research/research-2026-06-06-portable-concurrent-sqlite.md) |
| Evaluate schema lifecycle and measured workload fit | [Schema Evolution and Workload Fit](docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md) |
| Map guarantees to automated and manual evidence | [QA Runbook](docs/qa-runbook.md) |
| See remaining portability and stable-release work | [Roadmap](docs/roadmap.md) |

The [documentation map](docs/README.md) records the authority and maintenance role of
every project document.
Release maintainers should follow the [release runbook](docs/releasing.md).

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

See [Contributing](CONTRIBUTING.md) for the focused commands and project invariants.

## License

MIT © 2026 Joshua Levy.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
