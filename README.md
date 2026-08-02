# fsqlite

[![Follow @ojoshe on X](https://img.shields.io/badge/follow_%40ojoshe-black?logo=x&logoColor=white)](https://x.com/ojoshe)
[![CI](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml/badge.svg)](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml)

**Portable, stable SQLite, packaged for concurrent local agents.**

fsqlite packages SQLite for workflows with many local agents: point cooperative
processes at a store directory and use familiar SQL, schemas, constraints, tools, and
SQLite files. SQLite itself runs every transaction, and each immutable generation is a
complete standard SQLite database that ordinary tools and bindings can open directly.
A language-independent commit protocol coordinates independent transaction capture and
server-free publication; the first reference implementation is a zero-runtime-dependency
Node.js library.

> **Alpha phase:** `0.1.0` defines the first public API and draft `f1.0` format.
> Both may change before 1.0. Local POSIX multi-process behavior has extensive automated
> coverage, but the real cross-host NFS/SMB gate and Windows publication-race validation
> are still pending.

## Why fsqlite Exists

A single computer can run many independent database clients.
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

- **Portable SQLite files:** Every published generation is a complete database in the
  standard SQLite format.
  It moves unchanged across architectures and operating systems, opens with ordinary
  SQLite tools and bindings, and can be sealed as a plain file for archival or migration
  between environments.
- **Stable SQLite foundation:** The SQLite 3 file format has been
  [backward compatible since 2004](https://sqlite.org/formatchng.html), and the SQLite
  project [plans support through 2050](https://sqlite.org/lts.html).
  fsqlite retains SQLite’s [widely deployed](https://sqlite.org/mostdeployed.html)
  engine, SQL, transactions, schema, constraints, tooling, and file ecosystem.
- **SQLite-native change capture:** `SnapshotStore` uses SQLite’s official
  [session extension](https://sqlite.org/sessionintro.html) to record row transactions
  in private copies and apply them with SQLite’s conflict-aware changeset API. Sessions
  are less familiar than WAL, but this upstream feature has shipped in the SQLite
  amalgamation since 3.13.0 in 2016. For cooperative local clients that write
  independently in separate copies, sessions are SQLite’s native way to capture and
  merge row changes; fsqlite adds the atomic publication protocol around them.
- **Concurrency-safe publication:** Immutable generations, an atomic `current` pointer,
  fencing, optimistic publication, and an exactly-once ledger protect published state
  through process crashes and racing publishers.
- **Server-free operation:** Deployment needs only cooperative processes and a store
  directory; no database server, daemon, or background service is required.
- **Language-independent protocol:** The on-disk format and commit protocol can be
  implemented in any language; Node.js is the first reference implementation.

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
As of the report’s 2026-08-01 update, fsqlite occupies a distinct position among the
surveyed alternatives by combining direct server-free access, independent cooperative
capture, filesystem publication, and stock SQLite snapshots for unmodified readers.

## Choose by Writer Relationship

Choose a storage model from the way writers coordinate and when updates must become
visible. A single machine can have many independent writers, while several callers can
sometimes share one serialized writer lane.
Writer independence, visibility, isolation, snapshot size, and write cadence determine
the fit:

Here, an “agent” is an independently running cooperative process with its own store
handle. Threads sharing one SQLite connection belong to a different coordination model.

| Situation | Default choice | Why |
| --- | --- | --- |
| One embedded application owns a database on a reliable local filesystem | Ordinary SQLite, often with WAL | It is simpler, provides immediate serializable transactions, and writes changed pages instead of copying a complete snapshot. |
| Several independent local agents update compact shared state, captures may overlap, and visibility may wait for reconciliation | `SnapshotStore` | Each agent captures its transaction without the publish lease or a shared writable SQLite file; reconciliation merges and publishes the next immutable generation. |
| Cooperative callers can serialize the complete callback, need each return to be immediately published, and specifically value immutable generations or the fsqlite format | `DirectStore` | A filesystem lease serializes copy, transaction, validation, and publication. Multiple callers may queue, but only one write lane runs at a time. |
| Many writers need low-latency globally visible commits, high sustained throughput, rolling schemas, or serializable range and cross-row invariants | A client/server database or coordinator | Those requirements need a live coordination service or a different concurrency-control model. |

`SnapshotStore` is the main fsqlite strategy for the common multi-agent case.
It trades immediate visibility and serializability for independent capture and
file-native handoff.
`DirectStore` serves workloads that value immutable generations and immediate
publication enough to serialize every complete callback.
Ordinary SQLite remains the simpler choice for a single embedded owner.

Safety on shared network storage depends on the capabilities of the exact mount.
Both strategies require correct exclusive directory creation, atomic rename-replace,
close-to-open visibility, and file and directory fsync behavior.
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
crashes. The trust boundary covers cooperative fsqlite writers; raw tools must treat
published snapshots as read-only.
SnapshotStore provides deterministic write-set conflict handling rather than
serializability across writers because changesets do not record general read sets.
The [design constraints](docs/fsqlite-design.md#design-constraints) state the complete
guarantees and trust boundary.

## Portable Sharing and Replication

The live store is a directory, but each published head is a complete ordinary SQLite
file. `seal()` pins a generation and creates an integrity-checked standalone SQLite copy
for handoff, archival, upload, or import into another environment.
Readers need no fsqlite extension.

fsqlite provides a stable file boundary that an application can move with its own
transport. Remote transport, consensus, and automatic bidirectional replication remain
application responsibilities.
Reconcile the desired pending work before sealing when the exported artifact must
include the complete accepted tail.

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
