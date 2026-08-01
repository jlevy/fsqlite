# fsqlite

**Filesystem-friendly concurrent SQLite.** A standalone, dependency-free package that
makes a SQLite store safe for concurrent local access with **no server**, **designed for
any filesystem** — local disk plus network/sync ones (NFS, SMB, cloud-sync folders) — by
coordinating only with atomic file operations, while the on-disk artifact stays an
ordinary SQLite file you can `zip`, copy, or open with stock `sqlite3`. (The real
cross-host NFS/SMB gate is still pending — see the [QA runbook](docs/qa-runbook.md) Part
C; today’s validation is single-host plus simulated network-filesystem semantics.)

It is the productized form of the
[portable-concurrent-SQLite research](docs/research/research-2026-06-06-portable-concurrent-sqlite.md)
and its [design and rationale](docs/fsqlite-design.md); every load-bearing claim is
pinned to upstream SQLite / `node:sqlite` source in
[`upstream-source-confirmations.md`](upstream-source-confirmations.md).

## What It Is

fsqlite is **two things, and the order matters**:

1. **A language-agnostic format and protocol** (the durable deliverable, normatively
   specified in [`docs/fsql-format-spec.md`](docs/fsql-format-spec.md)): immutable
   versioned snapshots, a tiny atomic `current` pointer, changeset transaction
   envelopes, an `applied_tx` ledger, an `fsqlite_meta` identity stamp (schema hash,
   format version), and an NFS-safe `mkdir` lease.
   Any language or tool can *read* it today (it is just SQLite); other languages can
   implement *writers* against the spec.
2. **This Node reference implementation** (`node:sqlite`, zero runtime deps) and its
   `fsqlite` CLI — the first implementation of the format and its proving ground.

The closest precedents are Apache Iceberg and Delta Lake: a table format plus a commit
protocol over immutable files, with multiple engine implementations.
fsqlite is that shape over SQLite.

## The Contract

- **Readers are unchanged** — open the published snapshot with plain SQLite, any
  language, no extension.
- **Writers adopt a thin convention** — hand fsqlite a unit of work and a per-table
  merge policy, and get **many concurrent writers and unlimited readers, server-free,
  designed for any filesystem, crash- and hot-copy-safe, at row-level optimistic
  granularity**.
- The trade is **serializable isolation and instant cross-writer visibility**: writes
  merge and become visible at `reconcile`, and every table needs a NON-NULL primary key
  (enforced at `init`).

**Two correctness invariants.** **R1 (bounded loss):** a crash, stale-lock overlap, torn
capture, or hot copy taken while live loses at most the uncommitted tail, never a
previously-published snapshot.
**R2 (no silent corruption):** every inconsistency is detectable and surfaced by
`validate`, never silently accepted.
Correctness rests on immutable snapshots, an atomic pointer swap, the per-snapshot
`applied_tx` ledger, and optimistic concurrency on `current` — **not** on the lock being
perfect.

**Durability.** The store’s commit point is snapshot **publication**: an accepted
`write()` (envelope dropped) survives process crashes but is power-loss-durable only
once a `reconcile()` publishes a snapshot containing it (the envelope files are not
fsynced; see the format spec §10). Publishing is process-crash-safe by construction
(immutable snapshots plus an atomic pointer rename).
For power-loss safety the snapshot file and the `current` pointer are `fsync`-ed, and
their containing directories are `fsync`-ed after the rename, before a publish is
considered done. In all cases a crash loses at most the uncommitted tail (R1), never a
published snapshot.

## Two Write Strategies, One Format

- **`SnapshotStore`** — the lock-free, NFS-safe **concurrent multi-writer** engine
  (envelopes and `reconcile`); writers need the session extension, readers do not.
- **`DirectStore`** — the **easy-local single-writer** strategy: synchronous copy →
  mutate → publish under the lock, no changesets or reconcile, and **no session
  extension even for the writer**, so it runs on a stock SQLite build (not only a
  session-enabled one).
  This implementation still reaches SQLite through `node:sqlite`; a fully
  binding-agnostic `DirectStore` would need a binding adapter, which is future work.
  It writes the identical on-disk format, so a store is interoperable between the two.

## Usage

```ts
import { SnapshotStore } from 'fsqlite'

const store = new SnapshotStore('/path/to/store', {
  schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY NOT NULL, v TEXT)',
  schemaVersion: 1,
  conflictPolicy: { kv: 'lww', '*': 'strict' }, // lww | union | strict; '*' default
}).init()

// Lock-free write: drops a transaction envelope, mutates nothing live.
store.write('writer-1', (db) => {
  db.prepare('INSERT INTO kv VALUES (?, ?)').run('a', '1')
})

// Out-of-band fold: builds and atomically publishes the next snapshot.
store.reconcile()

// Read the immutable published head (any binding, no extension).
const v = store.read((db) => db.prepare('SELECT v FROM kv WHERE k=?').get('a'))
```

Merge policies: `lww` (last-writer-wins), `union` (set-union / first-writer-wins),
`strict` (quarantine any conflict).
The default `'*'` is `strict` — deny-by-default, so an unrecognized table never silently
picks a winner. For a cross-row invariant on a `strict` table, `writeWithRetry` runs an
optimistic compare-and-retry loop.

## CLI

Schema-agnostic operations work on **any** fsqlite store with no app code; `stats` and
`doctor` additionally work on **any plain SQLite file**, labeling which they see:

```bash
fsqlite info      <dir>            # snapshot/pointer/pending state as JSON
fsqlite validate  <dir>            # exit 0 sealed/live, 2 in-flight, 3 corrupt
fsqlite stats     <path> [--json]  # facts about a plain SQLite file OR an fsqlite store
fsqlite gc        <dir> [--retain N]
fsqlite seal      <dir> <out.sqlite>
fsqlite repair    <dir>            # restore the last consistent point (R1)
fsqlite doctor    <path> [--json] [--fix]  # health of a plain SQLite file OR a store; --fix repairs
fsqlite fsinspect <dir> [--json]   # probe a path's filesystem for fsqlite-safety
```

`fsinspect` checks the guarantees fsqlite relies on (mkdir exclusive-create semantics,
atomic rename-replace, exclusive create, close-to-open visibility, mtime resolution)
plus a WAL negative control, and reports an `fsqlite-safe` / `wal-safe` verdict.
The probes run in one process, so they verify each operation’s contract as a heuristic,
not a cross-host race; the true concurrency proof is the multi-process test suite and a
real-NFS gate. Where WAL fails (typically network filesystems) is exactly where fsqlite
earns its keep.

## Develop

**Development runs from source** via Node’s native type-stripping (Node ≥ 22.18), with
no build step in the loop.
**Publishing builds a dist**: `tsdown` emits an ESM library (`dist/index.mjs` +
`.d.mts`) and a CLI bin (`dist/cli/index.mjs`), and the published contract is verified
end-to-end by a clean-room package smoke test.
Consumers only need the built package and a Node with **unflagged** `node:sqlite` — **≥
22.13 (LTS)** or **≥ 23.4** (no type-stripping, no build tools, no
`--experimental-sqlite`). Earlier 22.5–22.12 / 23.0–23.3 ship `node:sqlite` only behind
the flag, so they are excluded by `engines`.

```bash
npm test                       # node:test — the full engine suite (in-process + real multi-process)
npm run test:golden            # tryscript — CLI console goldens (operator surface)
npm run build                  # tsdown — ESM dist + .d.mts + CLI bin (+ publint check)
npm run test:package           # pack, clean-install the tarball, import lib + run the bin
npm run test:all               # node:test + golden + package smoke
npm run typecheck              # tsc --noEmit
npm run demo                   # engine walkthrough: concurrent writers, reconcile, seal
npm run example:catalog        # runnable document-catalog adoption example
node src/cli/index.ts --help   # run the CLI from source
```

Two test formats, by shape of the thing under test.
**`node:test`** carries the engine’s correctness and concurrency invariants —
crash/repair recovery, fencing/lease semantics, GC read-leases, optimistic retry,
NFS-safe close-to-open, portability, schema-only seeding, and the real multi-process
suites (`workers/` spawn actual child-process writers, reconcilers, and readers to prove
zero-loss under contention, exactly-once publish across racing reconcilers,
torn-read-free readers, and recovery from a hard `SIGKILL` mid-publish — including a
randomized chaos run).
**`tryscript`** (`test/cli-golden/`) golden-tests the CLI’s console output and exit
codes — the operator surface (`info`/`validate`/`stats`/`repair`/`seal`/`gc`/`doctor`)
over a store it did not create.

For the full test-to-guarantee map and the manual pre-publish review steps, see
[`docs/qa-runbook.md`](docs/qa-runbook.md).

Requires a Node with **unflagged** `node:sqlite`: **≥ 22.13** or **≥ 23.4** (the
`--experimental-sqlite` flag was removed in v22.13.0 / v23.4.0; 22.5–22.12 and 23.0–23.3
provide `node:sqlite` only behind that flag, which the published bin cannot inject for
consumers — hence the `engines` floor).
Deno exposes the same `node:sqlite` with sessions, so the writer is not Node-only; Bun
does not implement `node:sqlite` yet (only the runtimes exercised by the test suite are
claimed as supported).
