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

const row = store.read((db) =>
  db.prepare('SELECT value FROM kv WHERE key = ?').get('answer'),
)
console.log(row)
```

Every table must have a non-null primary key.
Conflict actions are `lww` (replace), `union` (keep the existing row), and `strict`
(quarantine the conflicting envelope).
The `'*'` default is `strict` when omitted.

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

## Correctness Model

- Published snapshots are immutable; `current` is the atomic commit pointer.
- A process crash loses at most the unpublished tail, never an earlier published
  snapshot.
- Changeset data and its `applied_tx` ledger entry commit in one SQLite transaction.
- Read leases prevent garbage collection of a snapshot in use.
- Maintenance fails closed on malformed identity, leases, or unsupported capabilities.
- Repair identifies a clean recovery point before deleting anything and will not race a
  publisher.

Publication fsyncs the snapshot, pointer, and containing directories.
A successfully captured envelope survives process failure but is only guaranteed
power-loss durability after reconciliation publishes it.
An optional durable-envelope mode is future work.

## Design Constraints

The full statement, with the mechanism behind each constraint and what it costs, is in
the
[design document](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#design-constraints).
In short, fsqlite is built to keep the artifact an ordinary SQLite file, run with no
server on any filesystem, lose at most the in-flight tail, surface every inconsistency
it cannot prevent, accept many concurrent writers, keep readers universal, and embed
without build steps.
It buys that by giving up serializable isolation and by trusting writers to use the
protocol.

Two constraints shape day-to-day use more than the rest:

**A write copies the current snapshot**, so per-write cost scales with store size rather
than change size (about 2.3 ms per MiB on local disk: roughly 12 ms at 2 MiB, 184 ms at
79 MiB). Copy-on-write filesystems (APFS, btrfs, XFS) reduce this to a metadata
operation automatically.
Insert-heavy writers can use `seed: 'schema-only'` to skip the copy entirely.
See
[Operating Envelope](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#operating-envelope).

**The merge is keyed on primary keys**, so other constraints you declare are enforced at
capture but can be broken by merging two individually-valid writes.
`UNIQUE` collisions drop the incoming row; foreign keys hold within one write but not
across concurrent ones.
Every such case is reported rather than silent: `reconcile()` returns `dropped` and
`foreignKeyViolations`, and `validate()` reports a `constraints` axis alongside the
structural state. See
[What the Merge Preserves](https://github.com/jlevy/fsqlite/blob/main/docs/fsqlite-design.md#what-the-merge-preserves).

## Limitations

- The format and API are alpha and may change.
- POSIX filesystems are the supported target for this alpha; Windows publication races
  are not yet validated.
- Cross-host NFS/SMB behavior is designed into the protocol but not yet proven by the
  real multi-host gate.
  Do not treat the alpha as that proof.
- Reconciliation serializes publication, and visibility across writers occurs when
  reconciliation completes rather than immediately after envelope capture.
- Row-level policies do not by themselves protect arbitrary range, aggregate, or
  cross-row invariants.
  Use `strict` with retry for supported point-row invariants, or a single-writer
  strategy.
- Per-write cost grows with store size, because a write seeds from a copy of the current
  snapshot. Budget for it, or use a copy-on-write filesystem or `seed: 'schema-only'`.
- `UNIQUE` constraints other than the primary key are not preserved by the merge, and
  foreign keys are preserved within one write but not across concurrent writes.
  Both are reported, never silently accepted.

The [QA runbook](https://github.com/jlevy/fsqlite/blob/main/docs/qa-runbook.md) maps
tests to guarantees.
The [roadmap](https://github.com/jlevy/fsqlite/blob/main/docs/roadmap.md) tracks the
evidence and portability work still required for 1.0.

## License

MIT © 2026 Joshua Levy.
See [LICENSE](https://github.com/jlevy/fsqlite/blob/main/LICENSE).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
