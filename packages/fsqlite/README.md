# fsqlite

[![CI](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml/badge.svg)](https://github.com/jlevy/fsqlite/actions/workflows/ci.yml)
[![npm alpha](https://img.shields.io/npm/v/fsqlite/alpha.svg?label=npm%20alpha)](https://www.npmjs.com/package/fsqlite)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jlevy/fsqlite/blob/main/LICENSE)

Filesystem-friendly concurrent SQLite for Node.js.

fsqlite publishes immutable SQLite snapshots and coordinates writers with ordinary
filesystem operations.
Readers still open normal SQLite files, and a store needs no database server or
background service. The package has zero runtime dependencies and no install-time
scripts.

> **Alpha phase:** `0.1.0` defines the first public API and the draft `f1.0` store
> format. Both may change before 1.0. The multi-process suite is extensive, but the real
> cross-host NFS/SMB validation gate is still pending.

## Install

```bash
npm install fsqlite@alpha
```

Requires Node `>=22.18.0 <23 || >=24.0.0`. The split range is intentional: fsqlite
statically imports the `node:sqlite` backup API introduced in Node 22.16, and its source
development loop also relies on type stripping stabilized in Node 22.18. Node 23 is not
an LTS line and versions before 23.8 cannot load the package.

## Quick Start

```ts
import { SnapshotStore } from 'fsqlite'

const store = new SnapshotStore('./example.fsqlite', {
  schema: `
    CREATE TABLE kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `,
  schemaVersion: 1,
  conflictPolicy: { kv: 'lww', '*': 'strict' },
}).init()

// A lock-free writer records a transaction envelope.
store.write('worker-a', (db) => {
  db.prepare('INSERT INTO kv VALUES (?, ?)').run('answer', '42')
})

// Reconciliation folds pending envelopes into a new immutable snapshot.
store.reconcile()

const row = store.read((db) => db.prepare('SELECT value FROM kv WHERE key = ?').get('answer'))
console.log(row)
```

Every table must have a non-null primary key.
The `f1.0` writer contract does not support virtual tables or DDL inside write
callbacks. Conflict actions are `lww` (replace), `union` (keep the existing row), and
`strict` (quarantine the conflicting envelope).
The `'*'` default is `strict` when omitted.

Call `init()` on each application handle before ordinary use.
On an existing store it verifies the exact caller-schema identity rather than executing
the DDL again. `schemaVersion` is an integer from 0 through 2,147,483,647. Incrementing
it does not migrate a store; a different version or exact schema string is incompatible
until a future explicit migration protocol exists.

## Choose a Write Strategy

|  | `SnapshotStore` | `DirectStore` |
| --- | --- | --- |
| Best for | Concurrent, independent writers | A simple local single-writer application |
| Write path | Capture an envelope, then reconcile | Copy, mutate, and publish synchronously |
| Session extension | Required for writers | Not required |
| Read path | Immutable published SQLite snapshot | The same |
| On-disk format | `f1.0` | `f1.0` |

Both strategies can open the same store.
`DirectStore` keeps the immutable publication and recovery model while removing the
envelope/reconcile step.
Its callback may run more than once after a fencing or publication race, so keep
external side effects outside the callback or make them idempotent.

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

See the
[format specification](https://github.com/jlevy/fsqlite/blob/main/docs/fsql-format-spec.md)
and [design](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md) for the
complete protocol.

## CLI

The CLI can inspect and maintain a store without application schema code:

```text
fsqlite info      <dir>
fsqlite validate  <dir>
fsqlite stats     <path> [--json]
fsqlite gc        <dir> [--retain N]
fsqlite seal      <dir> <out.sqlite>
fsqlite repair    <dir>
fsqlite doctor    <path> [--json] [--fix]
fsqlite fsinspect <dir> [--json]
```

Recognition and health have distinct exit codes: healthy `0`, in-flight `2`, invalid or
corrupt `3`, unsupported `4`, and not an fsqlite store `64`.

`seal` produces a standalone SQLite copy.
`stats` and `doctor` also accept a plain SQLite file.
`fsinspect` probes the local filesystem operations fsqlite depends on, but it is a
heuristic from one host, not a substitute for the pending multi-host gate.
Its safe verdict requires working directory fsync as well as the coordination
primitives.

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
  Use `strict` with retry for supported point-row invariants, or a single-writer
  strategy.
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
  Table count adds schema setup work and some SQLite pages, but snapshot bytes are the
  main scaling variable.
  Batching reconciliation amortizes the build and publication, not the per-writer seed
  copy.
- Concurrent writers can transiently require one head-sized working copy each, in
  addition to retained snapshots, read leases, a reconcile build, and envelopes.
  Reconcile also loads the lifetime `applied_tx` ledger, which is not yet checkpointed.
  Monitor free space and pending backlog.
- DirectStore holds its lease across copy, callback, checks, fsync, and publication.
  Configure a stale window longer than the worst-case operation.
  A stolen lease is fenced safely but can cause the callback to retry.
- Use `readLease()`, `seal()`, or the backup helpers for live backups.
  `seal()` acquires its own read lease for the selected snapshot.
  An arbitrary recursive directory copy racing publication or garbage collection is not
  a supported backup contract.
- Write callbacks are data transactions over a fixed schema.
  Persistent and temporary DDL, including temporary tables and triggers, and virtual
  tables are outside the `f1.0` concurrent-writer contract.
  Caller-schema migration, including admission of old writers and handling old pending
  envelopes, is post-alpha work.

The [QA runbook](https://github.com/jlevy/fsqlite/blob/main/docs/qa-runbook.md) maps
tests to guarantees.
The [roadmap](https://github.com/jlevy/fsqlite/blob/main/docs/roadmap.md) tracks the
evidence and portability work still required for 1.0. The
[schema and workload assessment](https://github.com/jlevy/fsqlite/blob/main/docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md)
gives detailed severity, measurements, and adoption guidance.

## License

MIT © 2026 Joshua Levy.
See [LICENSE](https://github.com/jlevy/fsqlite/blob/main/LICENSE).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
