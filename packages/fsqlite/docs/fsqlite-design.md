# fsqlite Design and Rationale

Status: current design of the shipped package.
Companions: the normative on-disk format and protocol live in
[`fsql-format-spec.md`](fsql-format-spec.md); the background, prior art, and validation
experiments live in the
[portable-concurrent-SQLite research](research/research-2026-06-06-portable-concurrent-sqlite.md);
the test-to-guarantee map lives in the [QA runbook](qa-runbook.md).

## The Problem

SQLite’s own concurrency machinery assumes one local disk: WAL mode needs a
shared-memory `-shm` file (the SQLite project states WAL “is not supported on a network
filesystem”), and the fallback POSIX byte-range locks are notoriously unreliable there.
So a live SQLite file shared over NFS/SMB or a cloud-sync folder silently corrupts or
fails to lock — exactly where agents increasingly run (cloud agent workspaces, shared
network drives, synced directories).
The serious “distributed SQLite” projects sidestep this rather than fix it: they
centralize the writer behind a server or coordinator (LiteFS, rqlite/dqlite) or replace
SQLite’s storage layer (mvSQLite).
Nothing offers server-free, any-filesystem, multi-writer access that keeps the artifact
a plain SQLite file.
(Full analysis: research, Findings B–E.)

## What fsqlite Is

fsqlite is **two things, and the order matters**:

1. **A language-agnostic format and coordination protocol** (the durable deliverable,
   normatively specified in [`fsql-format-spec.md`](fsql-format-spec.md)): immutable
   versioned snapshots, a tiny atomic `current` pointer, changeset transaction
   envelopes, an `applied_tx` ledger, an `fsqlite_meta` identity stamp, and an NFS-safe
   `mkdir` lease. Any language or tool can *read* it today (it is just SQLite); other
   languages can implement *writers* against the spec.
2. **A Node reference implementation** (`node:sqlite`, zero runtime dependencies) and
   its `fsqlite` CLI — the first implementation of the format and its proving ground.

The closest precedents are Apache Iceberg and Delta Lake: a table format plus a commit
protocol over immutable files, with multiple engine implementations.
fsqlite is that shape over SQLite.

## The Contract

**Readers are unchanged** — open the published snapshot with plain SQLite, any language,
no extension. **Writers adopt a thin convention** — hand fsqlite a unit of work and a
per-table merge policy — and get many concurrent writers and unlimited readers,
server-free, designed for any filesystem, crash- and hot-copy-safe, at row-level
optimistic granularity.
The trade is serializable isolation and instant cross-writer visibility: writes merge
and become visible at `reconcile`, and every table needs a NON-NULL primary key
(enforced at `init`).

Two correctness invariants govern everything.
**R1 (bounded loss):** a crash, stale-lock overlap, torn capture, or hot copy taken
while live loses at most the unpublished tail, never a previously published snapshot.
**R2 (no silent corruption):** every inconsistency is detectable and surfaced by
`validate`, never silently accepted.

## The Mechanism

- **Writers are lock-free** — each drops a uniquely-named SQLite changeset envelope,
  seeded from the current immutable snapshot.
  Unique paths mean conflict-free on local disk *and* NFS.
- **Published heads are immutable** versioned snapshots, selected by a tiny atomic
  `current` pointer. An out-of-band `reconcile()` folds committed envelopes into the next
  snapshot and publishes it atomically.
- **Readers open only an immutable snapshot** — any SQLite binding, any language, no
  session extension.
- **The one mutual-exclusion point** is an NFS-safe `mkdir` lease held only for the
  short publish, backed by an idempotent ledger so correctness never depends on the lock
  being perfect.

**Why it is correct without a perfect lock:** immutable heads, an atomic pointer swap, a
per-snapshot `applied_tx` ledger (exactly-once), and optimistic concurrency on `current`
(overlapping reconcilers build separate temp files) mean a stale-lock break or a process
killed mid-publish cannot corrupt or double-apply.
The `mkdir` lease is belt-and-suspenders.
(Full argument: research, Findings H; normative steps: format spec §6–§7.)

## Concurrency Guarantees, Precisely

(Full statement and a fair WAL comparison: research, Finding K.)

- **Reads:** unlimited, lock-free, never blocked, snapshot-isolated at published-version
  granularity.
- **Writes:** the *capture* (envelope) phase is unlimited and lock-free — there is no
  global write lock on the application path.
  Only the brief, out-of-band `reconcile` merge is serialized (lease and OCC), and it
  serializes *producing a new snapshot*, not *accepting independent writes*.
- **Conflict granularity is per-row (per primary key)**, not whole-DB or per-table:
  writers touching different rows — even in the same table — never conflict; only a
  same-PK clash is resolved by that table’s policy (`lww`/`union`/`strict`).
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

- **`SnapshotStore`** — the lock-free, NFS-safe concurrent multi-writer engine
  (envelopes and `reconcile`); writers need the session extension, readers do not.
- **`DirectStore`** — the easy-local single-writer strategy: synchronous copy → mutate →
  publish under the lock, no changesets or reconcile, and no session extension even for
  the writer.

**Why DirectStore exists** (it is a deliberate second lane, not a leftover):

1. **It removes the session-extension requirement for writers.** `SnapshotStore` writers
   need `SQLITE_ENABLE_SESSION`, which most SQLite bindings do not ship
   (`better-sqlite3` does not compile it; Bun has no `node:sqlite`; many non-Node
   bindings lack it). The DirectStore strategy writes with *any* SQLite build, so it is
   the portability lane for writers — and the path to non-Node writers against the same
   format without waiting for session support.
2. **Strictly simpler, stronger semantics when there is one writer.** Full serializable
   isolation, no merge policy to design, no quarantines, no write-skew caveats — and a
   write is visible to readers the moment it returns (no reconcile step, no visibility
   lag).
3. **The write is the durability point.** DirectStore publishes synchronously, so a
   returned write is power-loss durable — `SnapshotStore` writes are durable only at the
   next reconcile (format spec §10).
4. **Zero-migration graduation.** Start single-writer with DirectStore; adopt
   `SnapshotStore` when concurrent writers arrive — same store, same readers, same
   tools. The two even compose live (DirectStore does OCC on `current` under the same
   lock).

The cost is global write serialization (the lock is held across copy → mutate →
publish), which is exactly right for a single writer and wrong for many.

Default to `SnapshotStore` (the always-on safe floor for many writers or network
filesystems).
Offer `DirectStore` as an **opt-in** for provably-single-writer local use —
never auto-selected from filesystem detection (detection is unreliable; the dangerous
cases look local). The two interoperate on one store because they share the on-disk
format.

## Design Refinements Carried from the Research

- **Thread safety.** The bindings build `SQLITE_THREADSAFE=2`, so a connection is never
  shared across worker threads (one connection per thread).
  The cross-process `mkdir` lease protects *processes*. (Research, Finding G2.)
- **Backup is a contract.** Expose `backup()` / `vacuumInto()` / `seal()`; never
  document “copy the live file and hope.”
  Safe paths include `sqlite3_rsync` (SQLite 3.47.0+). Every backup helper runs
  `PRAGMA integrity_check` in tests.
  (Research, Finding C.)
- **A declared read set (`commitIf`) is the future escape hatch** alongside
  `writeWithRetry`: letting a caller declare point-key reads revalidated at merge would
  soundly close write skew for fully-declared invariants only — not phantom or predicate
  reads; aggregate and range invariants need a version-stamped guard row or the
  `DirectStore` lane. (Research, Finding K.)
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
  schema: SCHEMA_SQL,          // caller DDL applied to snapshot 0 (every table NON-NULL PK)
  schemaVersion: 1,
  appId: 0x43544c47,           // PRAGMA application_id (caller-chosen store magic)
  conflictPolicy: {            // per-table merge semantics
    url_index: 'lww',          //   last-writer-wins
    relationships: 'union',    //   set-union
    '*': 'strict',             //   deny-by-default: conflict ⇒ quarantine the envelope
  },
}).init()

const txId  = store.write('writer-a', (db) => { /* INSERT/UPDATE/DELETE */ })
const rows  = store.read((db) => db.prepare('SELECT …').all())
const res   = store.reconcile()          // build → quick_check → atomic publish; exactly-once
store.writeWithRetry('writer-a', (db) => { /* read-modify-write on strict rows */ })
const lease = store.readLease()          // pin current against gc; lease.release() after
store.gc({ retain: 3 }); store.validate(); store.repair(); store.seal('out.sqlite')

// Easy-local alternative over the same format:
const v = new DirectStore(dir, opts).write((db) => { /* … */ })
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/lock` | NFS-safe `mkdir` lease with an owner token for revalidate-before-publish; invariant `timeoutMs > staleMs` |
| `src/driver` | Thin `node:sqlite` wrapper — the session/changeset chokepoint; capability probing |
| `src/conflictPolicy` | Per-table policy via one filtered apply pass per action; conflict-type-aware `replace`; `strict` detected via the ABORT pass |
| `src/snapshotStore` | The concurrent engine: `init/read/write/writeWithRetry/reconcile/gc/validate/repair/seal/readLease` |
| `src/directStore` | The easy-local single-writer strategy over the same format |
| `src/cli` | The reference CLI: schema-agnostic operations over any store or plain SQLite file |

## The CLI Is a First-Class Deliverable

A reference implementation needs a reference CLI so the format is operable by hand and
from scripts. Every subcommand is schema-agnostic (it works on the
snapshot/pointer/envelope/lease layer), so an operator can maintain a store they did not
create: `info`, `validate`, `gc`, `seal`, `repair`, plus `stats` and `doctor`, which
span **any SQLite path** — an fsqlite store directory or a plain SQLite file — labeling
which they see, and `fsinspect`, which empirically probes a filesystem for the
guarantees fsqlite relies on (atomic `mkdir`, rename-replace, close-to-open visibility,
a WAL negative control).

## Cross-Platform Posture

By construction, writers never use SQLite file locking or WAL `-shm` (the parts that
break on network filesystems) — only atomic dir-create and snapshot copies; the publish
lock is `mkdir` (atomic on NFS); `reconcile` builds without WAL; and `validate` flags a
live `-wal`/`-shm` next to snapshots (the cloud-sync hazard).
Windows needs rename-replace semantics (`MOVEFILE_REPLACE_EXISTING`); see format spec
§14, Open Issue O2.

## A Worked Consumer

[`examples/document-catalog.ts`](../examples/document-catalog.ts) is the concrete shape
of a realistic adopter: a catalog of documents, content-addressed blobs, a URL index,
and typed relationships, written by many agents at once — the consumer supplies only its
schema and merge policy.
[`test/adoption.test.ts`](../test/adoption.test.ts) runs the same schema and policy
through the engine (last-writer-wins refetch, deduplicated union edge, strict-default
quarantine), so the example can never drift.

## Validation Posture and Known Gaps

The full test-to-guarantee map and the manual pre-publish review live in the
[QA runbook](qa-runbook.md); the open format questions live in the format spec’s §14.
The two most important honesty points: the real cross-host NFS/SMB gate is still pending
(today’s validation is single-host plus simulated network-filesystem semantics), and the
store’s commit point is publication — an accepted `write()` is not power-loss durable
until a reconcile publishes it (format spec §10).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
