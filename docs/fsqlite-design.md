# fsqlite Design and Rationale

Status: current design of the implementation in this repository.
Companions: the normative on-disk format and protocol live in
[`fsql-format-spec.md`](fsql-format-spec.md); the background, prior art, and validation
experiments live in the
[portable-concurrent-SQLite research](research/research-2026-06-06-portable-concurrent-sqlite.md);
the test-to-guarantee map lives in the [QA runbook](qa-runbook.md).

## The Problem

SQLite’s own concurrency machinery assumes one local disk: WAL mode needs a
shared-memory `-shm` file (the SQLite project states WAL “is not supported on a network
filesystem”), and the fallback POSIX byte-range locks are notoriously unreliable there.
Consequently, a live SQLite file shared over NFS/SMB or a cloud-sync folder can corrupt
or fail to lock. These environments include shared cloud workspaces, network drives, and
synced directories. Existing “distributed SQLite” projects use a different architecture:
they centralize the writer behind a server or coordinator (LiteFS, rqlite/dqlite) or
replace SQLite’s storage layer (mvSQLite).
No surveyed option provides server-free, multi-writer access across these filesystems
while keeping the artifact a plain SQLite file.
See research Findings B through E.

## What fsqlite Is

fsqlite combines a format with its first implementation:

1. **A language-independent format and coordination protocol** (the durable deliverable,
   normatively specified in [`fsql-format-spec.md`](fsql-format-spec.md)): immutable
   versioned snapshots, a visible `fsqlite.json` identity marker, a tiny atomic
   `current` pointer, changeset transaction envelopes, an `applied_tx` ledger, an
   `fsqlite_meta` identity stamp, and an NFS-safe `mkdir` lease.
   Any language or tool can *read* it today because snapshots are SQLite files.
   Other languages can implement *writers* against the specification.
2. **A Node reference implementation** (`node:sqlite`, zero runtime dependencies) and
   its `fsqlite` CLI, which implement and exercise the format.

The closest precedents are Apache Iceberg and Delta Lake: a table format plus a commit
protocol over immutable files, with multiple engine implementations.
fsqlite is that shape over SQLite.

## The Contract

**Readers are unchanged:** they open the published snapshot with plain SQLite in any
language and need no extension.
**Writers adopt a thin convention:** they give fsqlite a unit of work and a per-table
merge policy.
In return, fsqlite coordinates many writers and unlimited readers without a
server, using row-level optimistic conflict handling and filesystem-safe publication.
The trade is serializable isolation and instant cross-writer visibility: writes merge
and become visible at `reconcile`, and every caller table needs a NON-NULL primary key
(enforced at `init`).

Two correctness invariants govern everything.
**R1 (bounded loss):** a crash, stale-lock overlap, torn capture, or copy taken while
the store is live loses at most the unpublished tail, never a previously published
snapshot. **R2 (no silent corruption):** every inconsistency is detectable and surfaced
by `validate`, never silently accepted.

## The Mechanism

- **Writers are lock-free**: each drops a uniquely-named SQLite changeset envelope,
  seeded from the current immutable snapshot.
  Unique paths mean conflict-free on local disk *and* NFS.
- **Published heads are immutable** versioned snapshots, selected by a tiny atomic
  `current` pointer. An out-of-band `reconcile()` folds committed envelopes into the next
  snapshot and publishes it atomically.
- **The store root identifies itself** with `fsqlite.json`, carrying
  `format: "fsqlite"`, `format_version: "f1.0"`, required features, and a UUID
  `store_id`. The same version and identity are stamped into snapshots and envelopes so
  mixed-store contents fail validation.
- **Readers open only an immutable snapshot**: any SQLite binding, any language, no
  session extension.
- **The one mutual-exclusion point** is an NFS-safe `mkdir` lease held only for the
  short publish, backed by an idempotent ledger so correctness never depends on the lock
  being perfect.

**Why it is correct without a perfect lock:** immutable heads, an atomic pointer swap, a
per-snapshot `applied_tx` ledger (exactly-once), and optimistic concurrency on `current`
(overlapping reconcilers build separate temp files) mean a stale-lock break or a process
killed mid-publish cannot corrupt or double-apply.
The `mkdir` lease reduces redundant work but does not carry correctness.
See research Finding H and format spec §§6-7 for the complete argument and normative
steps.

## Concurrency Guarantees, Precisely

Research Finding K gives the full statement and comparison with WAL.

- **Reads:** unlimited, lock-free, never blocked, snapshot-isolated at published-version
  granularity.
- **Writes:** the *capture* (envelope) phase is unlimited and lock-free: there is no
  global write lock on the application path.
  Only the brief, out-of-band `reconcile` merge is serialized (lease and OCC), and it
  serializes *producing a new snapshot*, not *accepting independent writes*.
- **Conflict granularity is per-row (per primary key)**, not whole-DB or per-table:
  writers touching different rows, even in the same table, never conflict; only a
  same-PK clash is resolved by that table’s policy (`lww`/`union`/`strict`).
- **Caller-declared constraints remain publication invariants:** DATA and
  same-primary-key CONFLICT cases use the table policy.
  NOTFOUND, CONSTRAINT, and FOREIGN_KEY cases quarantine the whole envelope.
  Reconcile checks foreign keys after each envelope and before its ledger entry, then
  checks them again before publication and during validation.
  Filtered policy passes always run in `replace`, `omit`, `strict` order, with
  foreign-key enforcement deferred until the complete envelope has landed.
- **Isolation is deliberately weaker than WAL:** row-level write-set merge and
  read-your-own-writes within a session, not serializable (no read-set tracking), and a
  committed write is visible to readers only after reconcile.

Versus WAL (many readers and one global *serializable* writer, local-disk-only), fsqlite
trades serializability for many concurrent row-granular writers, network filesystems,
and hot-copy safety.
For a cross-row invariant on a `strict` table, `writeWithRetry` provides a
per-transaction optimistic compare-and-retry loop (re-seed from the new snapshot, re-run
the work) that prevents lost updates without a lock.

## Two Write Strategies, One Format

- **`SnapshotStore`**: the lock-free, NFS-safe concurrent multi-writer engine (envelopes
  and `reconcile`); writers need the session extension, readers do not.
- **`DirectStore`**: the local single-writer strategy: synchronous copy → mutate →
  publish under the lock, no changesets or reconcile, and no session extension even for
  the writer.

**Why DirectStore exists** (it is a deliberate second lane, not a leftover):

1. **It removes the session-extension requirement for writers.** `SnapshotStore` writers
   need `SQLITE_ENABLE_SESSION`, which most SQLite bindings do not ship
   (`better-sqlite3` does not compile it; Bun has no `node:sqlite`; many non-Node
   bindings lack it). The DirectStore strategy writes with *any* SQLite build, so it is a
   portable writer strategy and a path to non-Node writers against the same format
   without waiting for session support.
2. **Simpler, stronger semantics when there is one writer.** Full serializable
   isolation, no merge policy to design, no quarantines, no write-skew caveats, and a
   write is visible to readers the moment it returns (no reconcile step, no visibility
   lag).
3. **The write is the durability point.** DirectStore publishes synchronously, so a
   returned write is power-loss durable.
   `SnapshotStore` writes become durable at the next reconcile (format spec §10).
4. **Zero-migration graduation.** Start single-writer with DirectStore, then adopt
   `SnapshotStore` when concurrent writers arrive without changing the store, readers,
   or tools. The two can operate concurrently because DirectStore checks `current`
   optimistically under the same lock.

The cost is global write serialization (the lock is held across copy → mutate →
publish), which is exactly right for a single writer and wrong for many.

`SnapshotStore` has a different large-store cost: its default writer seeds a private
working database by copying the current snapshot.
A reviewer-local benchmark with 2 KB rows measured 11.8 ms per write at 2.0 MiB and
183.6 ms at 78.8 MiB, a slope near 2.3 ms per MiB. A linear 1 GiB extrapolation is
roughly 2.4 seconds for a single-row write.
These measurements are hardware-specific sizing evidence, not a portability or
performance guarantee.
Measure the target workload before adopting `SnapshotStore` for a large catalog.
`seed: 'schema-only'` avoids the snapshot copy but is valid only for inserts of new
keys. Writer-seeding optimization, compaction, and safe shared read-only base or overlay
designs remain post-alpha work in
[`fsq-fp06`](project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md).

Use `SnapshotStore` for multiple writers or network filesystems.
Use `DirectStore` only for a local store with one writer.
Never select DirectStore automatically from filesystem detection because unsafe cases
can look local. The two strategies interoperate because they share the on-disk format.

## Design Refinements Carried from the Research

- **Thread safety.** The bindings build `SQLITE_THREADSAFE=2`, so a connection is never
  shared across worker threads (one connection per thread).
  The reference implementation opens fresh connections for operations and has no
  process-local mutex.
  Worker Thread coordination beyond that connection boundary is deferred to
  [`fsq-5nx4`](project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md).
  The cross-process `mkdir` lease protects *processes*. (Research, Finding G2.)
- **Backup is a contract.** Expose `backup()` / `vacuumInto()` / `seal()`; never
  document “copy the live file and hope.”
  Safe paths include `sqlite3_rsync` (SQLite 3.47.0+). Every backup helper runs
  `PRAGMA integrity_check` in tests.
  (Research, Finding C.)
- **A declared read set (`commitIf`) is the future escape hatch** alongside
  `writeWithRetry`: letting a caller declare point-key reads revalidated at merge would
  close write skew for fully declared point-key invariants only.
  It cannot close phantom or predicate reads; aggregate and range invariants need a
  version-stamped guard row or the `DirectStore` lane.
  (Research, Finding K.)
- **Capability detection over assumption.** `driver.capabilities()` probes session
  support by actually recording a changeset; a `SnapshotStore` write fails loudly on a
  session-less runtime rather than degrading silently.
  (Research, Finding G2.)
- **Runtime posture.** Deno hosts the session writer (same `node:sqlite` with sessions);
  Bun does not implement `node:sqlite` yet, so it cannot host the writer today.
  Readers work everywhere regardless.
- **Auditable lock ownership.** `publish.lock/owner.json` records the owner token and
  process facts, making stale-breaks auditable; correctness still rests on the ledger
  and OCC-on-`current`, not on the lock.

## Public API Shape

```ts
import { SnapshotStore } from 'fsqlite'

const store = new SnapshotStore(dir, {
  schema: SCHEMA_SQL, // caller DDL applied to snapshot 0 (every table NON-NULL PK)
  schemaVersion: 1,
  conflictPolicy: {
    // per-table merge semantics
    url_index: 'lww', // last-writer-wins
    relationships: 'union', // set-union
    '*': 'strict', // deny-by-default: quarantine a conflicting envelope
  },
}).init()

const txId = store.write('writer-a', (db) => {
  /* INSERT/UPDATE/DELETE */
})
const rows = store.read((db) => db.prepare('SELECT …').all())
const res = store.reconcile() // build, integrity gates, and atomic publication; exactly once
store.writeWithRetry('writer-a', (db) => {
  /* read-modify-write on strict rows */
})
const lease = store.readLease() // pin current against gc; lease.release() after
store.gc({ retain: 3 })
store.validate()
store.repair()
store.seal('out.sqlite')

// Local single-writer alternative over the same format:
const v = new DirectStore(dir, opts).write((db) => {
  /* write through plain SQLite */
})
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/lock` | NFS-safe `mkdir` lease with an owner token for revalidate-before-publish; invariant `timeoutMs > staleMs` |
| `src/storeFormat` | Root marker creation and validation; format/store identity and required-feature gating |
| `src/driver` | Thin `node:sqlite` wrapper: the session/changeset chokepoint; capability probing |
| `src/conflictPolicy` | Per-table policy via one filtered apply pass per action; conflict-type-aware `replace`; `strict` detected via the ABORT pass |
| `src/snapshotStore` | The concurrent engine: `init/read/write/writeWithRetry/reconcile/gc/validate/repair/seal/readLease` |
| `src/directStore` | The local single-writer strategy over the same format |
| `src/cli` | The reference CLI: schema-agnostic operations over any store or plain SQLite file |

## The CLI Is a First-Class Deliverable

A reference implementation needs a reference CLI so the format is operable by hand and
from scripts. Every subcommand is schema-agnostic (it works on the
snapshot/pointer/envelope/lease layer), so an operator can maintain a store they did not
create: `info`, `validate`, `gc`, `seal`, `repair`, plus `stats` and `doctor`, which
span **any SQLite path** (an fsqlite store directory or a plain SQLite file), label
which form they see, and `fsinspect`, which empirically probes a filesystem for the
guarantees fsqlite relies on (atomic `mkdir`, rename-replace, close-to-open visibility,
a WAL negative control).

## Cross-Platform Posture

Writers never use SQLite file locking or WAL `-shm`, the mechanisms that fail on network
filesystems. They use atomic directory creation and snapshot copies.
The publish lock uses `mkdir`; `reconcile` builds without WAL; `validate` flags a live
`-wal` or `-shm` file next to a snapshot.
Windows needs rename-replace semantics (`MOVEFILE_REPLACE_EXISTING`); see format spec
§14, Open Issue O1.

## Format Identity and Evolution

Directory recognition is explicit: only a valid root `fsqlite.json` identifies a store.
Generic names such as `current` and `snapshots/` never do.
Snapshot files also carry the fixed SQLite `application_id` `0x4653514C` (`FSQL`), while
`PRAGMA user_version` and `schema_hash` remain caller-owned schema metadata.

The format version is a self-identifying string, `f<major>.<minor>`, beginning with
`f1.0`. Major revisions are incompatible.
Minor revisions are additive but are accepted by an older implementation only when
compatibility is explicit; unknown mandatory capabilities in `required_features` always
block operation. Unsupported stores are not corrupt and must never be repaired by an
implementation that cannot read them.

Opening a store never migrates it.
Future whole-format upgrades are explicit and side-by-side by default: validate and pin
the source, build a new destination while preserving `store_id`, validate it completely,
leave the source untouched, and let the operator cut over.
Caller schema migrations are a separate concern.

## A Worked Consumer

[`document-catalog.ts`](../packages/fsqlite/examples/document-catalog.ts) is the
concrete shape of a realistic adopter: a catalog of documents, content-addressed blobs,
a URL index, and typed relationships that many agents can update concurrently.
The consumer supplies only its schema and merge policy.
[`adoption.test.ts`](../packages/fsqlite/test/adoption.test.ts) runs the same schema and
policy through the engine (last-writer-wins refetch, deduplicated union edge,
strict-default quarantine), keeping the example’s schema and policy aligned with the
tests.

## Validation and Known Gaps

The [QA runbook](qa-runbook.md) maps tests to guarantees and defines the manual
pre-publish review. The format specification lists remaining format questions in §14.
Real cross-host NFS/SMB validation is still pending; current validation uses one host
plus simulated network-filesystem semantics.
The store’s commit point is publication, so an accepted `write()` is not power-loss
durable until a reconcile publishes it (format spec §10). The
[post-alpha roadmap](project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md)
maps all deferred validation and evolution work.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
